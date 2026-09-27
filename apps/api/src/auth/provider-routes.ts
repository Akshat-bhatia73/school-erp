/**
 * The allowlist of Better Auth endpoints this deployment exposes.
 *
 * Everything the provider ships that is not listed here is answered with a
 * plain 404 ApiError before the handler runs, so a future provider upgrade
 * cannot silently publish a new route (self-signup, account deletion, email or
 * profile changes) on our origin.
 */
export const ALLOWED_AUTH_ROUTES: readonly string[] = [
  'ok',
  'error',
  'get-session',
  'sign-in/email',
  'sign-out',
  'revoke-sessions',
  'revoke-other-sessions',
  // 1.7.4 names the request route /request-password-reset; there is no
  // /forget-password endpoint any more.
  'request-password-reset',
  'reset-password',
  'change-password',
  'phone-number/send-otp',
  'phone-number/verify',
  // Two-factor challenge and recovery, listed one by one. Setting up or
  // switching a second step goes through POST /api/account/second-step, so
  // the provider's own enable route is closed. The text and email code pair
  // serves only a person who chose one of those (see the before hook in
  // better-auth.ts).
  'two-factor/disable',
  'two-factor/get-totp-uri',
  'two-factor/verify-totp',
  'two-factor/send-otp',
  'two-factor/verify-otp',
  'two-factor/verify-backup-code',
  'two-factor/generate-backup-codes',
]

/**
 * Explicitly blocked even if a prefix would otherwise allow them. Kept for
 * documentation: these are the provider routes that could create or mutate an
 * identity without school approval.
 */
export const BLOCKED_AUTH_ROUTES: readonly string[] = [
  'sign-up/email',
  // Both answer with raw session tokens. The API publishes its own
  // /api/sessions pair, which uses opaque session ids instead.
  'list-sessions',
  'revoke-session',
  'delete-user',
  'change-email',
  'update-user',
  'phone-number/update',
  'sign-in/phone-number',
  // Skips the checks POST /api/account/second-step makes.
  'two-factor/enable',
  'two-factor/view-backup-codes',
]

/** `path` is the part after `/api/auth/`, without a query string. */
export function isAllowedAuthRoute(path: string): boolean {
  const route = path.replace(/^\/+/, '').replace(/\/+$/, '')
  if (BLOCKED_AUTH_ROUTES.includes(route)) return false
  return ALLOWED_AUTH_ROUTES.includes(route)
}
