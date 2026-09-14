import type { RoleKey } from '@erp/contracts'

/**
 * The one dashboard a member sees. It is decided here, from the roles the
 * session already carries, and never from a query string: a parent who asks
 * for the office dashboard must not be able to ask for a different set of
 * numbers than the one their roles earn.
 */
export type DashboardAudience = 'office' | 'teacher' | 'parent' | 'accountant'

// This build has no clerk role; front-office duty is owner, principal and admin.
const OFFICE_ROLES: readonly RoleKey[] = ['owner', 'principal', 'admin']

/** Highest responsibility wins, so a teacher who is also a parent sees the class view. */
export function audienceFor(roleKeys: readonly RoleKey[]): DashboardAudience | null {
  if (roleKeys.some((role) => OFFICE_ROLES.includes(role))) return 'office'
  if (roleKeys.includes('teacher')) return 'teacher'
  if (roleKeys.includes('parent')) return 'parent'
  if (roleKeys.includes('accountant')) return 'accountant'
  return null
}
