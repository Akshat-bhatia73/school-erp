import type { FastifyRequest } from 'fastify'
import type { RoleKey } from '@erp/contracts'
import { ApiFailure } from '../http/errors.ts'
import type { ApiPools } from '../db.ts'
import type { AuthInstance } from './better-auth.ts'
import { sessionLimitsFor, type SessionLimits } from './assurance.ts'
import { userIsDisabled } from './lockout.ts'
import {
  hasStudentIdentity,
  resolveMemberships,
  type MembershipSummaryValue,
} from '../identity/resolve.ts'

export interface VerifiedSession {
  user: { id: string; name: string; email: string; phoneNumber?: string | null }
  session: {
    id: string
    token: string
    createdAt: Date
    updatedAt: Date
    expiresAt: Date
    mfaVerifiedAt: Date | null
    sharedDevice: boolean
  }
  memberships: MembershipSummaryValue[]
  roleKeys: RoleKey[]
  limits: SessionLimits
  /** Earliest of the provider expiry and our absolute limit. */
  effectiveExpiresAt: Date
  assurance: 'single_factor' | 'mfa'
  mfaVerifiedAt: string | null
}

export interface SessionDependencies {
  auth: AuthInstance
  pools: ApiPools
}

/** Touch at most once a minute so a busy tab does not write on every request. */
const TOUCH_INTERVAL_SECONDS = 60

/**
 * Verified on every protected request against the database. Nothing here is
 * cached: a revoked session must fail on its very next request.
 */
export async function resolveSession(
  deps: SessionDependencies,
  request: FastifyRequest,
): Promise<VerifiedSession> {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    for (const entry of Array.isArray(value) ? value : [value])
      headers.append(name, entry)
  }

  const result = await deps.auth.api
    .getSession({ headers })
    .catch(() => null)
  if (!result?.session || !result.user) {
    throw new ApiFailure('AUTHENTICATION_REQUIRED')
  }

  const session = result.session as unknown as {
    id: string
    token: string
    createdAt: Date
    updatedAt: Date
    expiresAt: Date
    mfaVerifiedAt?: Date | string | null
    sharedDevice?: boolean | null
  }
  const user = result.user as unknown as VerifiedSession['user']

  // An operator-disabled identity loses every live session at once, so a
  // cookie taken before the disable stops working on its next request.
  if (await userIsDisabled(deps.pools.auth, user.id)) {
    const context = await deps.auth.$context
    await context.internalAdapter.deleteUserSessions(user.id)
    throw new ApiFailure('AUTHENTICATION_REQUIRED')
  }

  // Student identities can never hold a session, whichever door they used.
  if (await hasStudentIdentity(deps.pools, user.id)) {
    const context = await deps.auth.$context
    await context.internalAdapter.deleteUserSessions(user.id)
    throw new ApiFailure('FEATURE_DISABLED')
  }

  const memberships = await resolveMemberships(deps.pools, {
    requestId: request.id,
    userId: user.id,
    sessionId: session.id,
  })
  const roleKeys = [
    ...new Set(memberships.flatMap((membership) => membership.roleKeys)),
  ] as RoleKey[]
  const sharedDevice = session.sharedDevice === true
  const limits = sessionLimitsFor(roleKeys, sharedDevice)

  const now = Date.now()
  const createdAt = new Date(session.createdAt)
  const updatedAt = new Date(session.updatedAt)
  const absoluteExpiresAt = new Date(
    createdAt.getTime() + limits.absoluteSeconds * 1000,
  )
  const idleDeadline =
    limits.idleSeconds === null
      ? null
      : new Date(updatedAt.getTime() + limits.idleSeconds * 1000)

  if (
    now >= absoluteExpiresAt.getTime() ||
    (idleDeadline && now >= idleDeadline.getTime())
  ) {
    // Sliding renewal must never defeat the absolute limit, so the row goes.
    await deleteSessionRow(deps, session.token)
    throw new ApiFailure('SESSION_EXPIRED')
  }

  if (now - updatedAt.getTime() >= TOUCH_INTERVAL_SECONDS * 1000) {
    await touchSession(deps, session.id)
  }

  const mfaVerifiedAt = session.mfaVerifiedAt
    ? new Date(session.mfaVerifiedAt).toISOString()
    : null
  const providerExpiresAt = new Date(session.expiresAt)

  return {
    user,
    session: {
      id: session.id,
      token: session.token,
      createdAt,
      updatedAt,
      expiresAt: providerExpiresAt,
      mfaVerifiedAt: mfaVerifiedAt ? new Date(mfaVerifiedAt) : null,
      sharedDevice,
    },
    memberships,
    roleKeys,
    limits,
    effectiveExpiresAt:
      providerExpiresAt.getTime() < absoluteExpiresAt.getTime()
        ? providerExpiresAt
        : absoluteExpiresAt,
    assurance: mfaVerifiedAt ? 'mfa' : 'single_factor',
    mfaVerifiedAt,
  }
}

/**
 * Apply the same session policy to a provider route. A request without a
 * session simply passes through: sign-in and password reset have no cookie
 * yet. Everything else (an expired session, a student identity) fails here
 * exactly as it would on an application route. On a login route an expired
 * cookie is deleted and then ignored, so a stale cookie cannot block a fresh
 * sign-in. Returns the verified session when one exists.
 */
export async function enforceSessionPolicy(
  deps: SessionDependencies,
  request: FastifyRequest,
  options: { ignoreExpired?: boolean } = {},
): Promise<VerifiedSession | null> {
  try {
    return await resolveSession(deps, request)
  } catch (error) {
    if (
      error instanceof ApiFailure &&
      (error.code === 'AUTHENTICATION_REQUIRED' ||
        (options.ignoreExpired && error.code === 'SESSION_EXPIRED'))
    )
      return null
    throw error
  }
}

async function deleteSessionRow(
  deps: SessionDependencies,
  token: string,
): Promise<void> {
  const context = await deps.auth.$context
  await context.internalAdapter.deleteSession(token)
}

/** Idle tracking writes through the auth connection only. */
async function touchSession(
  deps: SessionDependencies,
  sessionId: string,
): Promise<void> {
  await deps.pools.auth.query(
    `UPDATE auth_session
        SET updated_at = now()
      WHERE id = $1
        AND updated_at < now() - make_interval(secs => $2)`,
    [sessionId, TOUCH_INTERVAL_SECONDS],
  )
}
