/** The member directory, invitations, role changes, lifecycle, ownership, credential recovery
 *  and the access explanation. Mirrors apps/api/src/memberships/routes.ts and
 *  apps/api/src/invitations/routes.ts. Accepting an invitation lives in lib/auth-client.ts,
 *  because the invitee has no membership yet and the route names no school. */
import {
  AccessExplanation,
  AccessExplanationQuery,
  ChangeRolesRequest,
  InvitationActionRequest,
  InvitationListRequest,
  InvitationPage,
  InvitationSummary,
  InviteMemberRequest,
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
export type MemberListParams = { page?: number; pageSize?: number }
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

/** Mirrors the inline reply of POST /members/:membershipId/recovery in memberships/routes.ts. */
const RecoveryQueued = z.strictObject({ status: z.literal('queued') })
export type RecoveryQueued = z.infer<typeof RecoveryQueued>

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

export function transferOwnership(schoolId: string, body: TransferOwnershipInput) {
  return request(schoolPath(schoolId, '/ownership/transfer'), { method: 'POST', body, schema: MemberSummary })
}
