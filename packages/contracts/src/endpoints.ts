import { z } from 'zod'
import { Id, MemberParams, SchoolParams, pageOf } from './common.ts'
import { MeResponse, SchoolContextResponse } from './identity.ts'
import {
  AcceptInvitationRequest, ChangeRolesRequest, InvitationActionRequest, InvitationListRequest,
  InvitationPage, InvitationSummary, InviteMemberRequest, MemberSummary, MembershipActionRequest, RestoreMembershipRequest, TransferOwnershipRequest,
} from './memberships.ts'
import { PERMISSION_CATALOGUE, PermissionKey, ResourceType } from './permissions.ts'

interface EndpointContract {
  method: 'GET' | 'POST' | 'PUT'
  path: string
  auth: 'session' | 'membership' | 'verified_invitee'
  permission?: PermissionKey
  params?: z.ZodType
  body?: z.ZodType
  query?: z.ZodType
  additionalPermissions?: readonly PermissionKey[]
  response: z.ZodType
  successStatus: number
}
const InvitationParams = z.strictObject({ schoolId: Id, invitationId: Id })
export const AccessExplanation = z.strictObject({
  allowed: z.boolean(),
  sources: z.array(z.strictObject({
    kind: z.enum(['role', 'relationship', 'exception', 'invariant']), description: z.string().max(500),
  })),
})
export const AccessExplanationQuery = z.strictObject({
  permission: PermissionKey, resourceType: ResourceType, resourceId: Id,
}).refine((v) => PERMISSION_CATALOGUE[v.permission].resourceType === v.resourceType,
  'Resource type does not match the permission')

/** Frozen application route contracts. Auth-provider routes are separately mounted in Task 2. */
export const ACCESS_ENDPOINTS = {
  me: { method: 'GET', path: '/api/me', auth: 'session', response: MeResponse, successStatus: 200 },
  context: { method: 'GET', path: '/api/schools/:schoolId/context', auth: 'membership', params: SchoolParams, response: SchoolContextResponse, successStatus: 200 },
  members: { method: 'GET', path: '/api/schools/:schoolId/members', auth: 'membership', permission: 'members.read', params: SchoolParams, response: pageOf(MemberSummary), successStatus: 200 },
  invite: { method: 'POST', path: '/api/schools/:schoolId/invitations', auth: 'membership', permission: 'members.invite', additionalPermissions: ['roles.assign'], params: SchoolParams, body: InviteMemberRequest, response: InvitationSummary, successStatus: 201 },
  invitations: { method: 'GET', path: '/api/schools/:schoolId/invitations', auth: 'membership', permission: 'members.invite', params: SchoolParams, query: InvitationListRequest, response: InvitationPage, successStatus: 200 },
  acceptInvite: { method: 'POST', path: '/api/invitations/accept', auth: 'verified_invitee', body: AcceptInvitationRequest, response: MemberSummary, successStatus: 200 },
  resendInvite: { method: 'POST', path: '/api/schools/:schoolId/invitations/:invitationId/resend', auth: 'membership', permission: 'members.invite', additionalPermissions: ['roles.assign'], params: InvitationParams, body: InvitationActionRequest, response: InvitationSummary, successStatus: 200 },
  revokeInvite: { method: 'POST', path: '/api/schools/:schoolId/invitations/:invitationId/revoke', auth: 'membership', permission: 'members.invite', params: InvitationParams, body: InvitationActionRequest, response: InvitationSummary, successStatus: 200 },
  changeRoles: { method: 'PUT', path: '/api/schools/:schoolId/members/:membershipId/roles', auth: 'membership', permission: 'roles.assign', params: MemberParams, body: ChangeRolesRequest, response: MemberSummary, successStatus: 200 },
  suspend: { method: 'POST', path: '/api/schools/:schoolId/members/:membershipId/suspend', auth: 'membership', permission: 'members.suspend', params: MemberParams, body: MembershipActionRequest, response: MemberSummary, successStatus: 200 },
  remove: { method: 'POST', path: '/api/schools/:schoolId/members/:membershipId/remove', auth: 'membership', permission: 'members.remove', params: MemberParams, body: MembershipActionRequest, response: MemberSummary, successStatus: 200 },
  restore: { method: 'POST', path: '/api/schools/:schoolId/members/:membershipId/restore', auth: 'membership', permission: 'members.restore', additionalPermissions: ['roles.assign'], params: MemberParams, body: RestoreMembershipRequest, response: MemberSummary, successStatus: 200 },
  transferOwnership: { method: 'POST', path: '/api/schools/:schoolId/ownership/transfer', auth: 'membership', permission: 'ownership.transfer', params: SchoolParams, body: TransferOwnershipRequest, response: MemberSummary, successStatus: 200 },
  explain: { method: 'GET', path: '/api/schools/:schoolId/members/:membershipId/access-explanation', auth: 'membership', permission: 'access.explain', params: MemberParams, query: AccessExplanationQuery, response: AccessExplanation, successStatus: 200 },
  recovery: { method: 'POST', path: '/api/schools/:schoolId/members/:membershipId/recovery', auth: 'membership', permission: 'members.manage_credentials', params: MemberParams, body: MembershipActionRequest, response: z.strictObject({ status: z.literal('queued') }), successStatus: 202 },
} as const satisfies Record<string, EndpointContract>
