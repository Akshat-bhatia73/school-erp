import { DASHBOARD_AUDIENCES, type DashboardAudienceKey, type RoleKey } from '@erp/contracts'

/**
 * The dashboard a member sees. It is decided here, from the roles the session
 * already carries. A member may ask for one of the audiences their own roles
 * earn, and nothing else: a parent who asks for the office dashboard is
 * refused rather than handed a different set of numbers than their roles earn.
 */
export type DashboardAudience = DashboardAudienceKey

// This build has no clerk role; front-office duty is owner, principal and admin.
const OFFICE_ROLES: readonly RoleKey[] = ['owner', 'principal', 'admin']

/** The roles that earn each audience. */
const ROLES_FOR: Readonly<Record<DashboardAudience, readonly RoleKey[]>> = {
  office: OFFICE_ROLES,
  accountant: ['accountant'],
  teacher: ['teacher'],
  parent: ['parent'],
  // Only a pupil's own login holds the student role.
  student: ['student'],
}

/**
 * Every audience these roles earn, in the default order: office, accountant,
 * teacher, parent, student. Empty for a role set that earns no dashboard at all.
 */
export function audiencesFor(roleKeys: readonly RoleKey[]): DashboardAudience[] {
  return DASHBOARD_AUDIENCES.filter((audience) => ROLES_FOR[audience].some((role) => roleKeys.includes(role)))
}

/** The audience a member lands on when they have not chosen one: the first their roles earn. */
export function audienceFor(roleKeys: readonly RoleKey[]): DashboardAudience | null {
  return audiencesFor(roleKeys)[0] ?? null
}

/**
 * The audience to draw: the requested one when the roles earn it, the default
 * when nothing was requested, and `null` when the request names an audience
 * the roles do not earn, so the route can refuse it before reading anything.
 */
export function resolveAudience(
  roleKeys: readonly RoleKey[],
  requested: DashboardAudience | undefined,
): DashboardAudience | null {
  const allowed = audiencesFor(roleKeys)
  if (requested === undefined) return allowed[0] ?? null
  return allowed.includes(requested) ? requested : null
}
