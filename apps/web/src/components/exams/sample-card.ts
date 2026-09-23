/**
 * A made-up card for the settings preview: a plausible pupil with a few subjects and both terms.
 * It never reaches the server; the preview lays it out with the unsaved settings so the office
 * sees what a change does before saving it.
 */
import {
  finalPercentage,
  gradeFor,
  overallResult,
  scoreParts,
  type ExamComponent,
  type ExamKind,
  type GradeBand,
  type MarkValue,
  type ReportCardContent,
  type ReportCardLayout,
  type ReportCardRemarks,
  type ResultDisplayMode,
} from '@erp/contracts'

type TermMarks = [pt: MarkValue, notebook: MarkValue, enrichment: MarkValue, written: MarkValue]

const SUBJECTS: Array<{ id: string; name: string; term1: TermMarks; term2: TermMarks }> = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'English', term1: [8, 4.5, 5, 66], term2: [9, 5, 4.5, 71] },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Hindi', term1: [7, 4, 4, 58.5], term2: [8, 4.5, 4, 62] },
  { id: '00000000-0000-4000-8000-000000000003', name: 'Mathematics', term1: [9.5, 5, 5, 74], term2: ['absent', 5, 5, 77] },
  { id: '00000000-0000-4000-8000-000000000004', name: 'Science', term1: [6.5, 4, 4.5, 52], term2: [7, 4, 5, 60.5] },
  { id: '00000000-0000-4000-8000-000000000005', name: 'Social science', term1: [8, 5, 4, 61], term2: ['medical', 4.5, 4, 65] },
]

const TERM_EXAMS = {
  term_1: ['periodic_test_1', 'half_yearly'],
  term_2: ['periodic_test_2', 'annual'],
} as const

function termRow(term: 'term_1' | 'term_2', marks: TermMarks, bands: readonly GradeBand[]) {
  const [pt, main] = TERM_EXAMS[term]
  const components: Array<{ exam: ExamKind; component: ExamComponent; value: MarkValue }> = [
    { exam: pt, component: 'periodic_test', value: marks[0] },
    { exam: main, component: 'notebook', value: marks[1] },
    { exam: main, component: 'subject_enrichment', value: marks[2] },
    { exam: main, component: 'written', value: marks[3] },
  ]
  const { percentage } = scoreParts(components)
  return { term, components, percentage, grade: gradeFor(bands, percentage) }
}

export function sampleCard(settings: {
  displayMode: ResultDisplayMode
  gradeBands: GradeBand[]
  layout: ReportCardLayout
  schoolName?: string
  /** The school's own header lines from its profile, when this person may read it. */
  header?: { affiliationNumber?: string; address?: string; contact?: string }
}): { content: ReportCardContent; remarks: ReportCardRemarks } {
  const bands = settings.gradeBands
  const scholastic = SUBJECTS.map((subject) => {
    const t1 = termRow('term_1', subject.term1, bands)
    const t2 = termRow('term_2', subject.term2, bands)
    const final = finalPercentage(t1.percentage, t2.percentage)
    return { subject: { id: subject.id, name: subject.name }, terms: [t1, t2], final: { percentage: final, grade: gradeFor(bands, final) } }
  })
  const overall = overallResult(scholastic.map((row) => row.final.percentage))
  const { layout } = settings
  const content: ReportCardContent = {
    card: 'final',
    school: {
      name: layout.headerLines.schoolName ? settings.schoolName ?? 'Your school' : undefined,
      affiliationNumber: layout.headerLines.affiliationNumber ? (settings.header?.affiliationNumber ?? '2130456') : undefined,
      address: layout.headerLines.address ? (settings.header?.address ?? '12 Station Road, Jaipur, Rajasthan 302001') : undefined,
      contact: layout.headerLines.contact ? (settings.header?.contact ?? '0141 555 0199 · office@example.org') : undefined,
    },
    showLogo: layout.showLogo,
    student: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Ananya Sharma', admissionNumber: 'ADM-2019-042', rollNumber: 7 },
    academicYear: { id: '00000000-0000-4000-8000-0000000000bb', name: '2026-27' },
    grade: { id: '00000000-0000-4000-8000-0000000000cc', name: 'Class 7' },
    section: { id: '00000000-0000-4000-8000-0000000000dd', name: 'B' },
    displayMode: settings.displayMode,
    gradeBands: bands,
    blocks: layout.blocks,
    signatures: layout.signatures,
    footerNote: layout.footerNote,
    scholastic,
    coScholastic: [
      { term: 'term_1', grades: { work_education: 'A', art_education: 'B', health_physical_education: 'A', discipline: 'A' } },
      { term: 'term_2', grades: { work_education: 'A', art_education: 'A', health_physical_education: 'B', discipline: 'A' } },
    ],
    attendance: [
      { term: 'term_1', workingDays: 112, daysPresent: 104.5, percentage: 93.3 },
      { term: 'term_2', workingDays: 98, daysPresent: 92, percentage: 93.9 },
    ],
    overall: { percentage: overall.percentage, grade: gradeFor(bands, overall.percentage), result: overall.result },
  }
  return {
    content,
    remarks: {
      term_1: 'Ananya works steadily and asks good questions in class.',
      term_2: 'A good year. More reading at home will help her written English.',
    },
  }
}
