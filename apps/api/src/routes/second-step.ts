import type { FastifyInstance, FastifyRequest } from 'fastify'
import { userHasStudentMembership } from '@erp/db'
import {
  SecondStepStartRequest,
  SecondStepStartResponse,
  type ErrorReason,
} from '@erp/contracts'
import { ApiFailure } from '../http/errors.ts'
import { requireSession } from '../auth/guards.ts'
import { isFreshMfa } from '../auth/assurance.ts'
import type { SessionDependencies } from '../auth/session.ts'
import { clearBucket, failureCount, recordFailure } from '../auth/throttle.ts'
import {
  destinationFor,
  readSecondStep,
  realEmail,
  sessionUsedPhoneCode,
  setPendingStep,
  verifiedPhone,
} from '../auth/second-step.ts'

/** Wrong passwords one person may give here before waiting. */
export const SECOND_STEP_PASSWORD_ATTEMPT_LIMIT = 5
export const SECOND_STEP_PASSWORD_ATTEMPT_WINDOW_SECONDS = 900

function refuse(reason: ErrorReason): ApiFailure {
  return new ApiFailure('INVALID_REQUEST', undefined, reason)
}

function forwardHeaders(request: FastifyRequest): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    for (const entry of Array.isArray(value) ? value : [value])
      headers.append(name, entry)
  }
  return headers
}

/**
 * Choosing a second step: an authenticator app, a code by text message or a
 * code by email. This is the only way to set one up or switch; the provider's
 * own enable route is not published.
 *
 * Nothing changes here except that the chosen step becomes "pending". It
 * replaces the step in use only when a code from it is accepted on this
 * person's session (see commitPendingStep), so a half-finished switch never
 * locks anyone out and never weakens the account. Switching away from a step
 * in use needs the password and a second step proven in the last five
 * minutes, the same as turning it off.
 */
export function registerSecondStepRoutes(
  app: FastifyInstance,
  deps: SessionDependencies,
): void {
  app.post(
    '/api/account/second-step',
    { preHandler: requireSession(deps) },
    async (request) => {
      const verified = request.verified
      if (!verified) throw new ApiFailure('AUTHENTICATION_REQUIRED')
      // The app keeps every JSON body as its raw text (the provider needs it
      // unparsed), so this route parses its own.
      let raw: unknown = request.body
      if (typeof raw === 'string') {
        try {
          raw = JSON.parse(raw)
        } catch {
          throw new ApiFailure('INVALID_REQUEST')
        }
      }
      const parsed = SecondStepStartRequest.safeParse(raw)
      if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
      const { method, password } = parsed.data
      const userId = verified.user.id

      // A pupil's login has no second step.
      if (await userHasStudentMembership(deps.pools.identity, userId))
        throw new ApiFailure('ACCESS_DENIED')

      const state = await readSecondStep(deps.pools.auth, userId)
      if (!state) throw new ApiFailure('AUTHENTICATION_REQUIRED')
      if (state.twoFactorEnabled && !isFreshMfa(verified.mfaVerifiedAt))
        throw new ApiFailure('FRESH_AUTHENTICATION_REQUIRED')
      if (state.twoFactorEnabled && state.method === method)
        throw refuse('second_step_already_in_use')
      if (method === 'sms') {
        if (!verifiedPhone(state)) throw refuse('second_step_needs_phone')
        if (await sessionUsedPhoneCode(deps.pools.auth, verified.session.id))
          throw refuse('second_step_phone_code_session')
      }
      if (method === 'email' && !realEmail(state))
        throw refuse('second_step_needs_email')

      // The password proves the person at the keyboard; guessing it from a
      // stolen session is budgeted per person, not per address.
      const attemptKey = `second-step-password:user:${userId}`
      if (
        (await failureCount(deps.pools.auth, attemptKey)) >=
        SECOND_STEP_PASSWORD_ATTEMPT_LIMIT
      )
        throw new ApiFailure(
          'RATE_LIMITED',
          SECOND_STEP_PASSWORD_ATTEMPT_WINDOW_SECONDS,
        )
      const headers = forwardHeaders(request)
      const passwordOk = await deps.auth.api
        .verifyPassword({ body: { password }, headers })
        .then(() => true)
        .catch(() => false)
      if (!passwordOk) {
        await recordFailure(
          deps.pools.auth,
          attemptKey,
          SECOND_STEP_PASSWORD_ATTEMPT_WINDOW_SECONDS,
        )
        throw refuse('second_step_wrong_password')
      }
      await clearBucket(deps.pools.auth, attemptKey)

      // The authenticator needs a new secret, and a first second step needs
      // backup codes. Leaving the authenticator for a code keeps the backup
      // codes the person already saved.
      const existing = await deps.pools.auth.query<{ verified: boolean }>(
        'SELECT verified FROM auth_two_factor WHERE user_id = $1',
        [userId],
      )
      let totpURI: string | undefined
      let backupCodes: string[] | undefined
      if (method === 'totp' || existing.rows.length === 0) {
        const enabled = await deps.auth.api
          .enableTwoFactor({ body: { password }, headers })
          .catch(() => null)
        if (!enabled || !('backupCodes' in enabled))
          throw new ApiFailure('INVALID_REQUEST')
        backupCodes = enabled.backupCodes
        if (method === 'totp') totpURI = enabled.totpURI
      }

      await setPendingStep(deps.pools.auth, userId, method)
      return SecondStepStartResponse.parse({
        method,
        ...(totpURI ? { totpURI } : {}),
        ...(backupCodes ? { backupCodes } : {}),
        ...(method === 'totp' ? {} : { destination: destinationFor(state, method) }),
      })
    },
  )
}
