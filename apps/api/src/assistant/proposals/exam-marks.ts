import { z } from 'zod'
import {
  EXAM_COMPONENTS,
  EXAM_PATTERN,
  ExamComponent,
  ExamMarksPreview,
  ExamPapersResponse,
  ExamSheet,
  GradeList,
  MarkStatus,
  markToTenths,
  type ExamKind,
  type ExamMarkLine,
  type ExamMarksCorrectionRequest,
  type ExamMarksSaveRequest,
  type ExamPaperSummary,
  type MarkValue,
} from '@erp/contracts'
import type { ToolCallContext } from '../tools/types.ts'
import { IdInput, className, clip, fetchParsed, seg } from '../tools/present.ts'
import { proposeTool, type PrepareOutcome } from './types.ts'
import { expected, foldSection, invalid, listed, matchPerson, personProblem, sameJson, shutOutcome, typedReason, without } from './match.ts'

/**
 * Entering or changing marks on one paper (one exam, one subject, one
 * section).
 *
 * While the paper's sheet is open to the person it is one save of the whole
 * sheet through the marks route, with a reason when a saved mark changes.
 * Once only the office's correction is open (after the re-check deadline, or
 * for someone who may correct but not enter), it is the correction route with
 * the changed cells and a reason. The sheet's window says which, and the
 * digest of the sheet keeps it true until Confirm.
 */


const Mark = z.union([
  z.number().min(0).max(1000).describe('The mark scored.'),
  MarkStatus.describe('absent, medical (medical leave) or exempt, in place of a mark.'),
])

const Input = z.object({
  paper: IdInput('The paper id, when a paper_marks or exam_papers answer gave it.').optional(),
  exam: z.string().trim().min(1).max(60).optional().describe('The exam as people say it: "periodic test 1", "half-yearly", "periodic test 2" or "annual".'),
  subject: z.string().trim().min(1).max(80).optional().describe('The subject by name, such as "Mathematics".'),
  section: z.string().trim().min(1).max(60).optional().describe('The class and section, such as "9A" or "Class 9 A".'),
  component: ExamComponent.optional().describe(
    'Which part the marks are for: periodic_test, notebook, subject_enrichment or written. Leave out for the written exam (or the periodic test on a periodic test paper).',
  ),
  marks: z
    .array(
      z.object({
        pupil: z.string().trim().min(1).max(120).describe('The pupil as the person named them: a name, a first name or an admission number.'),
        value: Mark,
        component: ExamComponent.optional().describe('Only when this mark is for a different part than `component`.'),
      }),
    )
    .min(1)
    .max(200)
    .describe('The marks to enter or change, one per pupil and part.'),
})
type Input = z.infer<typeof Input>

const examLabel = (kind: ExamKind) => EXAM_PATTERN[kind].label

/** What people call each exam, folded: lower case letters and digits only. */
const EXAM_WORDS: Readonly<Record<ExamKind, readonly string[]>> = {
  periodic_test_1: ['periodictest1', 'pt1', 'periodic1', 'unittest1', 'ut1', 'test1', 'firstperiodictest'],
  half_yearly: ['halfyearly', 'halfyearlyexam', 'halfyear', 'midterm', 'midtermexam', 'sa1'],
  periodic_test_2: ['periodictest2', 'pt2', 'periodic2', 'unittest2', 'ut2', 'test2', 'secondperiodictest'],
  annual: ['annual', 'annualexam', 'final', 'finalexam', 'finals', 'yearly', 'sa2'],
}

const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

function examKindsFor(said: string): Set<ExamKind> {
  const wanted = fold(said)
  const kinds = Object.keys(EXAM_WORDS) as ExamKind[]
  const exact = kinds.filter((kind) => EXAM_WORDS[kind].includes(wanted) || fold(kind) === wanted || fold(examLabel(kind)) === wanted)
  if (exact.length > 0) return new Set(exact)
  if (wanted.length < 4) return new Set()
  return new Set(kinds.filter((kind) => fold(examLabel(kind)).startsWith(wanted)))
}

function subjectMatches(said: string, papers: readonly ExamPaperSummary[]): ExamPaperSummary[] {
  const wanted = fold(said)
  const exact = papers.filter((paper) => fold(paper.subject.name) === wanted)
  if (exact.length > 0) return exact
  // "maths" and "math" for Mathematics, "eng" for English.
  const stem = wanted.endsWith('s') ? wanted.slice(0, -1) : wanted
  return papers.filter((paper) => stem.length >= 3 && fold(paper.subject.name).startsWith(stem))
}

type FoundPaper = { readonly ok: true; readonly paperId: string } | { readonly ok: false; readonly outcome: PrepareOutcome<never> }

/** One paper of the current year among the papers the person can read. */
async function findPaper(input: Input, context: ToolCallContext): Promise<FoundPaper> {
  if (input.paper !== undefined) return { ok: true, paperId: input.paper }
  if (input.exam === undefined && input.subject === undefined && input.section === undefined) {
    return { ok: false, outcome: invalid('Say which paper: the exam, the subject and the class.') }
  }
  if (context.academicYearId === null) {
    return { ok: false, outcome: invalid('There is no current academic year, so the paper has to be named by its id.') }
  }
  const found = await fetchParsed(context, ExamPapersResponse, '/exams/papers', { academicYearId: context.academicYearId })
  if (!found.ok) return { ok: false, outcome: found.outcome.status === 'failed' ? { status: 'failed' } : { status: 'not_available' } }
  const gradeList = await fetchParsed(context, GradeList, '/grades')
  const shortNames = new Map(gradeList.ok ? gradeList.body.map((grade) => [grade.id, grade.shortName]) : [])
  const label = (paper: ExamPaperSummary) =>
    `${examLabel(paper.exam.kind)}, ${paper.subject.name}, ${className(paper.grade, paper.section) ?? paper.section.name}`

  let papers = found.body.items
  if (input.exam !== undefined) {
    const kinds = examKindsFor(input.exam)
    if (kinds.size === 0) {
      return {
        ok: false,
        outcome: invalid(`No exam is called ${input.exam}. The exams are ${listed((Object.keys(EXAM_WORDS) as ExamKind[]).map(examLabel))}.`),
      }
    }
    papers = papers.filter((paper) => kinds.has(paper.exam.kind))
  }
  if (input.subject !== undefined) papers = subjectMatches(input.subject, papers)
  if (input.section !== undefined) {
    const wanted = foldSection(input.section)
    papers = papers.filter((paper) =>
      [className(paper.grade, paper.section) ?? paper.section.name, `${shortNames.get(paper.grade.id) ?? ''}${paper.section.name}`].some(
        (candidate) => foldSection(candidate) === wanted,
      ),
    )
  }
  if (papers.length === 1) return { ok: true, paperId: papers[0]!.id }
  if (papers.length === 0) return { ok: false, outcome: invalid('No paper you can see matches that exam, subject and class.') }
  return { ok: false, outcome: invalid(`More than one paper matches: ${listed(papers.map(label))}. Say which one.`) }
}

function sameMark(a: MarkValue, b: MarkValue): boolean {
  if (typeof a === 'number' && typeof b === 'number') return markToTenths(a) === markToTenths(b)
  return a === b
}

function markWords(value: MarkValue): string {
  if (typeof value === 'number') return String(value)
  return value === 'medical' ? 'medical leave' : value
}

/** The cells a preview would write: every one given a new value that differs from what is saved. */
function touchedCells(preview: ExamMarksPreview) {
  return preview.rows.flatMap((row) =>
    row.cells
      .filter((cell) => cell.proposed !== null && (cell.current === null || !sameMark(cell.current, cell.proposed)))
      .map((cell) => ({ row, cell, proposed: cell.proposed as MarkValue })),
  )
}

export const proposeExamMarks = proposeTool<Input, ExamMarksPreview>({
  name: 'propose_exam_marks',
  description:
    "Proposes entering or changing marks on one exam paper: one exam, one subject, one class. Name the exam, subject and class (or give the paper id) and each pupil by name with their mark or absent, medical or exempt. Nothing is saved: the person sees the marks sheet as an editable card and saves it with Confirm.",
  kind: 'exam_marks',
  permission: 'exams.record_marks',
  input: Input,
  preview: ExamMarksPreview,
  async prepare(input, context) {
    const paper = await findPaper(input, context)
    if (!paper.ok) return paper.outcome
    const checkPath = `/exams/papers/${seg(paper.paperId)}`
    const found = await fetchParsed(context, ExamSheet, checkPath)
    if (!found.ok) return found.outcome.status === 'failed' ? { status: 'failed' } : { status: 'not_available' }
    const sheet = found.body
    const window = sheet.paper.window
    if (!window.record && !window.correct) return shutOutcome(window)
    if (sheet.rows.length === 0) return invalid('Nobody is on the roster of that paper.')
    const office = !window.record

    const section = className(sheet.paper.grade, sheet.paper.section) ?? sheet.paper.section.name
    const base = clip(`${examLabel(sheet.paper.exam.kind)}, ${sheet.paper.subject.name}, ${section}`, 200)
    const components = sheet.components.map((component) => ({ component: component.key, label: component.label, maxMarks: component.maxMarks }))
    const keys = components.map((component) => component.component)
    const fallback = input.component ?? (keys.length === 1 ? keys[0]! : 'written')

    const named = new Map<string, MarkValue>()
    const cellKey = (studentId: string, component: ExamComponent) => `${studentId}:${component}`
    for (const line of input.marks) {
      const component = line.component ?? fallback
      const part = components.find((candidate) => candidate.component === component)
      if (part === undefined) {
        return invalid(
          `The ${base} paper has no ${EXAM_COMPONENTS[component].label.toLowerCase()} marks. It has ${listed(components.map((candidate) => candidate.label.toLowerCase()))}.`,
        )
      }
      const match = matchPerson(
        line.pupil,
        sheet.rows.map((row) => ({ item: row.student, name: row.student.name, code: row.student.admissionNumber, rollNumber: row.student.rollNumber })),
      )
      if (match.status !== 'one') return invalid(personProblem(line.pupil, match, `the ${section} ${sheet.paper.subject.name} marks sheet`))
      const value = line.value
      if (typeof value === 'number') {
        if (Math.abs(value * 10 - Math.round(value * 10)) > 1e-6) {
          return invalid(`${match.item.name}'s mark of ${value} has more than one decimal place.`)
        }
        if (value > part.maxMarks) {
          return invalid(`${match.item.name}'s mark of ${value} is more than the ${part.label.toLowerCase()} maximum of ${part.maxMarks}.`)
        }
      }
      const key = cellKey(match.item.id, component)
      const already = named.get(key)
      if (already !== undefined && !sameMark(already, value)) return invalid(`${line.pupil} is given two different ${part.label.toLowerCase()} marks.`)
      named.set(key, value)
    }

    const rows = sheet.rows.map((row) => ({
      studentId: row.student.id,
      name: row.student.name,
      rollNumber: row.student.rollNumber ?? null,
      cells: keys.map((component) => {
        const saved = row.cells.find((cell) => cell.component === component)
        return {
          component,
          current: saved?.value ?? null,
          proposed: named.get(cellKey(row.student.id, component)) ?? null,
          revision: saved?.revision ?? 0,
        }
      }),
    }))
    const preview: ExamMarksPreview = {
      kind: 'exam_marks',
      mode: 'first_entry',
      paperId: sheet.paper.id,
      route: office ? 'office_correction' : 'marks_sheet',
      title: base,
      components,
      rows,
    }
    const touched = touchedCells(preview)
    if (touched.length === 0) return invalid(`Those marks are already saved on ${base}.`)
    const mode = office || touched.some(({ cell }) => cell.current !== null) ? 'correction' : 'first_entry'
    const labelOf = new Map(components.map((component) => [component.component, component.label]))
    return {
      status: 'ok',
      draft: {
        kind: 'exam_marks',
        title: `${mode === 'first_entry' ? 'Enter marks' : 'Correct marks'}: ${base}`,
        preview: { ...preview, mode },
        checkPath,
        forModel: {
          summary: `${touched.length} ${touched.length === 1 ? 'mark' : 'marks'} for ${base}.`,
          mode,
          needsReason: mode === 'correction',
          officeCorrection: office,
          marks: touched.map(({ row, cell, proposed }) => ({
            name: row.name,
            part: labelOf.get(cell.component),
            value: markWords(proposed),
            ...(cell.current === null ? {} : { was: markWords(cell.current) }),
          })),
        },
        href: `/exams/papers/${seg(sheet.paper.id)}`,
      },
    }
  },
  sameTarget(original, edited) {
    if (edited.rows.length !== original.rows.length) return false
    if (!sameJson(without(original, ['rows', 'reasonKind', 'reason']), without(edited, ['rows', 'reasonKind', 'reason']))) return false
    return original.rows.every((row, index) => {
      const other = edited.rows[index]!
      if (other.cells.length !== row.cells.length) return false
      return (
        sameJson(without(row, ['cells']), without(other, ['cells'])) &&
        row.cells.every((cell, at) => sameJson(without(cell, ['proposed']), without(other.cells[at]!, ['proposed'])))
      )
    })
  },
  write(preview) {
    const maxOf = new Map(preview.components.map((component) => [component.component, component]))
    for (const row of preview.rows) {
      for (const cell of row.cells) {
        const part = maxOf.get(cell.component)
        if (typeof cell.proposed === 'number' && part !== undefined && cell.proposed > part.maxMarks) {
          return { problem: `${row.name}'s ${part.label.toLowerCase()} mark is more than the maximum of ${part.maxMarks}.` }
        }
      }
    }
    const touched = touchedCells(preview)
    if (touched.length === 0) return { problem: 'Nothing has changed.' }
    // Every line carries the revision the preview was read at, so the route
    // refuses the whole write if any of those cells moved since.
    const line = (studentId: string, cell: ExamMarksPreview['rows'][number]['cells'][number], value: MarkValue): ExamMarkLine => ({
      studentId,
      component: cell.component,
      value,
      ...expected(cell),
    })
    const reason = typedReason(preview.reason)

    if (preview.route === 'office_correction') {
      if (preview.reasonKind === undefined || reason === undefined) {
        return { problem: 'Choose why the marks are changing and add a reason.' }
      }
      const body: ExamMarksCorrectionRequest = {
        entries: touched.map(({ row, cell, proposed }) => line(row.studentId, cell, proposed)),
        reasonKind: preview.reasonKind,
        reason,
      }
      return { method: 'POST', path: `/exams/papers/${seg(preview.paperId)}/corrections`, body }
    }

    // The sheet is saved whole: every filled cell, the saved ones as they are.
    const entries = preview.rows.flatMap((row) =>
      row.cells.flatMap((cell) => {
        const value = cell.proposed ?? cell.current
        return value === null ? [] : [line(row.studentId, cell, value)]
      }),
    )
    const changesSaved = touched.some(({ cell }) => cell.current !== null)
    if (!changesSaved) {
      const body: ExamMarksSaveRequest = { entries }
      return { method: 'PUT', path: `/exams/papers/${seg(preview.paperId)}/marks`, body }
    }
    if (preview.reasonKind === undefined || reason === undefined) return { problem: 'Add a reason for changing saved marks.' }
    const body: ExamMarksSaveRequest = { entries, change: { reasonKind: preview.reasonKind, reason } }
    return { method: 'PUT', path: `/exams/papers/${seg(preview.paperId)}/marks`, body }
  },
  describeDone(preview) {
    const count = touchedCells(preview).length
    const verb = preview.route === 'office_correction' ? 'Corrected' : 'Saved'
    return `${verb} ${count} ${count === 1 ? 'mark' : 'marks'} for ${preview.title}.`
  },
})

