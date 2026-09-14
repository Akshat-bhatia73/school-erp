import { ROLE_TEMPLATES, type RoleKey } from '@erp/contracts'

/** A membership is privileged when any of its roles requires MFA. */
export function membershipRequiresMfa(roleKeys: readonly RoleKey[]): boolean {
  return roleKeys.some((key) => ROLE_TEMPLATES[key].requiredMfa)
}

/**
 * True when the second factor was proven recently enough to act as proof that
 * the same person is still at the keyboard.
 */
export function isFreshMfa(
  mfaVerifiedAt: string | null,
  now: number = Date.now(),
  maxAgeSeconds = 300,
): boolean {
  if (!mfaVerifiedAt) return false
  const verifiedAt = Date.parse(mfaVerifiedAt)
  return (
    Number.isFinite(verifiedAt) && now - verifiedAt <= maxAgeSeconds * 1000
  )
}

/** Session limits follow the strongest role the person holds anywhere. */
export interface SessionLimits {
  absoluteSeconds: number
  idleSeconds: number | null
}

/** A shared front-desk browser never keeps a session for long. */
export const SHARED_DEVICE_LIMITS: SessionLimits = {
  absoluteSeconds: 2 * 3600,
  idleSeconds: 15 * 60,
}

export function sessionLimitsFor(
  roleKeys: readonly RoleKey[],
  sharedDevice = false,
): SessionLimits {
  if (sharedDevice) return SHARED_DEVICE_LIMITS
  if (membershipRequiresMfa(roleKeys)) {
    return { absoluteSeconds: 8 * 3600, idleSeconds: 30 * 60 }
  }
  if (roleKeys.includes('teacher')) {
    return { absoluteSeconds: 12 * 3600, idleSeconds: 60 * 60 }
  }
  if (roleKeys.length > 0 && roleKeys.every((key) => key === 'parent')) {
    return { absoluteSeconds: 7 * 24 * 3600, idleSeconds: null }
  }
  // No usable membership yet: treat the session as an ordinary staff session.
  return { absoluteSeconds: 12 * 3600, idleSeconds: 60 * 60 }
}
