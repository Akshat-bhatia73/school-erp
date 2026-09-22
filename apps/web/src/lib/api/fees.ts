/** Fee heads and amounts, one pupil's statement, the ledger and the fee files.
 *  Mirrors apps/api/src/modules/fees. */
import {
  FeeAdjustmentRequest,
  FeeCancelRequest,
  FeeCollectRequest,
  FeeCollectionsExportRequest,
  FeeConcession,
  FeeConcessionCreateRequest,
  FeeConcessionRemoveRequest,
  FeeDuesExportRequest,
  FeeDuesPage,
  FeeDuesRequest,
  FeeExportJob,
  FeeHead,
  FeeHeadCreateRequest,
  FeeHeadList,
  FeeHeadUpdateRequest,
  FeeOptIn,
  FeeOptInCreateRequest,
  FeeOptInUpdateRequest,
  FeeReceiptDetail,
  FeeReceiptListRequest,
  FeeReceiptPage,
  FeeRefundRequest,
  FeeStatement,
  FeeStructure,
  FeeStructureCreateRequest,
  FeeStructureList,
  FeeStructureListRequest,
  FeeStructureUpdateRequest,
} from '@erp/contracts'
import type { z } from 'zod'
import { request } from '@/lib/http'
import { schoolPath, seg, withQuery } from './shared'

export type FeeHeadRecord = z.infer<typeof FeeHead>
export type FeeStructureRecord = z.infer<typeof FeeStructure>
export type FeeOptInRecord = z.infer<typeof FeeOptIn>
export type FeeConcessionRecord = z.infer<typeof FeeConcession>
export type FeeStatementRecord = z.infer<typeof FeeStatement>
export type FeeDuesPageResult = z.infer<typeof FeeDuesPage>
export type FeeDuesRowRecord = FeeDuesPageResult['items'][number]
export type FeeReceiptPageResult = z.infer<typeof FeeReceiptPage>
export type FeeReceiptSummaryRecord = FeeReceiptPageResult['items'][number]
export type FeeReceiptDetailRecord = z.infer<typeof FeeReceiptDetail>

export type FeeHeadCreateInput = z.input<typeof FeeHeadCreateRequest>
export type FeeHeadUpdateInput = z.input<typeof FeeHeadUpdateRequest>
export type FeeStructureListParams = z.input<typeof FeeStructureListRequest>
export type FeeStructureCreateInput = z.input<typeof FeeStructureCreateRequest>
export type FeeStructureUpdateInput = z.input<typeof FeeStructureUpdateRequest>
export type FeeOptInCreateInput = z.input<typeof FeeOptInCreateRequest>
export type FeeOptInUpdateInput = z.input<typeof FeeOptInUpdateRequest>
export type FeeConcessionCreateInput = z.input<typeof FeeConcessionCreateRequest>
export type FeeConcessionRemoveInput = z.input<typeof FeeConcessionRemoveRequest>
export type FeeCollectInput = z.input<typeof FeeCollectRequest>
export type FeeRefundInput = z.input<typeof FeeRefundRequest>
export type FeeCancelInput = z.input<typeof FeeCancelRequest>
export type FeeAdjustmentInput = z.input<typeof FeeAdjustmentRequest>
export type FeeDuesParams = z.input<typeof FeeDuesRequest>
export type FeeReceiptListParams = z.input<typeof FeeReceiptListRequest>
export type FeeDuesExportInput = z.input<typeof FeeDuesExportRequest>
export type FeeCollectionsExportInput = z.input<typeof FeeCollectionsExportRequest>

const base = (schoolId: string, suffix = '') => schoolPath(schoolId, `/fees${suffix}`)

// ---------- what the school charges ----------

export function heads(schoolId: string) {
  return request(base(schoolId, '/heads'), { schema: FeeHeadList })
}

export function createHead(schoolId: string, body: FeeHeadCreateInput) {
  return request(base(schoolId, '/heads'), { method: 'POST', body, schema: FeeHead })
}

export function updateHead(schoolId: string, headId: string, body: FeeHeadUpdateInput) {
  return request(base(schoolId, `/heads/${seg(headId)}`), { method: 'PUT', body, schema: FeeHead })
}

export async function deleteHead(schoolId: string, headId: string, expectedVersion: number): Promise<void> {
  await request(withQuery(base(schoolId, `/heads/${seg(headId)}`), { expectedVersion }), { method: 'DELETE' })
}

export function structures(schoolId: string, params: FeeStructureListParams) {
  return request(withQuery(base(schoolId, '/structures'), { ...params }), { schema: FeeStructureList })
}

export function createStructure(schoolId: string, body: FeeStructureCreateInput) {
  return request(base(schoolId, '/structures'), { method: 'POST', body, schema: FeeStructure })
}

export function updateStructure(schoolId: string, structureId: string, body: FeeStructureUpdateInput) {
  return request(base(schoolId, `/structures/${seg(structureId)}`), { method: 'PUT', body, schema: FeeStructure })
}

export async function deleteStructure(schoolId: string, structureId: string, expectedVersion: number): Promise<void> {
  await request(withQuery(base(schoolId, `/structures/${seg(structureId)}`), { expectedVersion }), { method: 'DELETE' })
}

// ---------- one pupil ----------

export function addOptIn(schoolId: string, studentId: string, body: FeeOptInCreateInput) {
  return request(base(schoolId, `/students/${seg(studentId)}/opt-ins`), { method: 'POST', body, schema: FeeOptIn })
}

export function updateOptIn(schoolId: string, optInId: string, body: FeeOptInUpdateInput) {
  return request(base(schoolId, `/opt-ins/${seg(optInId)}`), { method: 'PUT', body, schema: FeeOptIn })
}

export async function deleteOptIn(schoolId: string, optInId: string, expectedVersion: number): Promise<void> {
  await request(withQuery(base(schoolId, `/opt-ins/${seg(optInId)}`), { expectedVersion }), { method: 'DELETE' })
}

export function addConcession(schoolId: string, studentId: string, body: FeeConcessionCreateInput) {
  return request(base(schoolId, `/students/${seg(studentId)}/concessions`), { method: 'POST', body, schema: FeeConcession })
}

/** Removing a concession asks for a reason, which goes to the audit note and nowhere else. */
export async function removeConcession(schoolId: string, concessionId: string, body: FeeConcessionRemoveInput): Promise<void> {
  await request(base(schoolId, `/concessions/${seg(concessionId)}/remove`), { method: 'POST', body })
}

export function statement(schoolId: string, studentId: string, params: { academicYearId?: string } = {}) {
  return request(withQuery(base(schoolId, `/students/${seg(studentId)}/statement`), { ...params }), { schema: FeeStatement })
}

export function dues(schoolId: string, params: FeeDuesParams = {}) {
  return request(withQuery(base(schoolId, '/dues'), { ...params }), { schema: FeeDuesPage })
}

// ---------- the ledger ----------

export function receipts(schoolId: string, params: FeeReceiptListParams = {}) {
  return request(withQuery(base(schoolId, '/receipts'), { ...params }), { schema: FeeReceiptPage })
}

export function receipt(schoolId: string, receiptId: string) {
  return request(base(schoolId, `/receipts/${seg(receiptId)}`), { schema: FeeReceiptDetail })
}

/** The receipt number is never sent: the server takes it from the school's own counter. */
export function collect(schoolId: string, studentId: string, body: FeeCollectInput) {
  return request(base(schoolId, `/students/${seg(studentId)}/collect`), { method: 'POST', body, schema: FeeReceiptDetail })
}

export function refund(schoolId: string, receiptId: string, body: FeeRefundInput) {
  return request(base(schoolId, `/receipts/${seg(receiptId)}/refund`), { method: 'POST', body, schema: FeeReceiptDetail })
}

export function cancel(schoolId: string, receiptId: string, body: FeeCancelInput) {
  return request(base(schoolId, `/receipts/${seg(receiptId)}/cancel`), { method: 'POST', body, schema: FeeReceiptDetail })
}

export function adjust(schoolId: string, studentId: string, body: FeeAdjustmentInput) {
  return request(base(schoolId, `/students/${seg(studentId)}/adjustments`), { method: 'POST', body, schema: FeeReceiptDetail })
}

// ---------- files ----------

/** One receipt as a document. The receipt is named in the path, so there is no body to send. */
export function exportReceipt(schoolId: string, receiptId: string) {
  return request(base(schoolId, `/receipts/${seg(receiptId)}/export`), { method: 'POST', body: {}, schema: FeeExportJob })
}

export function exportDues(schoolId: string, body: FeeDuesExportInput) {
  return request(base(schoolId, '/dues/export'), { method: 'POST', body, schema: FeeExportJob })
}

export function exportCollections(schoolId: string, body: FeeCollectionsExportInput) {
  return request(base(schoolId, '/receipts/export'), { method: 'POST', body, schema: FeeExportJob })
}
