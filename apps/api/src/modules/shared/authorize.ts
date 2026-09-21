import {
  ACTIVE_PERMISSION_KEYS,
  PERMISSION_CATALOGUE,
  ROLE_TEMPLATES,
  type PermissionKey,
  type ResourceType,
  type RoleKey,
} from '@erp/contracts'
import type {
  AuthorizationDecision,
  AuthorizedReadPlan,
  RequestContext,
  ResourceReference,
} from '@erp/contracts/server'
import {
  AuthorizationError,
  createReadPlan,
  evaluate,
  loadMembershipStateById,
  loadPolicySnapshotFor,
  loadRelationshipFactsFor,
  loadResourceFacts,
  type AuthzConnection,
} from '@erp/authz'
import { ApiFailure } from '../../http/errors.ts'
import { authorizeSchoolAction, decideAction } from '../../memberships/authorize.ts'

/**
 * Every helper here runs on the connection the caller already opened, so a
 * list, its detail reads and the audit row all share one tenant transaction
 * and one policy snapshot. The decisions themselves still come from the shared
 * evaluator; nothing in a module decides access on its own.
 */
export { authorizeSchoolAction }

/**
 * The decision for the whole school, without throwing on a denial. A block
 * whose permission is about another kind of record than the one in hand is
 * decided here and then narrowed row by row through its own read plan.
 */
export async function decideSchoolAction(
  conn: AuthzConnection,
  context: RequestContext,
  permission: PermissionKey,
): Promise<AuthorizationDecision> {
  return decideAction(conn, context, permission, context.schoolId, true)
}

/** The decision for one record, without throwing on a denial. */
export async function decideResource(
  conn: AuthzConnection,
  context: RequestContext,
  permission: PermissionKey,
  resourceType: ResourceType,
  id: string,
): Promise<AuthorizationDecision> {
  // The catalogue owns the pairing of permission and resource type, so a route
  // that names the wrong one is refused exactly like a missing record.
  if (PERMISSION_CATALOGUE[permission].resourceType !== resourceType) {
    return { allowed: false, code: 'RESOURCE_NOT_FOUND' }
  }
  return decideAction(conn, context, permission, id, false)
}

/** The same decision, as the failure a route may let escape. */
export async function authorizeResource(
  conn: AuthzConnection,
  context: RequestContext,
  permission: PermissionKey,
  resourceType: ResourceType,
  id: string,
): Promise<void> {
  const decision = await decideResource(conn, context, permission, resourceType, id)
  if (!decision.allowed) throw new ApiFailure(decision.code)
}

/**
 * Every active permission of this record's resource type the caller may use on
 * it. It mirrors the policy service, but on the caller's own connection, so a
 * detail response lists actions decided against the same snapshot it read.
 */
export async function allowedActionsFor(
  conn: AuthzConnection,
  context: RequestContext,
  resource: ResourceReference,
): Promise<readonly PermissionKey[]> {
  const state = await loadMembershipStateById(conn, context.schoolId, context.membershipId)
  if (!state || state.status !== 'active') throw new ApiFailure('ACCESS_DENIED')
  const snapshot = await loadPolicySnapshotFor(conn, context.schoolId, context.membershipId)
  const facts = await loadRelationshipFactsFor(conn, context.schoolId, context.membershipId, context.now)
  const resourceFacts = await loadResourceFacts(conn, context, resource)
  return ACTIVE_PERMISSION_KEYS.filter(
    (permission) =>
      PERMISSION_CATALOGUE[permission].resourceType === resource.resourceType &&
      evaluate({ context, permission, resource, snapshot, facts, resourceFacts }).allowed,
  )
}

/**
 * The same list for many records of one kind, for a list response. The
 * membership, the policy snapshot and the relationship facts are loaded once;
 * only the facts of each record are loaded per record, so the decisions are
 * exactly the ones allowedActionsFor would give, one record at a time. A
 * record whose facts cannot be loaded is simply left out of the map.
 */
export async function allowedActionsForMany(
  conn: AuthzConnection,
  context: RequestContext,
  resourceType: ResourceType,
  ids: readonly string[],
): Promise<ReadonlyMap<string, readonly PermissionKey[]>> {
  const actions = new Map<string, readonly PermissionKey[]>()
  if (ids.length === 0) return actions
  const state = await loadMembershipStateById(conn, context.schoolId, context.membershipId)
  if (!state || state.status !== 'active') throw new ApiFailure('ACCESS_DENIED')
  const snapshot = await loadPolicySnapshotFor(conn, context.schoolId, context.membershipId)
  const facts = await loadRelationshipFactsFor(conn, context.schoolId, context.membershipId, context.now)
  const permissions = ACTIVE_PERMISSION_KEYS.filter(
    (permission) => PERMISSION_CATALOGUE[permission].resourceType === resourceType,
  )
  for (const id of new Set(ids)) {
    const resource: ResourceReference = { schoolId: context.schoolId, resourceType, id }
    const resourceFacts = await loadResourceFacts(conn, context, resource)
    actions.set(
      id,
      permissions.filter(
        (permission) => evaluate({ context, permission, resource, snapshot, facts, resourceFacts }).allowed,
      ),
    )
  }
  return actions
}

/**
 * A read plan built on the caller's connection, so a list and the detail reads
 * that follow it run in one transaction rather than one each.
 */
export async function readPlan(
  conn: AuthzConnection,
  context: RequestContext,
  permission: PermissionKey,
  resourceType: ResourceType,
): Promise<AuthorizedReadPlan> {
  const state = await loadMembershipStateById(conn, context.schoolId, context.membershipId)
  if (!state || state.status !== 'active') throw new AuthorizationError('ACCESS_DENIED')
  const snapshot = await loadPolicySnapshotFor(conn, context.schoolId, context.membershipId)
  const facts = await loadRelationshipFactsFor(conn, context.schoolId, context.membershipId, context.now)
  return createReadPlan(context, permission, resourceType, snapshot, facts)
}

/** True when the caller's own roles force two-step verification. */
export function requiresMfa(context: RequestContext): boolean {
  return context.roleKeys.some((role: RoleKey) => ROLE_TEMPLATES[role].requiredMfa)
}
