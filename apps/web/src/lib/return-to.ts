/** Where to go after signing in. Only our own paths are ever accepted. */
export const DEFAULT_RETURN_TO = '/dashboard'

// Credential screens only. `/accept-invite` is deliberately absent: it is a destination, not a
// sign-in step, so an invitee who has to sign in first still lands back on their invitation.
const AUTH_PREFIXES = [
  '/login', '/verify-otp', '/forgot-password', '/reset-password',
  '/mfa', '/select-school', '/access-unavailable',
]

/**
 * Accepts only a same-origin relative path. Anything that could leave the app — a scheme, a
 * protocol-relative '//host', a backslash, or an auth screen we would bounce off again — falls
 * back to the dashboard.
 */
export function sanitiseReturnTo(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_RETURN_TO
  const raw = value.trim()
  if (!raw.startsWith('/')) return DEFAULT_RETURN_TO
  if (raw.startsWith('//')) return DEFAULT_RETURN_TO
  if (raw.includes('\\')) return DEFAULT_RETURN_TO
  if (/^\/+[a-z][a-z0-9+.-]*:/i.test(raw)) return DEFAULT_RETURN_TO
  const path = raw.split('?')[0]!.split('#')[0]!
  if (AUTH_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + '/'))) return DEFAULT_RETURN_TO
  return raw
}
