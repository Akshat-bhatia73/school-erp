import type { Pool } from 'pg'

import { withTenantTransaction } from '@erp/db'
import { ACTIVE_PERMISSION_KEYS, PERMISSION_CATALOGUE, ROLE_TEMPLATES } from '@erp/contracts'
import type { PermissionKey, ResourceType, RoleKey } from '@erp/contracts'
import type {
  AccessExplanation,
  AuthorizationDecision,
  AuthorizationService,
  AuthorizedReadPlan,
  FieldGroup,
  RequestContext,
  ResourceReference,
} from '@erp/contracts/server'

import { AuthorizationError } from './errors.ts'
import { evaluate, explain } from './policy.ts'
import { createReadPlan } from './scope.ts'
import {
  loadMembershipStateById,
  loadPolicySnapshotFor,
  loadRelationshipFactsFor,
  loadResourceFacts,
  loadRoleKeys,
} from './snapshot.ts'
import type { AuthzConnection, MembershipState } from './snapshot.ts'

/**
 * The contract service plus the navigation hint the school context endpoint
 * needs: every permission this member could exercise somewhere in the school.
 */
export interface SchoolAuthorizationService extends AuthorizationService {
  capabilities(context: RequestContext): Promise<readonly PermissionKey[]>
}

export interface AuthorizationServiceOptions {
  /** The runtime pool. Every read runs inside withTenantTransaction on it. */
  readonly pool: Pool
}

async function activeState(conn: AuthzConnection, context: RequestContext): Promise<MembershipState | null> {
  const state = await loadMembershipStateById(conn, context.schoolId, context.membershipId)
  if (!state || state.status !== 'active') return null
  return state
}

export function createAuthorizationService(options: AuthorizationServiceOptions): SchoolAuthorizationService {
  const { pool } = options

  async function authorize(
    context: RequestContext,
    permission: PermissionKey,
    resource: ResourceReference,
    requestedFieldGroups?: readonly FieldGroup[],
  ): Promise<AuthorizationDecision> {
    return withTenantTransaction(pool, context, async (conn) => {
      // A suspended or removed membership is treated exactly like no access.
      if ((await activeState(conn, context)) === null) {
        return { allowed: false, code: 'ACCESS_DENIED' } as const
      }
      const snapshot = await loadPolicySnapshotFor(conn, context.schoolId, context.membershipId)
      const facts = await loadRelationshipFactsFor(conn, context.schoolId, context.membershipId, context.now)
      const resourceFacts = await loadResourceFacts(conn, context, resource)
      return evaluate({
        context,
        permission,
        resource,
        snapshot,
        facts,
        resourceFacts,
        ...(requestedFieldGroups === undefined ? {} : { requestedFieldGroups }),
      })
    })
  }

  async function allowedActions(
    context: RequestContext,
    resource: ResourceReference,
  ): Promise<readonly PermissionKey[]> {
    return withTenantTransaction(pool, context, async (conn) => {
      if ((await activeState(conn, context)) === null) throw new AuthorizationError('ACCESS_DENIED')
      const snapshot = await loadPolicySnapshotFor(conn, context.schoolId, context.membershipId)
      const facts = await loadRelationshipFactsFor(conn, context.schoolId, context.membershipId, context.now)
      const resourceFacts = await loadResourceFacts(conn, context, resource)
      return ACTIVE_PERMISSION_KEYS.filter(
        (permission) =>
          PERMISSION_CATALOGUE[permission].resourceType === resource.resourceType &&
          evaluate({ context, permission, resource, snapshot, facts, resourceFacts }).allowed,
      )
    })
  }

  /**
   * Every active permission the member could exercise somewhere in the school.
   * Each permission is decided against an aggregate resource standing for the
   * whole school dataset, so a relationship scope answers when the member has
   * that relationship at all. Every other invariant still applies, so a school
   * wide deny exception removes the permission from the list.
   */
  async function capabilities(context: RequestContext): Promise<readonly PermissionKey[]> {
    return withTenantTransaction(pool, context, async (conn) => {
      if ((await activeState(conn, context)) === null) throw new AuthorizationError('ACCESS_DENIED')
      // Role level assurance is a property of the caller, not of one permission,
      // so the whole hint is refused rather than answered as an empty list.
      if (context.roleKeys.some((role: RoleKey) => ROLE_TEMPLATES[role].requiredMfa) && context.assurance !== 'mfa') {
        throw new AuthorizationError('MFA_REQUIRED')
      }
      const snapshot = await loadPolicySnapshotFor(conn, context.schoolId, context.membershipId)
      const facts = await loadRelationshipFactsFor(conn, context.schoolId, context.membershipId, context.now)
      return ACTIVE_PERMISSION_KEYS.filter((permission) => {
        const resourceType = PERMISSION_CATALOGUE[permission].resourceType
        const resource: ResourceReference = { schoolId: context.schoolId, resourceType, id: context.schoolId }
        return evaluate({
          context,
          permission,
          resource,
          snapshot,
          facts,
          resourceFacts: { resourceType, id: context.schoolId, aggregate: true },
        }).allowed
      })
    })
  }

  async function explainAccess(
    viewer: RequestContext,
    targetMembershipId: string,
    permission: PermissionKey,
    resource: ResourceReference,
  ): Promise<AccessExplanation> {
    return withTenantTransaction(pool, viewer, async (conn) => {
      if ((await activeState(conn, viewer)) === null) throw new AuthorizationError('ACCESS_DENIED')
      const decisionResource: ResourceReference = {
        schoolId: viewer.schoolId,
        resourceType: 'access_decision',
        id: targetMembershipId,
      }
      const viewerSnapshot = await loadPolicySnapshotFor(conn, viewer.schoolId, viewer.membershipId)
      const viewerFacts = await loadRelationshipFactsFor(conn, viewer.schoolId, viewer.membershipId, viewer.now)
      const decision = evaluate({
        context: viewer,
        permission: 'access.explain',
        resource: decisionResource,
        snapshot: viewerSnapshot,
        facts: viewerFacts,
        resourceFacts: await loadResourceFacts(conn, viewer, decisionResource),
      })
      if (!decision.allowed) throw new AuthorizationError(decision.code)

      const target = await loadMembershipStateById(conn, viewer.schoolId, targetMembershipId)
      if (!target) throw new AuthorizationError('RESOURCE_NOT_FOUND')
      // A synthetic context for the target. It is never used to serve data:
      // only the explanation of what that membership could do is returned.
      const targetContext = {
        requestId: viewer.requestId,
        userId: target.userId,
        sessionId: viewer.sessionId,
        schoolId: viewer.schoolId,
        membershipId: target.id,
        membershipKind: target.kind,
        accessVersion: target.accessVersion,
        roleKeys: await loadRoleKeys(conn, viewer.schoolId, target.id),
        assurance: 'mfa',
        mfaVerifiedAt: viewer.now,
        now: viewer.now,
      } as unknown as RequestContext

      return explain({
        context: targetContext,
        permission,
        resource,
        snapshot: await loadPolicySnapshotFor(conn, viewer.schoolId, target.id),
        facts: await loadRelationshipFactsFor(conn, viewer.schoolId, target.id, viewer.now),
        resourceFacts: await loadResourceFacts(conn, targetContext, resource),
      })
    })
  }

  async function scopeQuery(
    context: RequestContext,
    permission: PermissionKey,
    resourceType: ResourceType,
  ): Promise<AuthorizedReadPlan> {
    return withTenantTransaction(pool, context, async (conn) => {
      if ((await activeState(conn, context)) === null) throw new AuthorizationError('ACCESS_DENIED')
      const snapshot = await loadPolicySnapshotFor(conn, context.schoolId, context.membershipId)
      const facts = await loadRelationshipFactsFor(conn, context.schoolId, context.membershipId, context.now)
      return createReadPlan(context, permission, resourceType, snapshot, facts)
    })
  }

  return { authorize, scopeQuery, allowedActions, capabilities, explainAccess }
}
