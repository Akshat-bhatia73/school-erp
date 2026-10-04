/**
 * Homework: the items a section is set, their files, the check-off sheet and the report.
 * Mirrors apps/api/src/modules/homework. A write answers with the item (or the sheet), so a screen
 * can show the new version without another read.
 */
import {
  HomeworkCheckSheet,
  HomeworkDetail,
  HomeworkExportJob,
  HomeworkListResponse,
  HomeworkReportResponse,
  type HomeworkCheckSaveRequest,
  type HomeworkCreateRequest,
  type HomeworkListRequest,
  type HomeworkRemoveRequest,
  type HomeworkReportExportRequest,
  type HomeworkReportRequest,
  type HomeworkUpdateRequest,
} from '@erp/contracts'
import type { z } from 'zod'
import { ApiRequestError, request } from '@/lib/http'
import { fileNameFrom } from './messages'
import { schoolPath, seg, withQuery } from './shared'

export type HomeworkListParams = z.input<typeof HomeworkListRequest>
export type HomeworkList = z.infer<typeof HomeworkListResponse>
export type HomeworkRow = HomeworkList['items'][number]
export type HomeworkRecord = z.infer<typeof HomeworkDetail>
export type HomeworkSheet = z.infer<typeof HomeworkCheckSheet>
export type HomeworkSheetRow = HomeworkSheet['rows'][number]
export type HomeworkReport = z.infer<typeof HomeworkReportResponse>
export type HomeworkReportParams = z.input<typeof HomeworkReportRequest>
export type HomeworkCreateInput = z.input<typeof HomeworkCreateRequest>
export type HomeworkUpdateInput = z.input<typeof HomeworkUpdateRequest>
export type HomeworkRemoveInput = z.input<typeof HomeworkRemoveRequest>
export type HomeworkCheckSaveInput = z.input<typeof HomeworkCheckSaveRequest>
export type HomeworkReportExportInput = z.input<typeof HomeworkReportExportRequest>

const base = (schoolId: string, suffix = '') => schoolPath(schoolId, `/homework${suffix}`)
const one = (schoolId: string, homeworkId: string, suffix = '') => base(schoolId, `/${seg(homeworkId)}${suffix}`)

export function list(schoolId: string, params: HomeworkListParams = {}) {
  return request(withQuery(base(schoolId), { ...params }), { schema: HomeworkListResponse })
}

export function get(schoolId: string, homeworkId: string) {
  return request(one(schoolId, homeworkId), { schema: HomeworkDetail })
}

/** The server sets the day it was set (today in the school's timezone). Files go up after, one each. */
export function create(schoolId: string, body: HomeworkCreateInput) {
  return request(base(schoolId), { method: 'POST', body, schema: HomeworkDetail })
}

/** The words or the due date; never the section or the subject. */
export function update(schoolId: string, homeworkId: string, body: HomeworkUpdateInput) {
  return request(one(schoolId, homeworkId), { method: 'PATCH', body, schema: HomeworkDetail })
}

/** Removing is for good: families stop seeing it, and it stays on the record for the school. */
export function remove(schoolId: string, homeworkId: string, body: HomeworkRemoveInput) {
  return request(one(schoolId, homeworkId, '/remove'), { method: 'POST', body, schema: HomeworkDetail })
}

// ---------- files ----------

async function failureOf(response: Response): Promise<ApiRequestError> {
  let code: ApiRequestError['code'] = 'UNEXPECTED_RESPONSE'
  let message = 'Something went wrong. Please try again.'
  let reason: ApiRequestError['reason']
  try {
    const payload = (await response.json()) as { error?: { code?: string; message?: string; reason?: string } }
    if (payload.error?.code) {
      code = payload.error.code as ApiRequestError['code']
      message = payload.error.message ?? message
      reason = payload.error.reason as ApiRequestError['reason']
    }
  } catch {
    // A failure with no envelope is still a failure; the default message stands.
  }
  if (response.status === 413 && reason === undefined) {
    code = 'INVALID_REQUEST'
    message = 'A file can be up to 4 MB.'
    reason = 'homework_attachment_too_large'
  }
  return new ApiRequestError({ code, status: response.status, message, reason })
}

async function fetchOrFail(path: string, init: RequestInit): Promise<Response> {
  let response: Response
  try {
    response = await fetch(path, { ...init, credentials: 'same-origin' })
  } catch {
    throw new ApiRequestError({ code: 'NETWORK_ERROR', status: 0, message: 'We could not reach the server. Check your connection and try again.' })
  }
  if (!response.ok) throw await failureOf(response)
  return response
}

/** One file as raw bytes; the file name and the version travel in the query string. Answers with the item. */
export async function addAttachment(schoolId: string, homeworkId: string, file: File, expectedVersion: number) {
  const response = await fetchOrFail(withQuery(one(schoolId, homeworkId, '/attachments'), { expectedVersion, fileName: file.name }), {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  })
  const parsed = HomeworkDetail.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new ApiRequestError({ code: 'UNEXPECTED_RESPONSE', status: response.status, message: 'Something went wrong. Please try again.' })
  return parsed.data
}

/** A DELETE has no body, so the version travels in the query string. */
export function removeAttachment(schoolId: string, homeworkId: string, attachmentId: string, expectedVersion: number) {
  return request(withQuery(one(schoolId, homeworkId, `/attachments/${seg(attachmentId)}`), { expectedVersion }), { method: 'DELETE', schema: HomeworkDetail })
}

/** The bytes, decided again by the server on every request. */
export async function downloadAttachment(schoolId: string, homeworkId: string, attachmentId: string) {
  const response = await fetchOrFail(one(schoolId, homeworkId, `/attachments/${seg(attachmentId)}`), {})
  return { blob: await response.blob(), fileName: fileNameFrom(response.headers.get('content-disposition'), 'homework') }
}

// ---------- check-off sheet ----------

export function checks(schoolId: string, homeworkId: string) {
  return request(one(schoolId, homeworkId, '/checks'), { schema: HomeworkCheckSheet })
}

/** The changed lines only, in one write. Answers with the sheet as saved. */
export function saveChecks(schoolId: string, homeworkId: string, body: HomeworkCheckSaveInput) {
  return request(one(schoolId, homeworkId, '/checks'), { method: 'PUT', body, schema: HomeworkCheckSheet })
}

// ---------- report ----------

export function report(schoolId: string, params: HomeworkReportParams) {
  return request(withQuery(base(schoolId, '/report'), { ...params }), { schema: HomeworkReportResponse })
}

/** The same report as an Excel file, through the exports module. */
export function exportReport(schoolId: string, body: HomeworkReportExportInput) {
  return request(base(schoolId, '/report/export'), { method: 'POST', body, schema: HomeworkExportJob })
}
