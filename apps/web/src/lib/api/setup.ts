/** School profile and academic setup. Mirrors apps/api/src/modules/setup. */
import {
  AcademicYear,
  AcademicYearInput,
  AcademicYearList,
  CurrentAcademicYear,
  AuthorizedSectionCounts,
  Grade,
  GradeInput,
  GradeList,
  GradeSubjectList,
  Holiday,
  HolidayInput,
  HolidayList,
  Section,
  SectionDetail,
  SectionInput,
  SectionList,
  SetupAcademicYearUpdateRequest,
  SetupGradeSubjectsRequest,
  SetupGradeUpdateRequest,
  SetupHolidayUpdateRequest,
  SetupSchoolProfile,
  SetupSectionUpdateRequest,
  SetupSubjectUpdateRequest,
  Subject,
  SubjectInput,
  SubjectList,
  UpdateSchoolRequest,
} from '@erp/contracts'
import type { z } from 'zod'
import { request } from '@/lib/http'
import { schoolPath, seg, withQuery } from './shared'

export type SchoolProfile = z.infer<typeof SetupSchoolProfile>
export type UpdateSchoolInput = z.input<typeof UpdateSchoolRequest>
export type AcademicYearRecord = z.infer<typeof AcademicYear>
export type NewAcademicYear = z.input<typeof AcademicYearInput>
export type AcademicYearUpdateInput = z.input<typeof SetupAcademicYearUpdateRequest>
export type GradeRecord = z.infer<typeof Grade>
export type NewGrade = z.input<typeof GradeInput>
export type GradeUpdateInput = z.input<typeof SetupGradeUpdateRequest>
export type SectionRecord = z.infer<typeof Section>
export type NewSection = z.input<typeof SectionInput>
export type SectionUpdateInput = z.input<typeof SetupSectionUpdateRequest>
export type SectionStrength = z.infer<typeof AuthorizedSectionCounts>[number]
export type SubjectRecord = z.infer<typeof Subject>
export type NewSubject = z.input<typeof SubjectInput>
export type SubjectUpdateInput = z.input<typeof SetupSubjectUpdateRequest>
export type GradeSubject = z.infer<typeof GradeSubjectList>[number]
export type GradeSubjectsInput = z.input<typeof SetupGradeSubjectsRequest>
export type HolidayRecord = z.infer<typeof Holiday>
export type NewHoliday = z.input<typeof HolidayInput>
export type HolidayUpdateInput = z.input<typeof SetupHolidayUpdateRequest>

export function school(schoolId: string) {
  return request(schoolPath(schoolId, '/school'), { schema: SetupSchoolProfile })
}

export function updateSchool(schoolId: string, body: UpdateSchoolInput) {
  return request(schoolPath(schoolId, '/school'), { method: 'PUT', body, schema: SetupSchoolProfile })
}

// ---------- academic years ----------

export function academicYears(schoolId: string) {
  return request(schoolPath(schoolId, '/academic-years'), { schema: AcademicYearList })
}

export function currentAcademicYear(schoolId: string) {
  return request(schoolPath(schoolId, '/academic-years/current'), { schema: CurrentAcademicYear })
}

export function createAcademicYear(schoolId: string, body: NewAcademicYear) {
  return request(schoolPath(schoolId, '/academic-years'), { method: 'POST', body, schema: AcademicYear })
}

export function updateAcademicYear(schoolId: string, academicYearId: string, body: AcademicYearUpdateInput) {
  return request(schoolPath(schoolId, `/academic-years/${seg(academicYearId)}`), { method: 'PUT', body, schema: AcademicYear })
}

// ---------- grades ----------

export function grades(schoolId: string) {
  return request(schoolPath(schoolId, '/grades'), { schema: GradeList })
}

export function createGrade(schoolId: string, body: NewGrade) {
  return request(schoolPath(schoolId, '/grades'), { method: 'POST', body, schema: Grade })
}

export function updateGrade(schoolId: string, gradeId: string, body: GradeUpdateInput) {
  return request(schoolPath(schoolId, `/grades/${seg(gradeId)}`), { method: 'PUT', body, schema: Grade })
}

export async function deleteGrade(schoolId: string, gradeId: string): Promise<void> {
  await request(schoolPath(schoolId, `/grades/${seg(gradeId)}`), { method: 'DELETE' })
}

// ---------- sections ----------

export function sections(schoolId: string, params: { academicYearId?: string; gradeId?: string } = {}) {
  return request(withQuery(schoolPath(schoolId, '/sections'), params), { schema: SectionList })
}

export function sectionStrengths(schoolId: string, params: { academicYearId: string }) {
  return request(withQuery(schoolPath(schoolId, '/sections/strengths'), params), { schema: AuthorizedSectionCounts })
}

export function section(schoolId: string, sectionId: string) {
  return request(schoolPath(schoolId, `/sections/${seg(sectionId)}`), { schema: SectionDetail })
}

export function createSection(schoolId: string, body: NewSection) {
  return request(schoolPath(schoolId, '/sections'), { method: 'POST', body, schema: Section })
}

export function updateSection(schoolId: string, sectionId: string, body: SectionUpdateInput) {
  return request(schoolPath(schoolId, `/sections/${seg(sectionId)}`), { method: 'PUT', body, schema: Section })
}

export async function deleteSection(schoolId: string, sectionId: string): Promise<void> {
  await request(schoolPath(schoolId, `/sections/${seg(sectionId)}`), { method: 'DELETE' })
}

// ---------- subjects ----------

export function subjects(schoolId: string) {
  return request(schoolPath(schoolId, '/subjects'), { schema: SubjectList })
}

export function gradeSubjects(schoolId: string, params: { academicYearId: string; gradeId?: string }) {
  return request(withQuery(schoolPath(schoolId, '/grade-subjects'), params), { schema: GradeSubjectList })
}

export function createSubject(schoolId: string, body: NewSubject) {
  return request(schoolPath(schoolId, '/subjects'), { method: 'POST', body, schema: Subject })
}

export function updateSubject(schoolId: string, subjectId: string, body: SubjectUpdateInput) {
  return request(schoolPath(schoolId, `/subjects/${seg(subjectId)}`), { method: 'PUT', body, schema: Subject })
}

export async function deleteSubject(schoolId: string, subjectId: string): Promise<void> {
  await request(schoolPath(schoolId, `/subjects/${seg(subjectId)}`), { method: 'DELETE' })
}

/** Replaces the whole set of subjects a class studies in one year. */
export function setGradeSubjects(schoolId: string, gradeId: string, body: GradeSubjectsInput) {
  return request(schoolPath(schoolId, `/grades/${seg(gradeId)}/subjects`), { method: 'PUT', body, schema: GradeSubjectList })
}

// ---------- holidays ----------

export function holidays(schoolId: string, params: { academicYearId?: string } = {}) {
  return request(withQuery(schoolPath(schoolId, '/holidays'), params), { schema: HolidayList })
}

export function createHoliday(schoolId: string, body: NewHoliday) {
  return request(schoolPath(schoolId, '/holidays'), { method: 'POST', body, schema: Holiday })
}

export function updateHoliday(schoolId: string, holidayId: string, body: HolidayUpdateInput) {
  return request(schoolPath(schoolId, `/holidays/${seg(holidayId)}`), { method: 'PUT', body, schema: Holiday })
}

export async function deleteHoliday(schoolId: string, holidayId: string): Promise<void> {
  await request(schoolPath(schoolId, `/holidays/${seg(holidayId)}`), { method: 'DELETE' })
}
