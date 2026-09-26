import Fastify, { type FastifyInstance } from 'fastify'
import { ApiFailure, apiError } from './http/errors.ts'
import type { ApiConfig } from './config.ts'
import type { AuthInstance } from './auth/better-auth.ts'
import type { DeliveryAdapter } from './delivery/index.ts'
import type { ApiPools } from './db.ts'
import type { DocumentStorage } from './files/storage.ts'
import { AuthorizationError, createAuthorizationService } from '@erp/authz'
import { isAllowedAuthRoute } from './auth/provider-routes.ts'
import { registerIdentityRoutes } from './routes/identity.ts'
import { registerStudentSignInRoute } from './auth/student-sign-in.ts'
import { registerDevRoutes, registerHeldSmsRoute } from './routes/dev.ts'
import { reportDenial, reportError } from './observability.ts'
import { registerAccessLog } from './http/access-log.ts'
import { requestIdFor } from './http/request-ids.ts'
import {
  GENERIC_SEND_RESPONSE,
  consumeSendAllowance,
  normalizeIndianPhone,
} from './auth/phone-otp.ts'
import {
  stripTrustDeviceCookies,
  stripTrustDeviceFlag,
} from './auth/mfa.ts'
import { isFreshMfa } from './auth/assurance.ts'
import { enforceSessionPolicy, resolveSession } from './auth/session.ts'
import { registerSessionRoutes } from './routes/sessions.ts'
import { registerMembershipRoutes } from './memberships/routes.ts'
import { registerInvitationRoutes } from './invitations/routes.ts'
import { registerModuleRoutes } from './modules/index.ts'
import { registerMaintenanceRoutes } from './maintenance/routes.ts'
import { registerMessageMaintenanceRoutes } from './maintenance/messages.ts'
import { registerAssistantRoutes, type AssistantDependencies } from './assistant/routes.ts'
import {
  MFA_ATTEMPT_LIMIT,
  MFA_ATTEMPT_WINDOW_SECONDS,
  markSharedDevice,
  mfaAttemptKey,
} from './auth/mfa.ts'
import { clearBucket, failureCount, recordFailure } from './auth/throttle.ts'
import type { ErrorCode } from '@erp/contracts'

const SEND_OTP_ROUTE = 'phone-number/send-otp'
const VERIFY_OTP_ROUTE = 'phone-number/verify'
const DISABLE_MFA_ROUTE = 'two-factor/disable'
const CHANGE_PASSWORD_ROUTE = 'change-password'
/**
 * Failed password changes one person may make before waiting. The provider's
 * own rule on this route is per address and is widened for a class sharing
 * one (see customRules in auth/better-auth.ts), so the guard against guessing
 * a current password from a stolen session is this budget on the person.
 */
export const CHANGE_PASSWORD_ATTEMPT_LIMIT = 5
export const CHANGE_PASSWORD_ATTEMPT_WINDOW_SECONDS = 900

export function changePasswordAttemptKey(userId: string): string {
  return `change-password:user:${userId}`
}
/** Routes whose body may carry a remember-this-device request. */
const TRUST_DEVICE_ROUTES = [
  'two-factor/verify-totp',
  'two-factor/verify-backup-code',
]

/** Routes a caller reaches before having a session. */
const LOGIN_ROUTES = [
  'sign-in/email',
  'phone-number/send-otp',
  'phone-number/verify',
  'request-password-reset',
  'reset-password',
  'two-factor/verify-totp',
  'two-factor/verify-backup-code',
]

/** Routes whose body may ask for the shorter shared-device session. */
const SHARED_DEVICE_ROUTES = [
  'sign-in/email',
  'phone-number/verify',
  'two-factor/verify-totp',
  'two-factor/verify-backup-code',
]

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the /api/auth/* preHandler; read after the provider answered. */
    sharedDeviceRequested?: boolean
    mfaAttemptKey?: string
    changePasswordAttemptKey?: string
  }
}

export interface AppDependencies {
  config: ApiConfig
  auth: AuthInstance
  delivery: DeliveryAdapter
  pools: ApiPools
  /** Private document bytes. Storage keys never leave the server. */
  documents: DocumentStorage
  /** Tests only: a scripted model and read tools for the assistant. Never set in production. */
  assistant?: Pick<AssistantDependencies, 'assistantModel' | 'assistantTools' | 'assistantProposeTools'>
}

/** Internal header carrying the address Fastify resolved for this request. */
export const CLIENT_IP_HEADER = 'x-erp-client-ip'

/** Header and body values that must never reach a log line. */
const REDACT = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.newPassword',
  'req.body.currentPassword',
  'req.body.code',
  'req.body.token',
  'req.body.otp',
  // Government identifiers. They arrive on the admission and edit routes, on
  // a guardian inside them, and on every guardian of a bulk admission row.
  'req.body.aadhaar',
  'req.body.pan',
  'req.body.guardian.aadhaar',
  'req.body.guardian.pan',
  'req.body.guardians[*].guardian.aadhaar',
  'req.body.guardians[*].guardian.pan',
]

export function buildApp({
  config,
  auth,
  delivery,
  pools,
  documents,
  assistant,
}: AppDependencies): FastifyInstance {
  const app = Fastify({
    trustProxy: config.API_TRUST_PROXY,
    // Our own opaque request id; a client header must not choose it. Only a
    // write the API sends to itself may bring an id it reserved beforehand.
    requestIdHeader: false,
    genReqId: requestIdFor,
    disableRequestLogging: true,
    logger: {
      level: config.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: { paths: REDACT, remove: true },
    },
  })

  // Better Auth needs the unparsed body; JSON is re-parsed inside the handler.
  app.addContentTypeParser(
    ['application/json', 'application/x-www-form-urlencoded', 'text/plain'],
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  )

  app.addHook('onSend', async (request, reply) => {
    if (!request.url.startsWith('/api')) return
    // A route that already said "no-store" in its own words keeps them: the
    // photograph routes send "private, no-store", which is stricter than the
    // default here. Anything else is overwritten, so a route cannot make an
    // answer cacheable by accident.
    const own = reply.getHeader('cache-control')
    const keepsOwn = typeof own === 'string' && own.includes('no-store')
    if (!keepsOwn) reply.header('Cache-Control', 'no-store')
    // The same opaque id the access log and the error body carry, so a caller
    // can quote one request to us. It is a random UUID, so it tells a client
    // nothing it did not already send.
    reply.header('x-request-id', request.id)
  })

  app.setErrorHandler((error: unknown, request, reply) => {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? (error as { statusCode?: number }).statusCode
        : undefined
    // A policy denial already carries a contract code; keep it.
    const failure =
      error instanceof ApiFailure
        ? error
        : error instanceof AuthorizationError
          ? new ApiFailure(error.code)
          : new ApiFailure(frameworkErrorCode(statusCode))
    // Log our own summary only. The provider message never reaches the client.
    request.log.warn(
      { requestId: request.id, code: failure.code },
      'request failed',
    )
    // The access log reads this after the response: it records our own code,
    // never the provider's message.
    request.sentErrorCode = failure.code
    const where = {
      requestId: request.id,
      route: request.routeOptions.url,
      membershipId: request.context?.membershipId,
    }
    if (failure.code === 'ACCESS_DENIED') reportDenial(failure.code, where)
    else if (!(error instanceof ApiFailure) && (statusCode ?? 500) >= 500)
      reportError(error, where)
    const { status, body } = apiError(
      failure.code,
      request.id,
      failure.retryAfterSeconds,
      failure.reason,
    )
    reply.status(status).send(body)
  })

  app.setNotFoundHandler((request, reply) => {
    const { status, body } = apiError('RESOURCE_NOT_FOUND', request.id)
    reply.status(status).send(body)
  })

  registerAccessLog(app, { config, pool: pools.runtime })

  app.get('/api/health', async () => ({ status: 'ok' }))

  // Schoolless and minimal: it must never hint at who has an account.
  app.get('/api/auth-config', async () => ({
    deliveryMode: delivery.mode,
    studentLoginEnabled: true,
    // A test build holds text messages for a tester instead of sending them.
    textMessagesHeld: config.HELD_SMS_TOKEN !== undefined,
  }))

  // One policy service for the process; each call opens its own tenant
  // transaction on the runtime pool.
  const authz = createAuthorizationService({ pool: pools.runtime })

  registerDevRoutes(app, { config, delivery, authPool: pools.auth })
  registerHeldSmsRoute(app, { config, delivery, authPool: pools.auth })
  registerIdentityRoutes(app, { auth, pools, authz })
  registerStudentSignInRoute(app, { config, auth, pools })
  registerSessionRoutes(app, { auth, pools })
  registerMembershipRoutes(app, { auth, pools, authz, delivery })
  registerInvitationRoutes(app, { auth, pools, authz, delivery })
  registerModuleRoutes(app, { config, auth, pools, authz, delivery, documents })
  registerAssistantRoutes(app, { config, auth, pools, authz, delivery, documents, ...assistant })
  registerMaintenanceRoutes(app, { config, pools, documents })
  registerMessageMaintenanceRoutes(app, { config, pools, documents, delivery })

  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    // Only allowlisted provider endpoints exist on this origin.
    preHandler: async (request, reply) => {
      const path = request.url.slice('/api/auth/'.length).split('?')[0] ?? ''
      if (!isAllowedAuthRoute(path)) {
        const { status, body } = apiError('RESOURCE_NOT_FOUND', request.id)
        await reply.status(status).send(body)
        return
      }
      // Every provider route carries the same session policy as an
      // application route: an expired or over-limit session is refused and
      // deleted here, before the provider ever sees the cookie.
      const verified = await enforceSessionPolicy({ auth, pools }, request, {
        ignoreExpired: LOGIN_ROUTES.includes(path),
      })

      if (SHARED_DEVICE_ROUTES.includes(path)) {
        const body = safeJson(request.body)
        if (body) {
          const { sharedDevice, ...rest } = body
          request.sharedDeviceRequested = sharedDevice === true
          request.body = JSON.stringify(rest)
        }
      }

      // Trusted devices are disabled: a future challenge must not be skipped.
      if (TRUST_DEVICE_ROUTES.includes(path)) {
        const body = safeJson(request.body)
        if (body) request.body = JSON.stringify(stripTrustDeviceFlag(body))
        // Better Auth only counts two-factor failures on the sign-in path, so
        // a session that already exists could otherwise guess a six digit code
        // for ever. This budget is ours and it is durable.
        const key = mfaAttemptKey(verified?.user.id, request.ip)
        request.mfaAttemptKey = key
        const failures = await failureCount(pools.auth, key)
        if (failures >= MFA_ATTEMPT_LIMIT) {
          const { status, body: error } = apiError(
            'RATE_LIMITED',
            request.id,
            MFA_ATTEMPT_WINDOW_SECONDS,
          )
          await reply
            .status(status)
            .header('retry-after', String(MFA_ATTEMPT_WINDOW_SECONDS))
            .send(error)
        }
        return
      }

      if (path === CHANGE_PASSWORD_ROUTE) {
        // Changing a password always ends the other signed-in devices; the
        // caller does not get to opt out of that.
        const body = safeJson(request.body) ?? {}
        request.body = JSON.stringify({ ...body, revokeOtherSessions: true })
        // Without a session the provider refuses the call itself; with one,
        // the failure budget belongs to the person, not to the address.
        const userId = verified?.user.id
        if (!userId) return
        const key = changePasswordAttemptKey(userId)
        request.changePasswordAttemptKey = key
        const failures = await failureCount(pools.auth, key)
        if (failures >= CHANGE_PASSWORD_ATTEMPT_LIMIT) {
          const { status, body: error } = apiError(
            'RATE_LIMITED',
            request.id,
            CHANGE_PASSWORD_ATTEMPT_WINDOW_SECONDS,
          )
          await reply
            .status(status)
            .header('retry-after', String(CHANGE_PASSWORD_ATTEMPT_WINDOW_SECONDS))
            .send(error)
        }
        return
      }

      if (path === DISABLE_MFA_ROUTE) {
        // Turning off the second factor is a sensitive account change: the
        // provider already asks for the password, we also ask for proof that
        // the second factor was completed in the last five minutes.
        const current = verified ?? (await resolveSession({ auth, pools }, request))
        if (!isFreshMfa(current.mfaVerifiedAt)) {
          const { status, body } = apiError(
            'FRESH_AUTHENTICATION_REQUIRED',
            request.id,
          )
          await reply.status(status).send(body)
        }
        return
      }

      if (path === VERIFY_OTP_ROUTE) {
        // The send step stored the code against the E.164 form, so the verify
        // step has to look it up the same way. A 10 digit number is what the
        // login screen sends.
        const parsedVerify = safeJson(request.body)
        const verifyPhone = normalizeIndianPhone(parsedVerify?.phoneNumber)
        if (!verifyPhone) {
          const { status, body } = apiError('INVALID_REQUEST', request.id)
          await reply.status(status).send(body)
          return
        }
        request.body = JSON.stringify({
          ...parsedVerify,
          phoneNumber: verifyPhone,
        })
        return
      }

      if (path !== SEND_OTP_ROUTE) return

      // Normalise the number here so the throttle, the provider and the code
      // that is finally sent all agree on one E.164 form.
      const parsed = safeJson(request.body)
      const phone = normalizeIndianPhone(parsed?.phoneNumber)
      if (!phone) {
        // Same answer as an unknown number: the shape of an identifier must
        // not tell a caller whether it exists.
        await reply.status(200).send(GENERIC_SEND_RESPONSE)
        return
      }
      const allowance = await consumeSendAllowance(pools.auth, {
        phone,
        ip: request.ip,
      })
      if (!allowance.allowed) {
        const { status, body } = apiError(
          'RATE_LIMITED',
          request.id,
          allowance.retryAfterSeconds,
        )
        await reply
          .status(status)
          .header('retry-after', String(allowance.retryAfterSeconds))
          .send(body)
        return
      }
      request.body = JSON.stringify({ ...parsed, phoneNumber: phone })
    },
    handler: async (request, reply) => {
      const url = new URL(request.url, requestOrigin(request.raw, config))
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) continue
        for (const entry of Array.isArray(value) ? value : [value])
          headers.append(name, entry)
      }
      // A replayed trust-device cookie must never satisfy a challenge.
      const cookies = stripTrustDeviceCookies(request.headers.cookie)
      if (cookies) headers.set('cookie', cookies)
      else headers.delete('cookie')
      // Fastify already resolved the client address using the trust-proxy
      // setting. Overwrite any client-supplied value so rate limiting cannot
      // be spoofed into separate buckets.
      headers.delete(CLIENT_IP_HEADER)
      headers.set(CLIENT_IP_HEADER, request.ip)
      const webRequest = new Request(url, {
        method: request.method,
        headers,
        body:
          request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : typeof request.body === 'string'
              ? request.body
              : JSON.stringify(request.body ?? {}),
      })

      const response = await auth.handler(webRequest)
      const path = request.url.slice('/api/auth/'.length).split('?')[0] ?? ''

      // One body, one status, whatever happened inside: a caller must not be
      // able to tell a delivered code from an ignored number.
      if (path === SEND_OTP_ROUTE) {
        if (response.status >= 400)
          request.log.warn(
            { requestId: request.id, status: response.status },
            'phone otp send failed',
          )
        reply
          .status(200)
          .header('content-type', 'application/json; charset=utf-8')
          .send(JSON.stringify(GENERIC_SEND_RESPONSE))
        return
      }

      if (request.mfaAttemptKey) {
        if (response.status >= 400)
          await recordFailure(
            pools.auth,
            request.mfaAttemptKey,
            MFA_ATTEMPT_WINDOW_SECONDS,
          )
        else await clearBucket(pools.auth, request.mfaAttemptKey)
      }

      if (request.changePasswordAttemptKey) {
        if (response.status >= 400)
          await recordFailure(
            pools.auth,
            request.changePasswordAttemptKey,
            CHANGE_PASSWORD_ATTEMPT_WINDOW_SECONDS,
          )
        else await clearBucket(pools.auth, request.changePasswordAttemptKey)
      }

      const setCookie = response.headers.getSetCookie()
      const text = response.body ? await response.text() : ''

      if (response.status >= 400) {
        // Provider text, provider codes and provider stack detail stop here.
        // Every failure leaves as the same ApiError envelope.
        const code = providerErrorCode(response.status)
        request.log.warn(
          { requestId: request.id, status: response.status, code },
          'provider request failed',
        )
        const { status, body } = apiError(code, request.id)
        if (setCookie.length > 0) reply.header('set-cookie', setCookie)
        reply.status(status).send(body)
        return
      }

      const parsed = parseJson(text)
      // A new session may have been issued: honour a shared-device request
      // before the token is dropped from the body.
      const token =
        typeof parsed?.token === 'string' ? parsed.token : undefined
      if (request.sharedDeviceRequested && token)
        await markSharedDevice(pools.auth, token)

      reply.status(response.status)
      for (const [name, value] of response.headers) {
        if (name.toLowerCase() === 'set-cookie') continue
        if (name.toLowerCase() === 'content-length') continue
        reply.header(name, value)
      }
      // Each cookie must stay on its own header line.
      if (setCookie.length > 0) reply.header('set-cookie', setCookie)
      if (parsed === undefined) {
        reply.send(text.length > 0 ? text : null)
        return
      }
      reply.send(JSON.stringify(sanitizeProviderBody(parsed)))
    },
  })

  return app
}

/**
 * Only use forwarded protocol and host information when the deployment says a
 * trusted proxy sets it. Otherwise the configured application origin wins, so
 * a forged X-Forwarded-Host cannot change the URL Better Auth signs against.
 */
export function requestOrigin(
  raw: { headers: Record<string, string | string[] | undefined> },
  config: ApiConfig,
): string {
  if (!config.API_TRUST_PROXY) return config.APP_ORIGIN
  const proto = first(raw.headers['x-forwarded-proto'])
  const host = first(raw.headers['x-forwarded-host']) ?? first(raw.headers.host)
  if (!proto || !host) return config.APP_ORIGIN
  return `${proto}://${host}`
}

/** Framework failures are the client's mistake far more often than ours. */
function frameworkErrorCode(statusCode: number | undefined): ErrorCode {
  if (statusCode === 429) return 'RATE_LIMITED'
  if (statusCode === 404) return 'RESOURCE_NOT_FOUND'
  if (statusCode && statusCode >= 400 && statusCode < 500)
    return 'INVALID_REQUEST'
  return 'SERVICE_UNAVAILABLE'
}

/** Map a provider failure onto our own codes without copying its text. */
function providerErrorCode(status: number): ErrorCode {
  if (status === 401) return 'AUTHENTICATION_REQUIRED'
  if (status === 403) return 'ACCESS_DENIED'
  if (status === 404) return 'RESOURCE_NOT_FOUND'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'SERVICE_UNAVAILABLE'
  return 'INVALID_REQUEST'
}

function parseJson(text: string): Record<string, unknown> | undefined {
  if (text.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * A browser must never receive a bearer session token or a raw provider user
 * row: the session lives in an HttpOnly cookie and nothing else. The generated
 * `@phone-only.invalid` identifier is dropped here too, exactly as /api/me
 * drops it.
 */
export function sanitizeProviderBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const { token: _token, ...rest } = body
  const out: Record<string, unknown> = { ...rest }
  if (isRecord(out.user)) out.user = safeUser(out.user)
  if (isRecord(out.session)) out.session = safeSession(out.session)
  return out
}

function safeUser(user: Record<string, unknown>): Record<string, unknown> {
  const email = user.email
  return {
    id: user.id,
    name: user.name,
    ...(typeof email === 'string' && !email.endsWith('.invalid')
      ? { email, emailVerified: user.emailVerified === true }
      : {}),
    ...(typeof user.phoneNumber === 'string'
      ? {
          phoneNumber: user.phoneNumber,
          phoneNumberVerified: user.phoneNumberVerified === true,
        }
      : {}),
    twoFactorEnabled: user.twoFactorEnabled === true,
  }
}

function safeSession(
  session: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    mfaVerifiedAt: session.mfaVerifiedAt ?? null,
    sharedDevice: session.sharedDevice === true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeJson(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
