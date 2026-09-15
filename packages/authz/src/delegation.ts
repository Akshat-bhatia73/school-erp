import { ROLE_DELEGATION_RULES, ROLE_MANAGEMENT_RULES } from '@erp/contracts'
import type { RoleKey } from '@erp/contracts'

export type DelegationDenial =
  | 'SELF_CHANGE'
  | 'NOT_DELEGABLE'
  | 'OWNER_OR_STUDENT_ROLE'
  | 'TARGET_NOT_MANAGEABLE'
  | 'NO_AUTHORITY'

export type DelegationResult = { readonly ok: true } | { readonly ok: false; readonly reason: DelegationDenial }

const PROTECTED_ROLES: readonly RoleKey[] = ['owner', 'student']

export function assignableRolesFor(actorRoleKeys: readonly RoleKey[]): readonly RoleKey[] {
  const assignable = new Set<RoleKey>()
  for (const role of actorRoleKeys) {
    for (const target of ROLE_DELEGATION_RULES[role].assignableRoles) assignable.add(target)
  }
  return [...assignable]
}

function manageableRolesFor(actorRoleKeys: readonly RoleKey[]): readonly RoleKey[] {
  const manageable = new Set<RoleKey>()
  for (const role of actorRoleKeys) {
    for (const target of ROLE_MANAGEMENT_RULES[role].manageableTargetRoles) manageable.add(target)
  }
  return [...manageable]
}

export function checkRoleAssignment(input: {
  actorMembershipId: string
  actorRoleKeys: readonly RoleKey[]
  targetMembershipId: string
  targetCurrentRoleKeys: readonly RoleKey[]
  proposedRoleKeys: readonly RoleKey[]
}): DelegationResult {
  if (input.actorMembershipId === input.targetMembershipId) return { ok: false, reason: 'SELF_CHANGE' }

  const assignable = assignableRolesFor(input.actorRoleKeys)
  if (assignable.length === 0) return { ok: false, reason: 'NO_AUTHORITY' }

  // Ownership and student memberships are never touched by generic role assignment.
  const touched = [...input.proposedRoleKeys, ...input.targetCurrentRoleKeys]
  if (touched.some((role) => PROTECTED_ROLES.includes(role))) {
    return { ok: false, reason: 'OWNER_OR_STUDENT_ROLE' }
  }

  const manageable = manageableRolesFor(input.actorRoleKeys)
  if (input.targetCurrentRoleKeys.some((role) => !manageable.includes(role))) {
    return { ok: false, reason: 'TARGET_NOT_MANAGEABLE' }
  }

  const changed = [
    ...input.proposedRoleKeys.filter((role) => !input.targetCurrentRoleKeys.includes(role)),
    ...input.targetCurrentRoleKeys.filter((role) => !input.proposedRoleKeys.includes(role)),
  ]
  if ([...input.proposedRoleKeys, ...changed].some((role) => !assignable.includes(role))) {
    return { ok: false, reason: 'NOT_DELEGABLE' }
  }
  return { ok: true }
}

export function checkMembershipLifecycle(input: {
  actorMembershipId: string
  actorRoleKeys: readonly RoleKey[]
  targetMembershipId: string
  targetRoleKeys: readonly RoleKey[]
}): DelegationResult {
  if (input.actorMembershipId === input.targetMembershipId) return { ok: false, reason: 'SELF_CHANGE' }

  const manageable = manageableRolesFor(input.actorRoleKeys)
  if (manageable.length === 0) return { ok: false, reason: 'NO_AUTHORITY' }

  // Owners are only demoted through the ownership transfer workflow.
  if (input.targetRoleKeys.some((role) => PROTECTED_ROLES.includes(role))) {
    return { ok: false, reason: 'OWNER_OR_STUDENT_ROLE' }
  }
  if (input.targetRoleKeys.some((role) => !manageable.includes(role))) {
    return { ok: false, reason: 'TARGET_NOT_MANAGEABLE' }
  }
  return { ok: true }
}

export function mayTransferOwnership(actorRoleKeys: readonly RoleKey[]): boolean {
  return actorRoleKeys.some((role) => ROLE_DELEGATION_RULES[role].mayTransferOwnership)
}
