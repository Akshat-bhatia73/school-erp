/** Task 5 request and response contracts owned by the setup module. */
import { z } from 'zod'
import { Email, Id, Phone, Version } from './common.ts'
import {
  AcademicYearInput,
  GradeInput,
  HolidayInput,
  SchoolProfile,
  SectionInput,
  SubjectInput,
} from './school.ts'

/**
 * The stored profile of a school that has not finished its setup yet. Phone
 * and email are optional here because a school row may exist before anyone has
 * filled them in, and inventing a placeholder contact would be worse than
 * saying nothing. Every update still supplies both, so a completed profile is
 * always a plain SchoolProfile.
 */
export const SetupSchoolProfile = z.strictObject({
  ...SchoolProfile.shape,
  phone: Phone.optional(),
  email: Email.optional(),
})

/**
 * Every setup update carries the version the editor was looking at, so two
 * people editing the same record cannot silently overwrite each other. The
 * input shapes themselves stay in school.ts; only the optimistic wrapper and
 * the query shapes are new, and each name is prefixed so the nine Task 5
 * modules cannot collide in the shared contracts index.
 */
export const SetupAcademicYearUpdateRequest = z.strictObject({
  ...AcademicYearInput.shape,
  expectedVersion: Version,
}).refine((value) => value.endDate > value.startDate, 'Academic year end must follow its start')

export const SetupGradeUpdateRequest = z.strictObject({
  ...GradeInput.shape,
  expectedVersion: Version,
})

export const SetupSectionUpdateRequest = z.strictObject({
  ...SectionInput.shape,
  expectedVersion: Version,
})

export const SetupSubjectUpdateRequest = z.strictObject({
  ...SubjectInput.shape,
  expectedVersion: Version,
})

/**
 * The holidays table carries no version column, so the version a holiday
 * reports is derived from when it was last touched. The editor still sends the
 * number it was shown, so a second editor's save is refused rather than
 * silently overwriting the first.
 */
export const SetupHolidayUpdateRequest = HolidayInput.safeExtend({ expectedVersion: Version })

/**
 * The subjects a class studies in one year, replaced as a whole set. An empty
 * list is allowed on purpose: it is the only way to undo a mapping made by
 * mistake, because a subject cannot be deleted while a class still names it.
 */
export const SetupGradeSubjectsRequest = z.strictObject({
  academicYearId: Id,
  subjectIds: z.array(Id).max(100).refine(
    (ids) => new Set(ids).size === ids.length,
    'Duplicate identifiers are not allowed',
  ),
})

export const SetupSectionListQuery = z.strictObject({
  academicYearId: Id.optional(),
  gradeId: Id.optional(),
})
export const SetupSectionStrengthsQuery = z.strictObject({ academicYearId: Id })
export const SetupGradeSubjectListQuery = z.strictObject({
  academicYearId: Id,
  gradeId: Id.optional(),
})
export const SetupHolidayListQuery = z.strictObject({ academicYearId: Id.optional() })
