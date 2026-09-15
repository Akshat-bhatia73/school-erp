import { z } from 'zod'
import { ContactIdentifier, DisplayName, Id, Reason, Timestamp, Version } from './common.ts'
import { MembershipStatus } from './identity.ts'
import { RoleKey } from './role-templates.ts'

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
