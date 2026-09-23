/** The exams, their marks sheets, publishing and one pupil's results. Mirrors apps/api/src/modules/exams. */
import {
  ExamCreateRequest,
  ExamExportJob,
  ExamListResponse,
  ExamMarkHistory,
  ExamMarksCorrectionRequest,
  ExamMarksSaveRequest,
  ExamOverview,
  ExamPapersRequest,
  ExamPapersResponse,
  ExamResultsResponse,
  ExamSchedule,
  ExamSectionStatus,
  ExamSheet,
  ExamUpdateRequest,
  type ExamComponent,
} from '@erp/contracts'
import type { z } from 'zod'
import { request } from '@/lib/http'
import { schoolPath, seg, withQuery } from './shared'

export type ExamList = z.infer<typeof ExamListResponse>
export type ExamScheduleRecord = z.infer<typeof ExamSchedule>
export type ExamOverviewResult = z.infer<typeof ExamOverview>
export type ExamSectionStatusRecord = z.infer<typeof ExamSectionStatus>
export type ExamPapersResult = z.infer<typeof ExamPapersResponse>
export type ExamPaperRecord = ExamPapersResult['items'][number]
export type ExamSheetResult = z.infer<typeof ExamSheet>
export type ExamMarkHistoryResult = z.infer<typeof ExamMarkHistory>
export type ExamResults = z.infer<typeof ExamResultsResponse>

export type ExamCreateInput = z.input<typeof ExamCreateRequest>
export type ExamUpdateInput = z.input<typeof ExamUpdateRequest>
export type ExamPapersParams = z.input<typeof ExamPapersRequest>
export type ExamMarksSaveInput = z.input<typeof ExamMarksSaveRequest>
export type ExamMarksCorrectionInput = z.input<typeof ExamMarksCorrectionRequest>

const base = (schoolId: string, suffix = '') => schoolPath(schoolId, `/exams${suffix}`)

// ---------- exam dates ----------

export function list(schoolId: string, params: { academicYearId: string }) {
  return request(withQuery(base(schoolId), { ...params }), { schema: ExamListResponse })
}

export function create(schoolId: string, body: ExamCreateInput) {
  return request(base(schoolId), { method: 'POST', body, schema: ExamSchedule })
}

export function update(schoolId: string, examId: string, body: ExamUpdateInput) {
  return request(base(schoolId, `/${seg(examId)}`), { method: 'PUT', body, schema: ExamSchedule })
}

/** One exam across the school: where each section stands. */
export function overview(schoolId: string, examId: string) {
  return request(base(schoolId, `/${seg(examId)}`), { schema: ExamOverview })
}

// ---------- marks sheets ----------

export function papers(schoolId: string, params: ExamPapersParams) {
  return request(withQuery(base(schoolId, '/papers'), { ...params }), { schema: ExamPapersResponse })
}

export function sheet(schoolId: string, paperId: string) {
  return request(base(schoolId, `/papers/${seg(paperId)}`), { schema: ExamSheet })
}

/** The whole sheet in one write: every filled cell, and a reason when a saved cell changes. */
export function saveMarks(schoolId: string, paperId: string, body: ExamMarksSaveInput) {
  return request(base(schoolId, `/papers/${seg(paperId)}/marks`), { method: 'PUT', body, schema: ExamSheet })
}

/** The office's correction: the changed cells only, always with a reason. */
export function correct(schoolId: string, paperId: string, body: ExamMarksCorrectionInput) {
  return request(base(schoolId, `/papers/${seg(paperId)}/corrections`), { method: 'POST', body, schema: ExamSheet })
}

export function history(schoolId: string, paperId: string, studentId: string, params: { component: ExamComponent }) {
  return request(withQuery(base(schoolId, `/papers/${seg(paperId)}/students/${seg(studentId)}/history`), { ...params }), { schema: ExamMarkHistory })
}

// ---------- publishing and results ----------

export function publish(schoolId: string, examId: string, sectionId: string) {
  return request(base(schoolId, `/${seg(examId)}/sections/${seg(sectionId)}/publish`), { method: 'POST', body: {}, schema: ExamSectionStatus })
}

export function results(schoolId: string, studentId: string, params: { academicYearId: string }) {
  return request(withQuery(base(schoolId, `/students/${seg(studentId)}/results`), { ...params }), { schema: ExamResultsResponse })
}

// ---------- files ----------

export function exportRegister(schoolId: string, paperId: string) {
  return request(base(schoolId, `/papers/${seg(paperId)}/export`), { method: 'POST', body: {}, schema: ExamExportJob })
}
