/** Task 5 request and response contracts owned by the audit module. */
import { z } from 'zod'
import { Id, PageRequest, Timestamp } from './common.ts'

/**
 * A membership id as this database actually stores it. `Id` deliberately
 * accepts migrated identifiers of any shape, but the audit filter is compared
 * against a uuid column, so a value that is not a uuid is bad input and must
 * be refused here as 400 rather than blowing up the query as 503.
 */
export const AuditMembershipId = Id.regex(
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
)

/**
 * The audit list filters. Every one of them narrows the rows the read plan
 * already allows; none of them can widen it, so a filter is never a way to
 * ask for somebody else's school or a field the projection drops.
 */
export const AuditEventListRequest = PageRequest.extend({
  actorMembershipId: AuditMembershipId.optional(),
  action: z.string().trim().min(1).max(100).optional(),
  from: Timestamp.optional(),
  to: Timestamp.optional(),
  // The two outcomes a summary carries. `denied` is every row that was not
  // allowed, which is how the projection reports a failed write as well.
  outcome: z.enum(['allowed', 'denied']).optional(),
})

/**
 * An export names only a window. The rows it counts are the rows the caller
 * could already read one by one, and the window is capped at a year so a
 * single request cannot walk the whole history of a school.
 */
export const AuditExportRequest = z.strictObject({
  from: Timestamp,
  to: Timestamp,
})

/** The longest window one export may cover, in days. */
export const AUDIT_EXPORT_MAX_DAYS = 366

export type AuditEventListRequest = z.infer<typeof AuditEventListRequest>
export type AuditExportRequest = z.infer<typeof AuditExportRequest>

/**
 * The audit actions a finance audience may read.
 *
 * `audit.read` and `audit.export` at the `finance` scope select only audit
 * rows whose action is in this list, so an accountant reads the money trail
 * of the school and nothing else. Membership, role, invitation, student and
 * setup actions are deliberately absent. The fee actions join this list when
 * the fees module lands; until then the list is exactly what the API writes
 * today that an accountant is concerned with.
 */
export const FINANCE_AUDIT_ACTIONS = [
  'staff.update_pay',
  'staff.export',
  'audit.export',
] as const

export type FinanceAuditAction = (typeof FINANCE_AUDIT_ACTIONS)[number]

/** Whether one audit action belongs to the finance audience. */
export function isFinanceAuditAction(action: string): action is FinanceAuditAction {
  return (FINANCE_AUDIT_ACTIONS as readonly string[]).includes(action)
}
