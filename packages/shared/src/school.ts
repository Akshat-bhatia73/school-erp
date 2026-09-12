import { z } from 'zod'
import { Address, BaseRecord, ISODate, Id, TenantRecord } from './common'

export const Board = z.enum(['cbse', 'icse', 'state', 'ib', 'other'])
export type Board = z.infer<typeof Board>

export const SchoolStatus = z.enum(['active', 'trial', 'suspended'])
export type SchoolStatus = z.infer<typeof SchoolStatus>

/** A school is a tenant. Everything else hangs off schoolId. */
export const School = BaseRecord.extend({
  name: z.string().min(2),
  shortName: z.string().min(1).max(12),
  logoUrl: z.string().optional(),
  board: Board,
  affiliationNumber: z.string().optional(),
  udiseCode: z.string().optional(),
  address: Address,
  phone: z.string(),
  email: z.string().email(),
  website: z.string().optional(),
  principalName: z.string(),
  establishedYear: z.number().int().optional(),
  status: SchoolStatus,
  /** Which academic year the school is currently operating in */
  currentAcademicYearId: Id.optional(),
})
export type School = z.infer<typeof School>

export const AcademicYearStatus = z.enum(['upcoming', 'current', 'closed'])
export type AcademicYearStatus = z.infer<typeof AcademicYearStatus>

/** e.g. 2026-27, April to March */
export const AcademicYear = TenantRecord.extend({
  name: z.string(), // "2026-27"
  startDate: ISODate,
  endDate: ISODate,
  status: AcademicYearStatus,
})
export type AcademicYear = z.infer<typeof AcademicYear>

/** Nursery, LKG, UKG, Class 1 .. Class 12 */
export const Grade = TenantRecord.extend({
  name: z.string(), // "Class 6"
  shortName: z.string(), // "6"
  /** Sort order: Nursery=0, LKG=1, UKG=2, Class 1=3 ... Class 12=14 */
  order: z.number().int(),
  /** Only for 11 and 12 */
  stream: z.enum(['science', 'commerce', 'arts']).optional(),
})
export type Grade = z.infer<typeof Grade>

/** Class 6 - A. A section belongs to a grade and an academic year. */
export const Section = TenantRecord.extend({
  gradeId: Id,
  academicYearId: Id,
  name: z.string(), // "A"
  classTeacherId: Id.optional(), // staff id
  roomNumber: z.string().optional(),
  capacity: z.number().int().optional(),
})
export type Section = z.infer<typeof Section>

export const SubjectType = z.enum(['scholastic', 'co_scholastic', 'language', 'elective'])
export type SubjectType = z.infer<typeof SubjectType>

export const Subject = TenantRecord.extend({
  name: z.string(), // "Mathematics"
  code: z.string(), // "MATH"
  type: SubjectType,
})
export type Subject = z.infer<typeof Subject>

/** Which subjects a grade studies in a given academic year */
export const GradeSubject = TenantRecord.extend({
  gradeId: Id,
  academicYearId: Id,
  subjectId: Id,
  isOptional: z.boolean().default(false),
})
export type GradeSubject = z.infer<typeof GradeSubject>

export const HolidayType = z.enum(['national', 'festival', 'school', 'vacation'])
export type HolidayType = z.infer<typeof HolidayType>

export const Holiday = TenantRecord.extend({
  academicYearId: Id,
  name: z.string(),
  startDate: ISODate,
  endDate: ISODate,
  type: HolidayType,
})
export type Holiday = z.infer<typeof Holiday>

// ---- Inputs (what forms submit) ----
export const SchoolInput = School.omit({ id: true, createdAt: true, updatedAt: true })
export type SchoolInput = z.infer<typeof SchoolInput>
export const AcademicYearInput = AcademicYear.omit({ id: true, createdAt: true, updatedAt: true, schoolId: true })
export type AcademicYearInput = z.infer<typeof AcademicYearInput>
export const GradeInput = Grade.omit({ id: true, createdAt: true, updatedAt: true, schoolId: true })
export type GradeInput = z.infer<typeof GradeInput>
export const SectionInput = Section.omit({ id: true, createdAt: true, updatedAt: true, schoolId: true })
export type SectionInput = z.infer<typeof SectionInput>
export const SubjectInput = Subject.omit({ id: true, createdAt: true, updatedAt: true, schoolId: true })
export type SubjectInput = z.infer<typeof SubjectInput>
export const HolidayInput = Holiday.omit({ id: true, createdAt: true, updatedAt: true, schoolId: true })
export type HolidayInput = z.infer<typeof HolidayInput>
