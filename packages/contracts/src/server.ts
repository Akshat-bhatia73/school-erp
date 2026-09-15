/**
 * Server-only interfaces. These are not parsers for a client-supplied identity or policy.
 * The auth adapter is the sole producer of RequestContext after database verification.
 * No implementation here makes an authorization decision or connects to a database.
 */
import type { ErrorCode } from './errors.ts'
import type { ResourceAccessRule } from './access-rules.ts'
import type { AccessScope, PermissionKey, ResourceType } from './permissions.ts'
import type { RoleKey } from './role-templates.ts'

declare const verifiedContext: unique symbol
declare const authorizedPlan: unique symbol

export interface RequestContext {
  readonly [verifiedContext]: true
  readonly requestId: string
  readonly userId: string
  readonly sessionId: string
  readonly schoolId: string
  readonly membershipId: string
  readonly membershipKind: 'adult' | 'student'
  readonly accessVersion: number
  readonly roleKeys: readonly RoleKey[]
  readonly assurance: 'single_factor' | 'mfa'
  readonly mfaVerifiedAt: string | null
  readonly now: string
}

export interface ResourceReference {
  readonly schoolId: string
  readonly resourceType: ResourceType
  readonly id: string
}

/** Authorizer and repositories must share these predicate semantics, never a scope ranking. */
export interface PolicyGrant {
  readonly permission: PermissionKey
  readonly scope: AccessScope
}
export interface PolicySnapshot {
  readonly accessVersion: number
  readonly grants: readonly PolicyGrant[]
  readonly exceptions: readonly ResourceAccessRule[]
}

export type AuthorizationDecision =
  | { readonly allowed: true; readonly fieldGroups: readonly FieldGroup[]; readonly accessVersion: number }
  | { readonly allowed: false; readonly code: ErrorCode }

export type FieldGroup = 'student_basic' | 'student_sensitive' | 'student_medical' | 'guardian_contact'
  | 'guardian_private' | 'staff_directory' | 'staff_employment' | 'staff_private' | 'staff_pay'
  | 'document_metadata' | 'timetable' | 'audit_summary' | 'setup'

/** Opaque scoped query plan produced by the server policy implementation, never by the caller. */
export interface AuthorizedReadPlan {
  readonly [authorizedPlan]: true
  readonly schoolId: string
  readonly membershipId: string
  readonly permission: PermissionKey
  readonly resourceType: ResourceType
  readonly accessVersion: number
}

export interface AuthorizationService {
  authorize(context: RequestContext, permission: PermissionKey, resource: ResourceReference,
    requestedFieldGroups?: readonly FieldGroup[]): Promise<AuthorizationDecision>
  scopeQuery(context: RequestContext, permission: PermissionKey, resourceType: ResourceType): Promise<AuthorizedReadPlan>
  allowedActions(context: RequestContext, resource: ResourceReference): Promise<readonly PermissionKey[]>
  /** Must authorize the viewer's access.explain permission and target school before computing. */
  explainAccess(viewer: RequestContext, targetMembershipId: string, permission: PermissionKey,
    resource: ResourceReference): Promise<AccessExplanation>
}

export interface AccessExplanation {
  readonly allowed: boolean
  readonly sources: readonly {
    readonly kind: 'role' | 'relationship' | 'exception' | 'invariant'
    readonly description: string
  }[]
}

/** DB task supplies the SQL translation and same-transaction tenant context. */
export interface ScopedRepository<T> {
  list(plan: AuthorizedReadPlan, page: { page: number; pageSize: number }): Promise<{ items: readonly T[]; total: number }>
  get(plan: AuthorizedReadPlan, id: string): Promise<T | null>
}
