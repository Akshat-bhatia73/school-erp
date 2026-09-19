import { betterAuth } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { phoneNumber, twoFactor } from 'better-auth/plugins'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool } from 'pg'
import { userHasStudentMembership } from '@erp/db'
import {
  authAccounts,
  authRateLimit,
  authSessions,
  authTwoFactor,
  authUsers,
  authVerifications,
} from '@erp/db/schema'
import type { ApiConfig } from '../config.ts'
import type { DeliveryAdapter } from '../delivery/index.ts'
import { CLIENT_IP_HEADER } from '../app.ts'
import {
  MFA_ENROLMENT_PATHS,
  MFA_VERIFY_PATHS,
  clearUserMfaVerification,
  stampSessionMfaVerified,
} from './mfa.ts'
import {
  clearFailedSignIns,
  identityIsBlocked,
  invalidCredentialsError,
  invalidOtpError,
  recordFailedSignIn,
} from './lockout.ts'
import {
  GENERIC_SEND_RESPONSE,
  OTP_ALLOWED_ATTEMPTS,
  OTP_EXPIRY_SECONDS,
  OTP_LENGTH,
  normalizeIndianPhone,
} from './phone-otp.ts'

/** A generated identifier for a phone-only adult: never a real mailbox. */
const PLACEHOLDER_EMAIL_SUFFIX = '.invalid'

export type AuthInstance = ReturnType<typeof createAuth>

/**
 * The only Better Auth instance. It connects as erp_auth, which can read and
 * write identity tables and nothing else: memberships and roles are resolved
 * separately after the session is verified.
 */
export function createAuth(
  config: ApiConfig,
  authPool: Pool,
  delivery: DeliveryAdapter,
  /** Identity connection used only to refuse student sign-in. */
  identityPool?: Pool,
) {
  const db = drizzle(authPool)
  return betterAuth({
    appName: 'school-erp',
    secret: config.AUTH_SECRET,
    baseURL: config.APP_ORIGIN,
    basePath: '/api/auth',
    trustedOrigins: [config.APP_ORIGIN],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
        twoFactor: authTwoFactor,
        rateLimit: authRateLimit,
      },
    }),
    advanced: {
      database: { generateId: 'uuid' },
      // Only the API sets this header; see CLIENT_IP_HEADER in app.ts.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      useSecureCookies: config.NODE_ENV === 'production',
      // Host-only cookie: no Domain attribute, one browser origin only.
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      },
    },
    databaseHooks: {
      session: {
        create: {
          // A student identity must never obtain a session, whichever login
          // method was used. The check happens before the row is written.
          before: async (session) => {
            if (!identityPool) return
            const userId = String(session.userId)
            if (await userHasStudentMembership(identityPool, userId))
              return false
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      // There is no public signup. Identities arrive through invitations.
      disableSignUp: true,
      requireEmailVerification: false,
      revokeSessionsOnPasswordReset: true,
      // A reset link is a credential. Keep its life short and single use.
      resetPasswordTokenExpiresIn: 900,
      sendResetPassword: async ({ user, token }) => {
        // A phone-only identity has a generated address that nobody can read.
        // Sending there would leak a reset token into an unowned mailbox.
        if (user.email.endsWith(PLACEHOLDER_EMAIL_SUFFIX)) return
        await delivery.send({
          channel: 'email',
          to: user.email,
          purpose: 'password_reset',
          secret: token,
        })
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, token }) => {
        await delivery.send({
          channel: 'email',
          to: user.email,
          purpose: 'verification',
          secret: token,
        })
      },
    },
    session: {
      // Revocation must take effect on the next request, so no cookie cache.
      cookieCache: { enabled: false },
      // The longest life any policy allows. The API applies the shorter
      // role-derived limits on top, including on the provider routes, so a
      // cookie can never outlive its policy even on an untouched path.
      expiresIn: 7 * 24 * 3600,
      additionalFields: {
        sharedDevice: {
          type: 'boolean',
          required: false,
          input: false,
        },
        mfaVerifiedAt: {
          // The drizzle adapter resolves fields by schema property name.
          type: 'date',
          required: false,
          input: false,
        },
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      modelName: 'rateLimit',
    },
    hooks: {
      /**
       * Only a known adult identity with a verified number is ever sent a
       * code. An unknown or ineligible number is answered with the same body
       * and no message, so the endpoint cannot be used to discover who has an
       * account. The Fastify layer has already normalised the number and taken
       * the cooldown, so the decision here is eligibility only.
       */
      before: createAuthMiddleware(async (ctx) => {
        // A locked or disabled identity never reaches the provider, and is
        // answered with the provider's own refusal for this door.
        if (ctx.path === '/sign-in/email') {
          const email = (ctx.body as { email?: unknown } | undefined)?.email
          if (
            typeof email === 'string' &&
            (await identityIsBlocked(authPool, { email }))
          )
            throw invalidCredentialsError()
          return
        }
        if (ctx.path === '/phone-number/verify') {
          const phone = normalizeIndianPhone(
            (ctx.body as { phoneNumber?: unknown } | undefined)?.phoneNumber,
          )
          if (phone && (await identityIsBlocked(authPool, { phone })))
            throw invalidOtpError()
          return
        }
        if (ctx.path !== '/phone-number/send-otp') return
        const body = ctx.body as { phoneNumber?: unknown } | undefined
        const phone = normalizeIndianPhone(body?.phoneNumber)
        if (!phone) return GENERIC_SEND_RESPONSE
        const user = (await ctx.context.adapter.findOne({
          model: 'user',
          where: [{ field: 'phoneNumber', value: phone }],
        })) as { id?: string; phoneNumberVerified?: boolean } | null
        if (!user?.id || user.phoneNumberVerified !== true)
          return GENERIC_SEND_RESPONSE
        if (identityPool && (await userHasStudentMembership(identityPool, user.id)))
          return GENERIC_SEND_RESPONSE
        return
      }),
      /**
       * The provider proved the second factor; record it against the session
       * this request ends up holding. A first enrolment and a sign-in
       * challenge both create a brand new session, so prefer that one; a
       * step-up on an existing session keeps its own token.
       */
      after: createAuthMiddleware(async (ctx) => {
        const returned = (ctx.context as { returned?: unknown }).returned
        if (ctx.path === '/sign-in/email') {
          const email = (ctx.body as { email?: unknown } | undefined)?.email
          if (typeof email !== 'string' || email.length === 0) return
          if (returned instanceof Error) await recordFailedSignIn(authPool, email)
          else await clearFailedSignIns(authPool, email)
          return
        }
        if (returned instanceof Error) return
        if (MFA_ENROLMENT_PATHS.includes(ctx.path)) {
          // The authenticator changed, so no earlier proof of it stands.
          const userId = ctx.context.session?.user.id
          if (typeof userId === 'string' && userId.length > 0)
            await clearUserMfaVerification(authPool, userId)
          return
        }
        if (!MFA_VERIFY_PATHS.includes(ctx.path)) return
        const token =
          ctx.context.newSession?.session.token ??
          (typeof returned === 'object' && returned !== null
            ? (returned as { token?: unknown }).token
            : undefined)
        if (typeof token !== 'string' || token.length === 0) return
        await stampSessionMfaVerified(authPool, token)
      }),
    },
    plugins: [
      twoFactor({
        issuer: 'School ERP',
        // Enrolment is only complete once a code from the authenticator app
        // has been accepted, so a half-set-up device cannot lock anyone out.
        skipVerificationOnEnable: false,
        totpOptions: { digits: 6, period: 30 },
        // No otpOptions.sendOTP: the second factor is an authenticator app or
        // a backup code. An SMS code is a login factor here, not a second one.
      }),
      phoneNumber({
        // No signUpOnVerification: an unknown number can never create an identity.
        otpLength: OTP_LENGTH,
        expiresIn: OTP_EXPIRY_SECONDS,
        allowedAttempts: OTP_ALLOWED_ATTEMPTS,
        requireVerification: true,
        sendOTP: async ({ phoneNumber: to, code }) => {
          await delivery.send({
            channel: 'sms',
            to,
            purpose: 'otp',
            secret: code,
          })
        },
        sendPasswordResetOTP: async ({ phoneNumber: to, code }) => {
          await delivery.send({
            channel: 'sms',
            to,
            purpose: 'password_reset',
            secret: code,
          })
        },
      }),
    ],
  })
}
