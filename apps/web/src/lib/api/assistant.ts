/**
 * The assistant: the person's own conversations, whether they can ask right now, and the school's
 * switch and limits. Mirrors apps/api/src/assistant. The streaming turn itself is not here: the
 * chat hook posts to `turnPath` and reads the AI SDK's message stream.
 */
import {
  AssistantProposalStates,
  AssistantSettings,
  AssistantStatus,
  AssistantThread,
  AssistantThreadList,
  AssistantUsage,
  ConfirmAssistantProposalResponse,
  CreateAssistantThreadResponse,
  type ConfirmAssistantProposalRequest,
  type UpdateAssistantSettingsRequest,
} from '@erp/contracts'
import { request } from '@/lib/http'
import { schoolPath, seg, withQuery } from './shared'

const base = (schoolId: string, suffix = '') => schoolPath(schoolId, `/assistant${suffix}`)

/** Can this person ask right now, how many questions are left today, and suggested first questions. */
export function status(schoolId: string) {
  return request(base(schoolId, '/status'), { schema: AssistantStatus })
}

/** The person's own conversations of the last 30 days, newest first. */
export function threads(schoolId: string) {
  return request(base(schoolId, '/threads'), { schema: AssistantThreadList })
}

export function thread(schoolId: string, threadId: string) {
  return request(base(schoolId, `/threads/${seg(threadId)}`), { schema: AssistantThread })
}

export function createThread(schoolId: string) {
  return request(base(schoolId, '/threads'), { method: 'POST', schema: CreateAssistantThreadResponse })
}

export function deleteThread(schoolId: string, threadId: string) {
  return request(base(schoolId, `/threads/${seg(threadId)}`), { method: 'DELETE' })
}

/** Where the chat hook sends one question. The body is AssistantTurnRequest. */
export function turnPath(schoolId: string, threadId: string): string {
  return base(schoolId, `/threads/${seg(threadId)}/turns`)
}

export function settings(schoolId: string) {
  return request(base(schoolId, '/settings'), { schema: AssistantSettings })
}

export function updateSettings(schoolId: string, body: UpdateAssistantSettingsRequest) {
  return request(base(schoolId, '/settings'), { method: 'PUT', body, schema: AssistantSettings })
}

/** Question counts for one month (YYYY-MM, the current month when left out). Never anyone's words. */
export function usage(schoolId: string, month?: string) {
  return request(withQuery(base(schoolId, '/usage'), { month }), { schema: AssistantUsage })
}

// ---------- proposals (24b) ----------

/** Every proposal in a conversation, as it stands now: open, done, dismissed, expired, stale or failed. */
export function proposals(schoolId: string, threadId: string) {
  return request(base(schoolId, `/threads/${seg(threadId)}/proposals`), { schema: AssistantProposalStates })
}

/** Confirm with the preview as the person left it. The server writes it through the real route, as them. */
export function confirmProposal(schoolId: string, proposalId: string, body: ConfirmAssistantProposalRequest) {
  return request(base(schoolId, `/proposals/${seg(proposalId)}/confirm`), { method: 'POST', body, schema: ConfirmAssistantProposalResponse })
}

export function dismissProposal(schoolId: string, proposalId: string) {
  return request(base(schoolId, `/proposals/${seg(proposalId)}/dismiss`), { method: 'POST', schema: ConfirmAssistantProposalResponse })
}
