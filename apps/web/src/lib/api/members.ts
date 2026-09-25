/** The member directory, invitations, role changes, lifecycle, ownership, credential recovery
 *  and the access explanation. Mirrors apps/api/src/memberships/routes.ts and
 *  apps/api/src/invitations/routes.ts. Accepting an invitation lives in lib/auth-client.ts,
 *  because the invitee has no membership yet and the route names no school. */
import {
  AccessExplanation,
  AccessExplanationQuery,
  ChangeRolesRequest,
  CreateMemberRestrictionRequest,
  InvitationActionRequest,
  InvitationListRequest,
  InvitationPage,
  InvitationSummary,
  InviteMemberRequest,
  LiftMemberRestrictionRequest,
  MemberListRequest,
  MemberRestriction,
  MemberRestrictionList,
  MemberSummary,
  MembershipActionRequest,
  MembershipDirectory,
  RestoreMembershipRequest,
  TransferOwnershipRequest,
} from '@erp/contracts'
import { z } from 'zod'
import { request } from '@/lib/http'
import { schoolPath, seg, withQuery } from './shared'

export type MemberPage = z.infer<typeof MembershipDirectory>
export type Member = z.infer<typeof MemberSummary>
export type Invitation = z.infer<typeof InvitationSummary>
export type MemberListParams = z.input<typeof MemberListRequest>
export type InviteInput = z.input<typeof InviteMemberRequest>
export type InvitationActionInput = z.input<typeof InvitationActionRequest>
export type InvitationPage = z.infer<typeof InvitationPage>
export type InvitationListParams = z.input<typeof InvitationListRequest>
export type ChangeRolesInput = z.input<typeof ChangeRolesRequest>
export type MemberActionInput = z.input<typeof MembershipActionRequest>
export type RestoreInput = z.input<typeof RestoreMembershipRequest>
export type TransferOwnershipInput = z.input<typeof TransferOwnershipRequest>
export type AccessExplanationParams = z.input<typeof AccessExplanationQuery>
export type AccessExplanationResult = z.infer<typeof AccessExplanation>
export type Restriction = z.infer<typeof MemberRestriction>
export type RestrictionList = z.infer<typeof MemberRestrictionList>
export type AddRestrictionInput = z.input<typeof CreateMemberRestrictionRequest>
export type LiftRestrictionInput = z.input<typeof LiftMemberRestrictionRequest>

/** Mirrors the inline reply of POST /members/:membershipId/recovery in memberships/routes.ts. */
const RecoveryQueued = z.strictObject({ status: z.literal('queued') })
export type RecoveryQueued = z.infer<typeof RecoveryQueued>

/** Mirrors the `liftRestriction` reply in @erp/contracts endpoints. */
const RestrictionLifted = z.strictObject({ status: z.literal('lifted') })

const members = (schoolId: string, suffix = '') => schoolPath(schoolId, `/members${suffix}`)
const invitations = (schoolId: string, suffix = '') => schoolPath(schoolId, `/invitations${suffix}`)

export function list(schoolId: string, params: MemberListParams = {}) {
  return request(withQuery(members(schoolId), { ...params }), { schema: MembershipDirectory })
}

/** Why one person can or cannot do one thing to one record, in the server's own words. */
export function accessExplanation(schoolId: string, membershipId: string, params: AccessExplanationParams) {
  return request(withQuery(members(schoolId, `/${seg(membershipId)}/access-explanation`), { ...params }), { schema: AccessExplanation })
}

// ---------- invitations ----------

/** The school's invitations, pending by default. Summaries only: no token, no digest. */
export function listInvitations(schoolId: string, params: InvitationListParams = {}) {
  return request(withQuery(invitations(schoolId), { ...params }), { schema: InvitationPage })
}

export function invite(schoolId: string, body: InviteInput) {
  return request(invitations(schoolId), { method: 'POST', body, schema: InvitationSummary })
}

export function resendInvitation(schoolId: string, invitationId: string, body: InvitationActionInput) {
  return request(invitations(schoolId, `/${seg(invitationId)}/resend`), { method: 'POST', body, schema: InvitationSummary })
}

export function revokeInvitation(schoolId: string, invitationId: string, body: InvitationActionInput) {
  return request(invitations(schoolId, `/${seg(invitationId)}/revoke`), { method: 'POST', body, schema: InvitationSummary })
}

// ---------- membership lifecycle ----------

export function changeRoles(schoolId: string, membershipId: string, body: ChangeRolesInput) {
  return request(members(schoolId, `/${seg(membershipId)}/roles`), { method: 'PUT', body, schema: MemberSummary })
}

export function suspend(schoolId: string, membershipId: string, body: MemberActionInput) {
  return request(members(schoolId, `/${seg(membershipId)}/suspend`), { method: 'POST', body, schema: MemberSummary })
}

export function remove(schoolId: string, membershipId: string, body: MemberActionInput) {
  return request(members(schoolId, `/${seg(membershipId)}/remove`), { method: 'POST', body, schema: MemberSummary })
}

/** Restoring also sets the roles the person comes back with. */
export function restore(schoolId: string, membershipId: string, body: RestoreInput) {
  return request(members(schoolId, `/${seg(membershipId)}/restore`), { method: 'POST', body, schema: MemberSummary })
}

/** Starts a password or phone recovery. Nothing about the delivery comes back. */
export function startRecovery(schoolId: string, membershipId: string, body: MemberActionInput) {
  return request(members(schoolId, `/${seg(membershipId)}/recovery`), { method: 'POST', body, schema: RecoveryQueued })
}

// ---------- restrictions ----------

/** The restrictions in force for one member, with whether the viewer may add or lift them. */
export function restrictions(schoolId: string, membershipId: string) {
  return request(members(schoolId, `/${seg(membershipId)}/restrictions`), { schema: MemberRestrictionList })
}

/** Takes one sensitive student field away from this member across the whole school. */
export function addRestriction(schoolId: string, membershipId: string, body: AddRestrictionInput) {
  return request(members(schoolId, `/${seg(membershipId)}/restrictions`), { method: 'POST', body, schema: MemberRestriction })
}

export function liftRestriction(schoolId: string, membershipId: string, restrictionId: string, body: LiftRestrictionInput) {
  return request(members(schoolId, `/${seg(membershipId)}/restrictions/${seg(restrictionId)}/lift`), { method: 'POST', body, schema: RestrictionLifted })
}

export function transferOwnership(schoolId: string, body: TransferOwnershipInput) {
  return request(schoolPath(schoolId, '/ownership/transfer'), { method: 'POST', body, schema: MemberSummary })
}
