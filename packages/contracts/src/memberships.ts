import { z } from 'zod'
import { ContactIdentifier, DisplayName, Id, PageRequest, Reason, Timestamp, Version, pageOf } from './common.ts'
import { MembershipStatus } from './identity.ts'
import { RoleKey } from './role-templates.ts'
import { RestrictablePermission } from './access-rules.ts'
import { AllowedActions } from './responses.ts'

/** Ownership has its own transfer flow. Student activation and custom roles are deferred. */
export const AssignableRoleKey = RoleKey.exclude(['owner', 'student'])
export const AssignedRoleKeys = z.array(AssignableRoleKey).min(1).max(5).refine(
  (roles) => new Set(roles).size === roles.length,
  'Duplicate roles are not allowed',
)

export const InviteMemberRequest = z.strictObject({
  displayName: DisplayName,
  identifier: ContactIdentifier,
  roleKeys: AssignedRoleKeys,
  staffId: Id.optional(),
}).superRefine((input, ctx) => {
  if (input.roleKeys.some((role) => role !== 'parent') && !input.staffId) {
    ctx.addIssue({ code: 'custom', path: ['staffId'], message: 'Staff roles require an existing staff profile' })
  }
})
export type InviteMemberRequest = z.infer<typeof InviteMemberRequest>

export const ChangeRolesRequest = z.strictObject({
  roleKeys: AssignedRoleKeys,
  expectedVersion: Version,
  reason: Reason,
})
export const MembershipActionRequest = z.strictObject({ expectedVersion: Version, reason: Reason })
export const RestoreMembershipRequest = ChangeRolesRequest
export const TransferOwnershipRequest = z.strictObject({
  targetMembershipId: Id,
  expectedSchoolAccessVersion: Version,
  reason: Reason,
})

export const InvitationStatus = z.enum(['pending', 'accepted', 'revoked', 'expired'])
export type InvitationStatus = z.infer<typeof InvitationStatus>
export const DeliveryStatus = z.enum(['queued', 'sent', 'failed'])

export const InvitationSummary = z.strictObject({
  id: Id,
  schoolId: Id,
  displayName: DisplayName,
  maskedDestination: z.string().min(1).max(254),
  roleKeys: AssignedRoleKeys,
  status: InvitationStatus,
  deliveryStatus: DeliveryStatus,
  expiresAt: Timestamp,
  version: Version,
})

export const InvitationListRequest = PageRequest.extend({
  status: InvitationStatus.default('pending'),
})
export type InvitationListRequest = z.infer<typeof InvitationListRequest>

export const InvitationPage = pageOf(InvitationSummary)

/** Single-use bearer input: never put in logs, summary responses or query strings. */
export const AcceptInvitationRequest = z.strictObject({ token: z.string().min(32).max(512) })
export const InvitationActionRequest = z.strictObject({ expectedVersion: Version })

export const MemberSummary = z.strictObject({
  id: Id,
  schoolId: Id,
  displayName: DisplayName,
  status: MembershipStatus,
  roleKeys: z.array(RoleKey).min(1).max(8),
  staffId: Id.optional(),
  accessVersion: Version,
})

/**
 * The member directory filters. Each one narrows the rows `members.read`
 * already allows and is applied by the query, so the total and the pages are
 * the filtered ones. `search` matches the name the directory shows; `staffId`
 * finds the login of one staff record without paging the whole directory.
 */
export const MemberListRequest = PageRequest.extend({
  search: z.string().trim().min(1).max(100).optional(),
  role: RoleKey.optional(),
  status: MembershipStatus.optional(),
  staffId: Id.regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/).optional(),
})
export type MemberListRequest = z.infer<typeof MemberListRequest>

/** Transition shapes are contracts, not authority to perform these actions. */
export const MEMBERSHIP_TRANSITIONS = [
  { from: 'active', event: 'suspend', to: 'suspended' },
  { from: 'active', event: 'remove', to: 'removed' },
  { from: 'suspended', event: 'remove', to: 'removed' },
  { from: 'suspended', event: 'restore', to: 'active' },
  { from: 'removed', event: 'restore', to: 'active' },
] as const satisfies readonly { from: z.infer<typeof MembershipStatus>; event: string; to: z.infer<typeof MembershipStatus> }[]

export const INVITATION_TRANSITIONS = [
  { from: 'pending', event: 'accept', to: 'accepted' },
  { from: 'pending', event: 'revoke', to: 'revoked' },
  { from: 'pending', event: 'expire', to: 'expired' },
  { from: 'pending', event: 'resend', to: 'pending' },
] as const satisfies readonly { from: InvitationStatus; event: string; to: InvitationStatus }[]

/**
 * A member restriction: an owner or principal takes one sensitive student
 * field away from one member across the whole school, whatever their roles
 * give (September 2026). Stored as a school-wide deny rule, so every read,
 * list, export and reveal honours it through the ordinary decision. The
 * reason is shown only to people who may manage restrictions.
 */
export const MemberRestriction = z.strictObject({
  id: Id,
  permission: RestrictablePermission,
  reason: Reason,
  startsAt: Timestamp,
  /** Null when it lasts until someone lifts it. */
  expiresAt: Timestamp.nullable(),
  createdBy: z.strictObject({ membershipId: Id, displayName: DisplayName }),
  createdAt: Timestamp,
  version: Version,
})
export type MemberRestriction = z.infer<typeof MemberRestriction>

/** The restrictions in force for one member: not lifted and not past their end. */
export const MemberRestrictionList = z.strictObject({
  items: z.array(MemberRestriction).max(20),
  /** `access.manage` when the viewer may add or lift restrictions on this member. */
  allowedActions: AllowedActions,
})
export type MemberRestrictionList = z.infer<typeof MemberRestrictionList>

/**
 * `expectedAccessVersion` is the target's `MemberSummary.accessVersion`, so a
 * restriction is never added on top of access the actor has not seen.
 */
export const CreateMemberRestrictionRequest = z.strictObject({
  permission: RestrictablePermission,
  reason: Reason,
  expiresAt: Timestamp.optional(),
  expectedAccessVersion: Version,
})
export type CreateMemberRestrictionRequest = z.infer<typeof CreateMemberRestrictionRequest>

export const LiftMemberRestrictionRequest = z.strictObject({
  expectedVersion: Version,
  reason: Reason,
})
export type LiftMemberRestrictionRequest = z.infer<typeof LiftMemberRestrictionRequest>
