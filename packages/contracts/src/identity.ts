import { z } from 'zod'
import { DisplayName, Email, Id, Phone, Timestamp, Version } from './common.ts'
import { AllowedActions } from './responses.ts'
import { RoleKey } from './role-templates.ts'

export const MembershipStatus = z.enum(['active', 'suspended', 'removed'])
export type MembershipStatus = z.infer<typeof MembershipStatus>
export const MembershipKind = z.enum(['adult', 'student'])

/** Current viewer's own identity. Never use for another member's directory entry. */
export const ViewerIdentity = z.strictObject({
  id: Id,
  displayName: DisplayName,
  email: Email.optional(),
  phone: Phone.optional(),
})
export const SchoolSummary = z.strictObject({ id: Id, name: DisplayName, code: Id })
export const MembershipSummary = z.strictObject({
  id: Id,
  school: SchoolSummary,
  status: MembershipStatus,
  kind: MembershipKind,
  roleKeys: z.array(RoleKey).min(1).max(8).refine((keys) => new Set(keys).size === keys.length, 'Duplicate roles'),
  accessVersion: Version,
}).superRefine((membership, ctx) => {
  if (membership.kind === 'adult' && membership.roleKeys.includes('student')) {
    ctx.addIssue({ code: 'custom', message: 'Adult memberships cannot have a student role' })
  }
  if (membership.kind === 'student' && (membership.status === 'active' || membership.roleKeys.some((key) => key !== 'student'))) {
    ctx.addIssue({ code: 'custom', message: 'Student access is disabled and cannot carry adult roles' })
  }
})

/** No bearer token, secret, raw provider user or full global account record. */
export const SessionSummary = z.strictObject({
  expiresAt: Timestamp,
  assurance: z.enum(['single_factor', 'mfa']),
  mfaVerifiedAt: Timestamp.nullable(),
}).superRefine((session, ctx) => {
  if ((session.assurance === 'mfa') !== (session.mfaVerifiedAt !== null)) {
    ctx.addIssue({ code: 'custom', message: 'MFA assurance requires a completed verification timestamp' })
  }
})

export const MeResponse = z.strictObject({
  user: ViewerIdentity,
  session: SessionSummary,
  memberships: z.array(MembershipSummary),
})

/** Navigation hints only: no record-level authorization may rely on this response. */
export const SchoolContextResponse = z.strictObject({
  school: SchoolSummary,
  membershipId: Id,
  accessVersion: Version,
  roleKeys: z.array(RoleKey).max(8),
  capabilities: AllowedActions,
  studentLoginEnabled: z.literal(false),
})

export const LOGIN_METHODS = {
  administration: { enabled: true, methods: ['email_password'], requiresMfa: true },
  teacher: { enabled: true, methods: ['email_password', 'phone_otp'], requiresMfa: 'when_privileged' },
  parent: { enabled: true, methods: ['phone_otp'], requiresMfa: 'when_privileged' },
  student: { enabled: false, methods: [] },
} as const

export type MeResponse = z.infer<typeof MeResponse>
export type SchoolContextResponse = z.infer<typeof SchoolContextResponse>
