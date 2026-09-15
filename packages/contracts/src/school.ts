import { z } from 'zod'
import { CalendarDate, Email, Id, Phone, Version } from './common.ts'
import { NamedReference } from './responses.ts'

const Name = z.string().trim().min(1).max(160)
const schoolFields = {
  name: Name, shortName: z.string().min(1).max(12),
  board: z.enum(['cbse', 'icse', 'state', 'ib', 'other']),
  address: z.string().max(1000), phone: Phone, email: Email,
  affiliationNumber: z.string().max(100).optional(), udiseCode: z.string().max(100).optional(),
}
export const SchoolProfile = z.strictObject({ id: Id, ...schoolFields, version: Version })
export const UpdateSchoolRequest = z.strictObject({ ...schoolFields, expectedVersion: Version })

export const AcademicYearInput = z.strictObject({
  name: Name, startDate: CalendarDate, endDate: CalendarDate,
  status: z.enum(['upcoming', 'current', 'closed']),
}).refine((v) => v.endDate > v.startDate, 'Academic year end must follow its start')
export const AcademicYear = AcademicYearInput.safeExtend({ id: Id, schoolId: Id, version: Version })
export const AcademicYearList = z.array(AcademicYear)
export const CurrentAcademicYear = AcademicYear.nullable()

export const GradeInput = z.strictObject({
  name: Name, shortName: Name, order: z.number().int().nonnegative(),
  stream: z.enum(['science', 'commerce', 'arts']).optional(),
})
export const Grade = z.strictObject({ id: Id, schoolId: Id, ...GradeInput.shape, version: Version })
export const GradeList = z.array(Grade)
export const SectionInput = z.strictObject({
  gradeId: Id, academicYearId: Id, name: Name,
  classTeacherId: Id.optional(), roomNumber: z.string().max(100).optional(),
  capacity: z.number().int().positive().max(1000).optional(),
})
export const Section = z.strictObject({ id: Id, schoolId: Id, ...SectionInput.shape, version: Version })
export const SectionDetail = Section
export const SectionList = z.array(Section)
export const ClassSectionSetup = z.strictObject({ grades: GradeList, sections: SectionList })
export const AuthorizedSectionCounts = z.array(z.strictObject({ sectionId: Id, count: z.number().int().nonnegative() }))

export const SubjectInput = z.strictObject({ name: Name, code: Name, type: z.enum(['scholastic', 'co_scholastic', 'language', 'elective']) })
export const Subject = z.strictObject({ id: Id, schoolId: Id, ...SubjectInput.shape, version: Version })
export const SubjectList = z.array(Subject)
export const GradeSubjectList = z.array(z.strictObject({ gradeId: Id, academicYearId: Id, subject: NamedReference }))
export const SubjectSetup = z.strictObject({ subjects: SubjectList, gradeSubjects: GradeSubjectList })
export const HolidayInput = z.strictObject({
  academicYearId: Id, name: Name, startDate: CalendarDate, endDate: CalendarDate,
  type: z.enum(['national', 'festival', 'school', 'vacation']),
}).refine((v) => v.endDate >= v.startDate, 'Holiday end precedes its start')
export const Holiday = HolidayInput.safeExtend({ id: Id, schoolId: Id, version: Version })
export const HolidayList = z.array(Holiday)

const ClockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
export const BellPeriod = z.strictObject({
  index: z.number().int().nonnegative(), name: Name, startTime: ClockTime, endTime: ClockTime,
  type: z.enum(['period', 'break', 'lunch', 'assembly']),
}).refine((v) => v.endTime > v.startTime, 'Period end precedes its start')
export const BellSchedule = z.strictObject({
  id: Id, schoolId: Id, academicYearId: Id, name: Name,
  gradeIds: z.array(Id), periods: z.array(BellPeriod).max(100),
  workingDays: z.array(z.number().int().min(1).max(6)).max(6),
  saturdayPeriodCount: z.number().int().nonnegative().optional(), version: Version,
})
export const BellScheduleList = z.array(BellSchedule)
