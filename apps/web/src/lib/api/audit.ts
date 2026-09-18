/** The audit log and its export. Mirrors apps/api/src/modules/audit/routes.ts. */
import { AuditEventListRequest, AuditEventPage, AuditExportJob, AuditExportRequest, RedactAuditNoteRequest } from '@erp/contracts'
import type { z } from 'zod'
import { request } from '@/lib/http'
import { schoolPath, seg, withQuery } from './shared'

export type AuditListParams = z.input<typeof AuditEventListRequest>
export type AuditPage = z.infer<typeof AuditEventPage>
export type AuditEvent = AuditPage['items'][number]
export type AuditExportInput = z.input<typeof AuditExportRequest>
export type RedactNoteInput = z.input<typeof RedactAuditNoteRequest>

export function list(schoolId: string, params: AuditListParams = {}) {
  return request(withQuery(schoolPath(schoolId, '/audit-events'), { ...params }), { schema: AuditEventPage })
}

/** Queues an export of one window; poll it through api.files.exportJob. */
export function exportEvents(schoolId: string, body: AuditExportInput) {
  return request(schoolPath(schoolId, '/audit-events/export'), { method: 'POST', body, schema: AuditExportJob })
}

/** Removes the note text from one entry. The entry itself always stays. */
export async function redactNote(schoolId: string, eventId: string, body: RedactNoteInput): Promise<void> {
  await request(schoolPath(schoolId, `/audit-events/${seg(eventId)}/note/redact`), { method: 'POST', body })
}
