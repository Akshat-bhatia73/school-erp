import { z } from 'zod'
import { Id, TenantRecord } from './common'

export const AuditAction = z.enum(['create', 'update', 'delete', 'import', 'promote', 'login', 'export', 'send'])
export type AuditAction = z.infer<typeof AuditAction>

export const AuditEntity = z.enum([
  'school',
  'academic_year',
  'grade',
  'section',
  'subject',
  'holiday',
  'student',
  'guardian',
  'enrollment',
  'staff',
  'user',
  'role',
  'document',
])
export type AuditEntity = z.infer<typeof AuditEntity>

export const AuditLog = TenantRecord.extend({
  actorUserId: Id,
  actorName: z.string(),
  action: AuditAction,
  entity: AuditEntity,
  entityId: Id.optional(),
  /** Human readable, e.g. "Added student Aarav Sharma to Class 6 - A" */
  summary: z.string(),
  /** Field-level diff for updates */
  changes: z
    .array(
      z.object({
        field: z.string(),
        from: z.unknown().optional(),
        to: z.unknown().optional(),
      }),
    )
    .optional(),
  /** "web" | "desktop" | "mobile" | "assistant" */
  via: z.enum(['web', 'desktop', 'mobile', 'assistant', 'system']).default('web'),
  ipAddress: z.string().optional(),
})
export type AuditLog = z.infer<typeof AuditLog>
