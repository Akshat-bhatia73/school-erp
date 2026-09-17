/** The audit log and its export. Mirrors apps/api/src/modules/audit/routes.ts. */
import { AuditEventListRequest, AuditEventPage, AuditExportJob, AuditExportRequest } from '@erp/contracts'
import type { z } from 'zod'
import { request } from '@/lib/http'
import { schoolPath, withQuery } from './shared'

export type AuditListParams = z.input<typeof AuditEventListRequest>
export type AuditPage = z.infer<typeof AuditEventPage>
export type AuditEvent = AuditPage['items'][number]
export type AuditExportInput = z.input<typeof AuditExportRequest>

export function list(schoolId: string, params: AuditListParams = {}) {
  return request(withQuery(schoolPath(schoolId, '/audit-events'), { ...params }), { schema: AuditEventPage })
}

/** Queues an export of one window; poll it through api.files.exportJob. */
export function exportEvents(schoolId: string, body: AuditExportInput) {
  return request(schoolPath(schoolId, '/audit-events/export'), { method: 'POST', body, schema: AuditExportJob })
}
