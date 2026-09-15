import {
  evaluate,
  loadMembershipStateById,
  loadPolicySnapshotFor,
  loadRelationshipFactsFor,
  loadResourceFacts,
  type AuthzConnection,
} from '@erp/authz'
import { PERMISSION_CATALOGUE, type PermissionKey } from '@erp/contracts'
import type { RequestContext, ResourceReference } from '@erp/contracts/server'
import { ApiFailure } from '../http/errors.ts'

/**
 * The one place a membership route asks whether the caller may act. The
 * decision always comes from the shared evaluator, never from a role check
 * written here.
 */
async function decide(
  conn: AuthzConnection,
  context: RequestContext,
  permission: PermissionKey,
  resourceId: string,
  aggregate: boolean,
): Promise<void> {
  // A suspended or removed membership is treated exactly like no access.
  const state = await loadMembershipStateById(conn, context.schoolId, context.membershipId)
  if (!state || state.status !== 'active') throw new ApiFailure('ACCESS_DENIED')

  const resourceType = PERMISSION_CATALOGUE[permission].resourceType
  const resource: ResourceReference = { schoolId: context.schoolId, resourceType, id: resourceId }
  const snapshot = await loadPolicySnapshotFor(conn, context.schoolId, context.membershipId)
  const facts = await loadRelationshipFactsFor(conn, context.schoolId, context.membershipId, context.now)
  const resourceFacts = aggregate
    ? { resourceType, id: resourceId, aggregate: true as const }
    : await loadResourceFacts(conn, context, resource)

  const decision = evaluate({ context, permission, resource, snapshot, facts, resourceFacts })
  if (!decision.allowed) throw new ApiFailure(decision.code)
}

/** School wide actions: listing, inviting, transferring ownership. */
export async function authorizeSchoolAction(
  conn: AuthzConnection,
  context: RequestContext,
  permission: PermissionKey,
): Promise<void> {
  await decide(conn, context, permission, context.schoolId, true)
}

/** Actions aimed at one membership. A missing row answers RESOURCE_NOT_FOUND. */
export async function authorizeOnMembership(
  conn: AuthzConnection,
  context: RequestContext,
  permission: PermissionKey,
  membershipId: string,
): Promise<void> {
  await decide(conn, context, permission, membershipId, false)
}
