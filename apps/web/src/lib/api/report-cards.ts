/** Grade bands and layout, the class teacher's entries, publishing and reading report cards.
 *  Mirrors apps/api/src/modules/report-cards. */
import {
  ExamSettings,
  ExamSettingsUpdateRequest,
  ReportCardEntriesResponse,
  ReportCardEntriesSaveRequest,
  ReportCardExportJob,
  ReportCardPublishRequest,
  ReportCardPublishResponse,
  ReportCardSectionResponse,
  ReportCardSectionsResponse,
  ReportCardView,
  StudentReportCardsResponse,
  type ExamTerm,
  type ReportCardKind,
} from '@erp/contracts'
import type { z } from 'zod'
import { request } from '@/lib/http'
import { schoolPath, seg, withQuery } from './shared'

export type ExamSettingsRecord = z.infer<typeof ExamSettings>
export type ReportCardEntries = z.infer<typeof ReportCardEntriesResponse>
export type ReportCardSections = z.infer<typeof ReportCardSectionsResponse>
export type ReportCardSectionRow = ReportCardSections['items'][number]
export type ReportCardSection = z.infer<typeof ReportCardSectionResponse>
export type ReportCardViewRecord = z.infer<typeof ReportCardView>
export type StudentReportCards = z.infer<typeof StudentReportCardsResponse>

export type ExamSettingsInput = z.input<typeof ExamSettingsUpdateRequest>
export type ReportCardEntriesInput = z.input<typeof ReportCardEntriesSaveRequest>
export type ReportCardPublishInput = z.input<typeof ReportCardPublishRequest>

const base = (schoolId: string, suffix = '') => schoolPath(schoolId, `/report-cards${suffix}`)

export function settings(schoolId: string) {
  return request(base(schoolId, '/settings'), { schema: ExamSettings })
}

export function saveSettings(schoolId: string, body: ExamSettingsInput) {
  return request(base(schoolId, '/settings'), { method: 'PUT', body, schema: ExamSettings })
}

export function entries(schoolId: string, sectionId: string, term: ExamTerm) {
  return request(base(schoolId, `/sections/${seg(sectionId)}/terms/${seg(term)}/entries`), { schema: ReportCardEntriesResponse })
}

export function saveEntries(schoolId: string, sectionId: string, term: ExamTerm, body: ReportCardEntriesInput) {
  return request(base(schoolId, `/sections/${seg(sectionId)}/terms/${seg(term)}/entries`), { method: 'PUT', body, schema: ReportCardEntriesResponse })
}

export function sections(schoolId: string, params: { academicYearId: string; card: ReportCardKind }) {
  return request(withQuery(base(schoolId, '/sections'), { ...params }), { schema: ReportCardSectionsResponse })
}

export function section(schoolId: string, sectionId: string, card: ReportCardKind) {
  return request(base(schoolId, `/sections/${seg(sectionId)}/cards/${seg(card)}`), { schema: ReportCardSectionResponse })
}

export function publish(schoolId: string, sectionId: string, card: ReportCardKind, body: ReportCardPublishInput = {}) {
  return request(base(schoolId, `/sections/${seg(sectionId)}/cards/${seg(card)}/publish`), { method: 'POST', body, schema: ReportCardPublishResponse })
}

export function forStudent(schoolId: string, studentId: string, params: { academicYearId: string }) {
  return request(withQuery(base(schoolId, `/students/${seg(studentId)}`), { ...params }), { schema: StudentReportCardsResponse })
}

export function version(schoolId: string, versionId: string) {
  return request(base(schoolId, `/versions/${seg(versionId)}`), { schema: ReportCardView })
}

export function exportVersion(schoolId: string, versionId: string) {
  return request(base(schoolId, `/versions/${seg(versionId)}/export`), { method: 'POST', body: {}, schema: ReportCardExportJob })
}

export function exportSection(schoolId: string, sectionId: string, card: ReportCardKind) {
  return request(base(schoolId, `/sections/${seg(sectionId)}/cards/${seg(card)}/export`), { method: 'POST', body: {}, schema: ReportCardExportJob })
}
