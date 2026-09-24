/** Messages: the inbox, the messages a person or the school sent, templates and the automatic messages. Mirrors apps/api/src/modules/communication. */
import {
  AudienceOptions,
  AudiencePreview,
  CommunicationSettings,
  InboxList,
  MarkReadResponse,
  MessageDetail,
  MessageExportJob,
  MessageList,
  MessageRecipientList,
  MessageTemplate,
  MessageTemplateList,
  UnreadCount,
  type ArchiveMessageTemplateRequest,
  type CreateMessageRequest,
  type CreateMessageTemplateRequest,
  type InboxQuery,
  type MessageAudienceInput,
  type MessageListQuery,
  type MessageRecipientQuery,
  type MessageTemplateQuery,
  type SendMessageRequest,
  type UpdateCommunicationSettingsRequest,
  type UpdateMessageRequest,
  type UpdateMessageTemplateRequest,
  type WithdrawMessageRequest,
} from '@erp/contracts'
import type { z } from 'zod'
import { ApiRequestError, request } from '@/lib/http'
import { schoolPath, seg, withQuery } from './shared'

export type InboxPage = z.infer<typeof InboxList>
export type InboxRow = InboxPage['items'][number]
export type MessagePage = z.infer<typeof MessageList>
export type MessageRow = MessagePage['items'][number]
export type MessageRecord = z.infer<typeof MessageDetail>
export type RecipientPage = z.infer<typeof MessageRecipientList>
export type RecipientRow = RecipientPage['items'][number]
export type AudienceChoices = z.infer<typeof AudienceOptions>
export type AudienceCount = z.infer<typeof AudiencePreview>
export type TemplateRecord = z.infer<typeof MessageTemplate>
export type SettingsRecord = z.infer<typeof CommunicationSettings>

const base = (schoolId: string, suffix = '') => schoolPath(schoolId, `/messages${suffix}`)
const one = (schoolId: string, messageId: string, suffix = '') => base(schoolId, `/${seg(messageId)}${suffix}`)

// ---------- the inbox ----------

export function inbox(schoolId: string, params: Partial<InboxQuery> = {}) {
  return request(withQuery(base(schoolId, '/inbox'), { ...params }), { schema: InboxList })
}

/** The badge in the navigation. The server also starts the school's message pump on this read. */
export function unread(schoolId: string) {
  return request(base(schoolId, '/inbox/unread'), { schema: UnreadCount })
}

export function markRead(schoolId: string, recipientId: string) {
  return request(base(schoolId, `/inbox/${seg(recipientId)}/read`), { method: 'POST', schema: MarkReadResponse })
}

// ---------- messages ----------

export function list(schoolId: string, params: Partial<MessageListQuery> = {}) {
  return request(withQuery(base(schoolId), { ...params }), { schema: MessageList })
}

export function get(schoolId: string, messageId: string) {
  return request(one(schoolId, messageId), { schema: MessageDetail })
}

export function recipients(schoolId: string, messageId: string, params: Partial<MessageRecipientQuery> = {}) {
  return request(withQuery(one(schoolId, messageId, '/recipients'), { ...params }), { schema: MessageRecipientList })
}

export function audiences(schoolId: string) {
  return request(base(schoolId, '/audiences'), { schema: AudienceOptions })
}

export function audiencePreview(schoolId: string, audience: MessageAudienceInput) {
  return request(base(schoolId, '/audience-preview'), { method: 'POST', body: { audience }, schema: AudiencePreview })
}

export function create(schoolId: string, body: CreateMessageRequest) {
  return request(base(schoolId), { method: 'POST', body, schema: MessageDetail })
}

export function update(schoolId: string, messageId: string, body: UpdateMessageRequest) {
  return request(one(schoolId, messageId), { method: 'PATCH', body, schema: MessageDetail })
}

/** A draft only. The version travels in the query string because a DELETE has no body. */
export function remove(schoolId: string, messageId: string, expectedVersion: number) {
  return request(withQuery(one(schoolId, messageId), { expectedVersion }), { method: 'DELETE' })
}

/** Send now, or schedule it when `sendAt` is set. */
export function send(schoolId: string, messageId: string, body: SendMessageRequest) {
  return request(one(schoolId, messageId, '/send'), { method: 'POST', body, schema: MessageDetail })
}

export function unschedule(schoolId: string, messageId: string, expectedVersion: number) {
  return request(one(schoolId, messageId, '/unschedule'), { method: 'POST', body: { expectedVersion }, schema: MessageDetail })
}

export function withdraw(schoolId: string, messageId: string, body: WithdrawMessageRequest) {
  return request(one(schoolId, messageId, '/withdraw'), { method: 'POST', body, schema: MessageDetail })
}

export function exportDelivery(schoolId: string, messageId: string) {
  return request(one(schoolId, messageId, '/export'), { method: 'POST', schema: MessageExportJob })
}

// ---------- attachments ----------

/**
 * An answer that is not ok carries the usual failure envelope. The named reason is kept, so a
 * refused file says why ("at most 2 MB") instead of a general sentence. A plain 413 from the
 * size check before the body is read has no envelope.
 */
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
    message = 'A file can be at most 2 MB.'
    reason = 'message_attachment_too_large' as ApiRequestError['reason']
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

/**
 * One file, sent as raw bytes like a photograph. The file name and the version travel in the
 * query string; the answer is the message with the file on it.
 */
export async function addAttachment(schoolId: string, messageId: string, file: File, expectedVersion: number) {
  const response = await fetchOrFail(withQuery(one(schoolId, messageId, '/attachments'), { expectedVersion, fileName: file.name }), {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  })
  const parsed = MessageDetail.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new ApiRequestError({ code: 'UNEXPECTED_RESPONSE', status: response.status, message: 'Something went wrong. Please try again.' })
  return parsed.data
}

export function removeAttachment(schoolId: string, messageId: string, attachmentId: string, expectedVersion: number) {
  return request(withQuery(one(schoolId, messageId, `/attachments/${seg(attachmentId)}`), { expectedVersion }), { method: 'DELETE', schema: MessageDetail })
}

/** `filename="notice.pdf"` -> `notice.pdf`. A header we cannot read falls back to a neutral name. */
export function fileNameFrom(disposition: string | null, fallback = 'attachment'): string {
  if (!disposition) return fallback
  const quoted = /filename="([^"]+)"/.exec(disposition)
  if (quoted?.[1]) return quoted[1]
  const bare = /filename=([^;]+)/.exec(disposition)
  return bare?.[1]?.trim() || fallback
}

export async function downloadAttachment(schoolId: string, messageId: string, attachmentId: string) {
  const response = await fetchOrFail(one(schoolId, messageId, `/attachments/${seg(attachmentId)}`), {})
  return { blob: await response.blob(), fileName: fileNameFrom(response.headers.get('content-disposition')) }
}

// ---------- templates ----------

export function templates(schoolId: string, params: Partial<MessageTemplateQuery> = {}) {
  return request(withQuery(base(schoolId, '/templates'), { ...params }), { schema: MessageTemplateList })
}

export function createTemplate(schoolId: string, body: CreateMessageTemplateRequest) {
  return request(base(schoolId, '/templates'), { method: 'POST', body, schema: MessageTemplate })
}

export function updateTemplate(schoolId: string, templateId: string, body: UpdateMessageTemplateRequest) {
  return request(base(schoolId, `/templates/${seg(templateId)}`), { method: 'PATCH', body, schema: MessageTemplate })
}

export function archiveTemplate(schoolId: string, templateId: string, body: ArchiveMessageTemplateRequest) {
  return request(base(schoolId, `/templates/${seg(templateId)}/archive`), { method: 'POST', body, schema: MessageTemplate })
}

// ---------- automatic messages ----------

export function settings(schoolId: string) {
  return request(base(schoolId, '/settings'), { schema: CommunicationSettings })
}

export function saveSettings(schoolId: string, body: UpdateCommunicationSettingsRequest) {
  return request(base(schoolId, '/settings'), { method: 'PUT', body, schema: CommunicationSettings })
}
