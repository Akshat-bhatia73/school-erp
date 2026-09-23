/** Task 21 request and response contracts owned by the report cards module. */
import { z } from 'zod'
import { DisplayName, Id, Timestamp } from './common.ts'
import { ErrorReason } from './errors.ts'
import {
  ExamKind,
  ExamPupil,
  ExamTerm,
  MarkValue,
  ExamComponent,
  ResultDisplayMode,
  ResultView,
} from './module-exams.ts'
import { AllowedActions, ExportJobSummary, NamedReference } from './responses.ts'

// ---------------------------------------------------------------------------
// Grade bands.

export const GradeBand = z.strictObject({
  label: z.string().trim().min(1).max(8),
  /** Whole percentages, both ends included. */
  min: z.number().int().min(0).max(100),
  max: z.number().int().min(0).max(100),
})
export type GradeBand = z.infer<typeof GradeBand>

export const GradeBands = z.array(GradeBand).min(2).max(12)
export type GradeBands = z.infer<typeof GradeBands>

/** The CBSE 8-point scale, which every school starts from. */
export const DEFAULT_GRADE_BANDS: GradeBands = [
  { label: 'A1', min: 91, max: 100 },
  { label: 'A2', min: 81, max: 90 },
  { label: 'B1', min: 71, max: 80 },
  { label: 'B2', min: 61, max: 70 },
  { label: 'C1', min: 51, max: 60 },
  { label: 'C2', min: 41, max: 50 },
  { label: 'D', min: 33, max: 40 },
  { label: 'E', min: 0, max: 32 },
]

/**
 * What is wrong with a set of bands, or null when they are usable. The server
 * refuses a save with this reason, and the settings screen shows the same
 * sentence before anybody presses save. Bands must have distinct labels, and
 * taken from the top they must start at 100, each one ending one below where
 * the one above starts, down to 0.
 */
export function gradeBandsProblem(bands: readonly GradeBand[]): ErrorReason | null {
  const labels = bands.map((band) => band.label.trim().toLowerCase())
  if (new Set(labels).size !== labels.length) return 'grade_bands_duplicate_label'
  if (bands.some((band) => band.min > band.max)) return 'grade_bands_out_of_range'
  const sorted = [...bands].sort((a, b) => b.max - a.max || b.min - a.min)
  for (let index = 1; index < sorted.length; index += 1) {
    const above = sorted[index - 1]!
    const below = sorted[index]!
    if (below.max >= above.min) return 'grade_bands_overlap'
    if (below.max < above.min - 1) return 'grade_bands_gap'
  }
  if (sorted[0]!.max !== 100 || sorted[sorted.length - 1]!.min !== 0) return 'grade_bands_out_of_range'
  return null
}

/**
 * The grade for a percentage: rounded half up to a whole number, then the band
 * that holds it. 90.5 is 91, which is A1 on the default scale. Null when there
 * is no percentage.
 */
export function gradeFor(bands: readonly GradeBand[], percentage: number | null): string | null {
  if (percentage === null) return null
  const whole = Math.min(100, Math.max(0, Math.floor(percentage + 0.5)))
  return bands.find((band) => band.min <= whole && whole <= band.max)?.label ?? null
}

// ---------------------------------------------------------------------------
// Co-scholastic areas, graded A, B or C per term by the class teacher.

export const CoScholasticArea = z.enum(['work_education', 'art_education', 'health_physical_education', 'discipline'])
export type CoScholasticArea = z.infer<typeof CoScholasticArea>

export const CO_SCHOLASTIC_AREAS: Readonly<Record<CoScholasticArea, string>> = {
  work_education: 'Work education',
  art_education: 'Art education',
  health_physical_education: 'Health and physical education',
  discipline: 'Discipline',
}

export const CoScholasticGrade = z.enum(['A', 'B', 'C'])
export type CoScholasticGrade = z.infer<typeof CoScholasticGrade>

/** The four grades of one pupil and term; null is not graded yet. */
export const CoScholasticGrades = z.strictObject({
  work_education: CoScholasticGrade.nullable(),
  art_education: CoScholasticGrade.nullable(),
  health_physical_education: CoScholasticGrade.nullable(),
  discipline: CoScholasticGrade.nullable(),
})
export type CoScholasticGrades = z.infer<typeof CoScholasticGrades>

// ---------------------------------------------------------------------------
// The layout: structured settings, never HTML or CSS.

export const ReportCardBlock = z.enum(['scholastic', 'co_scholastic', 'attendance', 'remarks', 'grading_key'])
export type ReportCardBlock = z.infer<typeof ReportCardBlock>

export const REPORT_CARD_BLOCKS: Readonly<Record<ReportCardBlock, string>> = {
  scholastic: 'Scholastic areas',
  co_scholastic: 'Co-scholastic areas',
  attendance: 'Attendance',
  remarks: "Class teacher's remarks",
  grading_key: 'Grading key',
}

export const ReportCardLayout = z.strictObject({
  showLogo: z.boolean(),
  /** Which header lines appear under the logo; each comes from the school profile. */
  headerLines: z.strictObject({
    schoolName: z.boolean(),
    affiliationNumber: z.boolean(),
    address: z.boolean(),
    contact: z.boolean(),
  }),
  /** Which blocks appear, in this order. */
  blocks: z
    .array(ReportCardBlock)
    .min(1)
    .max(5)
    .refine((blocks) => new Set(blocks).size === blocks.length, 'Each block may appear once'),
  /** The labels under up to three signature lines. */
  signatures: z.array(z.string().trim().min(1).max(40)).max(3),
  /** A line printed at the foot of the card; empty for none. */
  footerNote: z.string().trim().max(300),
})
export type ReportCardLayout = z.infer<typeof ReportCardLayout>

export const DEFAULT_REPORT_CARD_LAYOUT: ReportCardLayout = {
  showLogo: true,
  headerLines: { schoolName: true, affiliationNumber: true, address: true, contact: true },
  blocks: ['scholastic', 'co_scholastic', 'attendance', 'remarks', 'grading_key'],
  signatures: ['Class teacher', 'Principal', 'Parent'],
  footerNote: '',
}

// ---------------------------------------------------------------------------
// The school's settings: bands, marks or grades, and the layout.

export const ExamSettings = z.strictObject({
  displayMode: ResultDisplayMode,
  gradeBands: GradeBands,
  layout: ReportCardLayout,
  /** 0 while the school has never saved its own settings and uses the defaults. */
  version: z.number().int().nonnegative(),
  updatedAt: Timestamp.optional(),
  /** Whether the school has a logo on its profile, for the preview. */
  hasLogo: z.boolean(),
  allowedActions: AllowedActions,
})
export type ExamSettings = z.infer<typeof ExamSettings>

export const ExamSettingsUpdateRequest = z.strictObject({
  /** 0 for the first save over the defaults. */
  expectedVersion: z.number().int().nonnegative(),
  displayMode: ResultDisplayMode,
  gradeBands: GradeBands,
  layout: ReportCardLayout,
})
export type ExamSettingsUpdateRequest = z.infer<typeof ExamSettingsUpdateRequest>

// ---------------------------------------------------------------------------
// The class teacher's entries: co-scholastic grades and remarks per term.

export const ReportCardEntry = z.strictObject({
  id: Id,
  version: z.number().int().positive(),
  grades: CoScholasticGrades,
  /** Free text about a child. Never in an audit row; cleared by anonymisation. */
  remarks: z.string().max(1000).nullable(),
  updatedAt: Timestamp,
})
export type ReportCardEntry = z.infer<typeof ReportCardEntry>

export const ReportCardEntriesResponse = z.strictObject({
  section: NamedReference,
  grade: NamedReference,
  academicYear: NamedReference,
  term: ExamTerm,
  /** The term's roster: enrolled in the section on the first day of the term's main exam. */
  rows: z
    .array(z.strictObject({ student: ExamPupil, entry: ReportCardEntry.nullable() }))
    .max(200),
  allowedActions: AllowedActions,
})
export type ReportCardEntriesResponse = z.infer<typeof ReportCardEntriesResponse>

export const ReportCardEntriesSaveRequest = z.strictObject({
  rows: z
    .array(
      z.strictObject({
        studentId: Id,
        /** The entry's version, or 0 for a pupil with no entry yet. */
        expectedVersion: z.number().int().nonnegative(),
        grades: CoScholasticGrades,
        remarks: z.string().trim().max(1000).nullable(),
      }),
    )
    .min(1)
    .max(200)
    .refine((rows) => new Set(rows.map((row) => row.studentId)).size === rows.length, 'Each pupil may appear once'),
})
export type ReportCardEntriesSaveRequest = z.infer<typeof ReportCardEntriesSaveRequest>

// ---------------------------------------------------------------------------
// A report card's frozen content.

/** Term 1 after the half-yearly results; the final card after the annual results, with both terms. */
export const ReportCardKind = z.enum(['term_1', 'final'])
export type ReportCardKind = z.infer<typeof ReportCardKind>

export const REPORT_CARD_TERMS: Readonly<Record<ReportCardKind, readonly ExamTerm[]>> = {
  term_1: ['term_1'],
  final: ['term_1', 'term_2'],
}

export const ReportCardScholasticTerm = z.strictObject({
  term: ExamTerm,
  components: z
    .array(
      z.strictObject({
        exam: ExamKind,
        component: ExamComponent,
        /** Null when nothing was entered (for example, not on that exam's roster). */
        value: MarkValue.nullable(),
      }),
    )
    .max(4),
  percentage: z.number().min(0).max(100).nullable(),
  grade: z.string().min(1).max(8).nullable(),
})

export const ReportCardScholasticRow = z.strictObject({
  subject: NamedReference,
  terms: z.array(ReportCardScholasticTerm).min(1).max(2),
  /** The final card only: the mean of the two terms and its grade. */
  final: z
    .strictObject({ percentage: z.number().min(0).max(100).nullable(), grade: z.string().min(1).max(8).nullable() })
    .optional(),
})

export const ReportCardAttendance = z.strictObject({
  term: ExamTerm,
  /** School days in the term while the pupil was enrolled, up to the day it was published, less their leave days. */
  workingDays: z.number().int().nonnegative(),
  /** Present and late as whole days, half days as half. */
  daysPresent: z.number().nonnegative(),
  percentage: z.number().min(0).max(100).nullable(),
})

/**
 * Everything a published card shows except the remarks: the figures, and the
 * grade bands, the marks-or-grades choice and the layout as they stood at
 * that moment. A later change to any of them does not touch it.
 */
export const ReportCardContent = z.strictObject({
  card: ReportCardKind,
  school: z.strictObject({
    name: DisplayName.optional(),
    affiliationNumber: z.string().max(100).optional(),
    address: z.string().max(500).optional(),
    contact: z.string().max(300).optional(),
  }),
  showLogo: z.boolean(),
  student: ExamPupil,
  academicYear: NamedReference,
  grade: NamedReference,
  section: NamedReference,
  displayMode: ResultDisplayMode,
  gradeBands: GradeBands,
  blocks: z.array(ReportCardBlock).min(1).max(5),
  signatures: z.array(z.string().min(1).max(40)).max(3),
  footerNote: z.string().max(300),
  scholastic: z.array(ReportCardScholasticRow).max(30),
  coScholastic: z.array(z.strictObject({ term: ExamTerm, grades: CoScholasticGrades })).max(2),
  attendance: z.array(ReportCardAttendance).max(2),
  /** The final card only. */
  overall: z
    .strictObject({
      percentage: z.number().min(0).max(100).nullable(),
      grade: z.string().min(1).max(8).nullable(),
      result: z.enum(['pass', 'needs_improvement']).nullable(),
    })
    .optional(),
})
export type ReportCardContent = z.infer<typeof ReportCardContent>

export const ReportCardRemarks = z.strictObject({
  term_1: z.string().max(1000).optional(),
  term_2: z.string().max(1000).optional(),
})
export type ReportCardRemarks = z.infer<typeof ReportCardRemarks>

/**
 * One published version, as a reader sees it. In a family view of a card
 * published under grades, the scholastic rows carry grades only: every
 * component value and percentage is taken out on the server.
 */
export const ReportCardView = z.strictObject({
  id: Id,
  card: ReportCardKind,
  versionNumber: z.number().int().positive(),
  publishedAt: Timestamp,
  /** Whether this is the newest version of this pupil's card for that year. */
  latest: z.boolean(),
  view: ResultView,
  content: ReportCardContent,
  remarks: ReportCardRemarks,
  allowedActions: AllowedActions,
})
export type ReportCardView = z.infer<typeof ReportCardView>

export const ReportCardVersionSummary = z.strictObject({
  id: Id,
  card: ReportCardKind,
  versionNumber: z.number().int().positive(),
  publishedAt: Timestamp,
  latest: z.boolean(),
})
export type ReportCardVersionSummary = z.infer<typeof ReportCardVersionSummary>

export const StudentReportCardsRequest = z.strictObject({ academicYearId: Id })
export type StudentReportCardsRequest = z.infer<typeof StudentReportCardsRequest>

export const StudentReportCardsResponse = z.strictObject({
  student: ExamPupil,
  academicYear: NamedReference,
  /** Every published version for that year, newest first. */
  cards: z.array(ReportCardVersionSummary).max(100),
})
export type StudentReportCardsResponse = z.infer<typeof StudentReportCardsResponse>

// ---------------------------------------------------------------------------
// Sections: preparing and publishing.

export const ReportCardSectionsRequest = z.strictObject({ academicYearId: Id, card: ReportCardKind })
export type ReportCardSectionsRequest = z.infer<typeof ReportCardSectionsRequest>

export const ReportCardSectionSummary = z.strictObject({
  section: NamedReference,
  grade: NamedReference,
  /** The card's roster: enrolled on the first day of the last term's main exam. */
  pupils: z.number().int().nonnegative(),
  /** Pupils with every co-scholastic grade of the card's last term entered. */
  coScholasticEntered: z.number().int().nonnegative(),
  /** Pupils with a published version of this card. */
  published: z.number().int().nonnegative(),
  /** Pupils whose card would come out differently if published now. */
  changedSincePublished: z.number().int().nonnegative(),
  /** Every exam the card needs is published for this section, with no change since. */
  examsReady: z.boolean(),
  allowedActions: AllowedActions,
})
export type ReportCardSectionSummary = z.infer<typeof ReportCardSectionSummary>

export const ReportCardSectionsResponse = z.strictObject({
  academicYear: NamedReference,
  card: ReportCardKind,
  items: z.array(ReportCardSectionSummary).max(500),
})
export type ReportCardSectionsResponse = z.infer<typeof ReportCardSectionsResponse>

export const ReportCardSectionResponse = z.strictObject({
  section: NamedReference,
  grade: NamedReference,
  academicYear: NamedReference,
  card: ReportCardKind,
  /** The exams this card is built from, with where each stands for this section. */
  exams: z
    .array(
      z.strictObject({
        examId: Id,
        kind: ExamKind,
        published: z.boolean(),
        changedSincePublished: z.boolean(),
      }),
    )
    .max(4),
  readyToPublish: z.boolean(),
  blockedBy: ErrorReason.optional(),
  rows: z
    .array(
      z.strictObject({
        student: ExamPupil,
        latest: z
          .strictObject({
            versionId: Id,
            versionNumber: z.number().int().positive(),
            publishedAt: Timestamp,
            changedSince: z.boolean(),
          })
          .nullable(),
      }),
    )
    .max(200),
  allowedActions: AllowedActions,
})
export type ReportCardSectionResponse = z.infer<typeof ReportCardSectionResponse>

/** Publish the section's cards, or only the pupils named. Unchanged cards are skipped. */
export const ReportCardPublishRequest = z.strictObject({
  studentIds: z
    .array(Id)
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, 'Each pupil may appear once')
    .optional(),
})
export type ReportCardPublishRequest = z.infer<typeof ReportCardPublishRequest>

export const ReportCardPublishResponse = z.strictObject({
  published: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
})
export type ReportCardPublishResponse = z.infer<typeof ReportCardPublishResponse>

// ---------------------------------------------------------------------------
// Files.

export const ReportCardExportRequest = z.strictObject({})
export type ReportCardExportRequest = z.infer<typeof ReportCardExportRequest>

export const ReportCardExportJob = ExportJobSummary
export type ReportCardExportJob = z.infer<typeof ReportCardExportJob>

// ---------------------------------------------------------------------------
// The school logo, shown on the profile and printed on the card.

export const LOGO_MAX_BYTES = 524_288
export const LOGO_CONTENT_TYPES = ['image/png', 'image/jpeg'] as const
export const LogoContentType = z.enum(LOGO_CONTENT_TYPES)
export type LogoContentType = z.infer<typeof LogoContentType>
