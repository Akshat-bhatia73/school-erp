/**
 * Pure helpers for reading what the server already decided.
 *
 * Nothing here is an authorization decision. The server decides, and these functions only read the
 * answer it sent — `allowedActions` on a record, `capabilities` on the session, and the frozen role
 * templates — so a screen can hide a control, name a role, or tell somebody what a role change
 * would gain and lose. A helper saying yes never makes a request succeed.
 */
import {
  PERMISSION_CATALOGUE,
  ROLE_DELEGATION_RULES,
  ROLE_MANAGEMENT_RULES,
  ROLE_TEMPLATES,
  RoleKey,
  type PermissionKey,
} from '@erp/contracts'

export type { PermissionKey }
export type { RoleKey }

/** The dashboard a set of roles earns. Mirrors apps/api/src/modules/dashboard/audience.ts. */
export type DashboardAudience = 'office' | 'teacher' | 'parent' | 'accountant' | 'none'

/** True when the server listed this action on the record it just sent. */
export function allows(allowedActions: readonly PermissionKey[] | undefined, key: PermissionKey): boolean {
  return allowedActions?.includes(key) ?? false
}

function isRoleKey(value: string): value is RoleKey {
  return RoleKey.safeParse(value).success
}

/** The name a person reads for a role: 'principal' -> 'Principal'. */
export function roleLabel(key: RoleKey): string {
  return ROLE_TEMPLATES[key].displayName
}

/**
 * The roles this actor may hand out, from the delegation rules the server enforces. Ownership has
 * its own transfer flow and student sign-in is disabled, so neither is ever assignable.
 */
export function assignableRolesFor(actorRoleKeys: readonly string[]): RoleKey[] {
  const union = new Set<RoleKey>()
  for (const role of actorRoleKeys) {
    if (!isRoleKey(role)) continue
    for (const assignable of ROLE_DELEGATION_RULES[role].assignableRoles) union.add(assignable)
  }
  union.delete('owner')
  union.delete('student')
  return [...union]
}

/**
 * True when the actor may act on a membership carrying exactly these roles. Every target role must
 * be manageable, so a teacher who is also an owner is out of reach of a principal.
 */
export function canManageTarget(actorRoleKeys: readonly string[], targetRoleKeys: readonly string[]): boolean {
  if (targetRoleKeys.length === 0) return false
  const manageable = new Set<string>()
  for (const role of actorRoleKeys) {
    if (!isRoleKey(role)) continue
    for (const target of ROLE_MANAGEMENT_RULES[role].manageableTargetRoles) manageable.add(target)
  }
  return targetRoleKeys.every((role) => manageable.has(role))
}

/** Every permission these roles grant, at any scope. */
export function permissionsForRoles(roleKeys: readonly string[]): Set<PermissionKey> {
  const permissions = new Set<PermissionKey>()
  for (const role of roleKeys) {
    if (!isRoleKey(role)) continue
    for (const grant of ROLE_TEMPLATES[role].grants) permissions.add(grant.permission)
  }
  return permissions
}

/** What a role change gains and loses, sorted, so a screen can show both lists before saving. */
export function diffRoleChange(
  fromRoleKeys: readonly string[],
  toRoleKeys: readonly string[],
): { added: PermissionKey[]; removed: PermissionKey[] } {
  const before = permissionsForRoles(fromRoleKeys)
  const after = permissionsForRoles(toRoleKeys)
  const added = [...after].filter((key) => !before.has(key)).sort()
  const removed = [...before].filter((key) => !after.has(key)).sort()
  return { added, removed }
}

// This build has no clerk role; front-office duty is owner, principal and admin.
const OFFICE_ROLES: readonly RoleKey[] = ['owner', 'principal', 'admin']

/** Highest responsibility wins, so a teacher who is also a parent sees the class view. */
export function audienceFor(roleKeys: readonly string[]): DashboardAudience {
  if (roleKeys.some((role) => isRoleKey(role) && OFFICE_ROLES.includes(role))) return 'office'
  if (roleKeys.includes('teacher')) return 'teacher'
  if (roleKeys.includes('parent')) return 'parent'
  if (roleKeys.includes('accountant')) return 'accountant'
  return 'none'
}

/** 'students.read_basic' -> 'Read basic student details'. */
function humanise(key: PermissionKey): string {
  const [resource = '', action = ''] = key.split('.')
  const words = action.split('_')
  const verb = words[0] ?? ''
  const rest = words.slice(1).join(' ')
  const subject = resource.replace(/_/g, ' ')
  const sentence = [verb, rest, subject].filter((part) => part !== '').join(' ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

/** A plain-English label for one permission, preferring the catalogue's own description. */
export function describePermission(key: PermissionKey): string {
  const description = PERMISSION_CATALOGUE[key]?.description
  return description && description.trim() !== '' ? description : humanise(key)
}
