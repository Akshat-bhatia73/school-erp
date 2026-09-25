import { z } from 'zod'
import { Id, Reason, Timestamp, Version } from './common.ts'
import { PERMISSION_CATALOGUE, PermissionKey } from './permissions.ts'

/** Closed target types. Add new targets only with a same-school FK and query implementation. */
export const AccessRuleTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('school') }),
  z.strictObject({ kind: z.literal('section'), sectionId: Id, academicYearId: Id }),
  z.strictObject({ kind: z.literal('student'), studentId: Id }),
  z.strictObject({ kind: z.literal('staff'), staffId: Id }),
  z.strictObject({ kind: z.literal('document'), documentId: Id }),
])
export type AccessRuleTarget = z.infer<typeof AccessRuleTarget>

/** Deliberately narrow first extension. Schema support does not expose a management endpoint. */
export const RESOURCE_RULE_PERMISSIONS = {
  school: [
    'students.read_basic', 'students.export', 'staff.read_directory',
    'students.read_sensitive', 'students.read_guardians', 'students.read_medical',
  ],
  section: ['students.read_basic', 'students.export', 'timetable.read'],
  student: ['students.read_basic'],
  staff: ['staff.read_directory'],
  document: ['students.read_documents', 'students.download_documents'],
} as const satisfies Record<AccessRuleTarget['kind'], readonly z.infer<typeof PermissionKey>[]>

/**
 * What a member restriction may take away (September 2026). A restriction is a
 * deny rule on the whole school; an allow for these keys is never accepted, so
 * a rule can only ever narrow what a role already gives.
 */
// The guardian contact projection (`students.read_guardian_contact`) is not
// restrictable on its own: anyone holding full guardian records reads the
// phone there too, so hiding the contact card alone would promise more than it
// does. Staff who call families keep it.
export const RESTRICTABLE_PERMISSIONS = [
  'students.read_sensitive',
  'students.read_guardians',
  'students.read_medical',
] as const satisfies readonly z.infer<typeof PermissionKey>[]
export const RestrictablePermission = z.enum(RESTRICTABLE_PERMISSIONS)
export type RestrictablePermission = z.infer<typeof RestrictablePermission>

export const ResourceAccessRule = z.strictObject({
  id: Id,
  schoolId: Id,
  membershipId: Id,
  permission: PermissionKey,
  effect: z.enum(['allow', 'deny']),
  target: AccessRuleTarget,
  validFrom: Timestamp,
  expiresAt: Timestamp.nullable(),
  revokedAt: Timestamp.nullable(),
  reason: Reason,
  createdByMembershipId: Id,
  version: Version,
}).superRefine((rule, ctx) => {
  const supported: readonly string[] = RESOURCE_RULE_PERMISSIONS[rule.target.kind]
  if (!supported.includes(rule.permission) || PERMISSION_CATALOGUE[rule.permission].availability !== 'active') {
    ctx.addIssue({ code: 'custom', path: ['permission'], message: 'Unsupported permission for this target' })
  }
  if (rule.effect === 'allow' && (RESTRICTABLE_PERMISSIONS as readonly string[]).includes(rule.permission)) {
    ctx.addIssue({ code: 'custom', path: ['effect'], message: 'This permission can only be restricted' })
  }
  if (rule.expiresAt !== null && Date.parse(rule.expiresAt) <= Date.parse(rule.validFrom)) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Expiry must be after the start' })
  }
})
export type ResourceAccessRule = z.infer<typeof ResourceAccessRule>
