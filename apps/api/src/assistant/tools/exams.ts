import { z } from 'zod'
import {
  EXAM_COMPONENTS,
  EXAM_PATTERN,
  ExamKind,
  ExamListResponse,
  ExamOverview,
  ExamPapersResponse,
  ExamResultsResponse,
  ExamSheet,
  scoreParts,
  type ExamComponent,
  type ExamPaperSummary,
  type AssistantValue,
  type MarkValue,
} from '@erp/contracts'
import { readTool } from './types.ts'
import {
  IdInput,
  NO_YEAR,
  YearInput,
  appPath,
  capped,
  className,
  date,
  fetchParsed,
  humanise,
  num,
  ok,
  percent,
  seg,
  source,
  tableCard,
  tag,
  text,
  toolList,
  yearFor,
} from './present.ts'

const examLabel = (kind: ExamKind) => EXAM_PATTERN[kind].label

/** A mark, or the status in its place, as a card value. */
function markValue(value: MarkValue | undefined | null): AssistantValue {
  if (value === undefined || value === null) return { type: 'empty' }
  return typeof value === 'number' ? num(value) : tag(humanise(value))
}

function paperForModel(paper: ExamPaperSummary) {
  return {
    paperId: paper.id,
    exam: examLabel(paper.exam.kind),
    examId: paper.exam.id,
    section: className(paper.grade, paper.section),
    sectionId: paper.section.id,
    subject: paper.subject.name,
    subjectId: paper.subject.id,
    entered: paper.entered,
    expected: paper.expected,
    window: paper.window.state,
    published: paper.published,
  }
}

export const listExams = readTool({
  name: 'list_exams',
  description:
    "The year's exams (periodic tests, half-yearly, annual) with their dates, re-check deadline and how many sections are published.",
  permission: 'exams.read',
  input: z.object({ academicYearId: YearInput() }),
  async run(input, context) {
    const academicYearId = yearFor(input, context)
    if (academicYearId === null) return NO_YEAR
    const found = await fetchParsed(context, ExamListResponse, '/exams', { academicYearId })
    if (!found.ok) return found.outcome
    const body = found.body
    return ok(
      {
        academicYear: body.academicYear.name,
        academicYearId: body.academicYear.id,
        exams: body.items.map((exam) => ({
          examId: exam.id,
          exam: examLabel(exam.kind),
          kind: exam.kind,
          startsOn: exam.startsOn,
          endsOn: exam.endsOn,
          recheckDeadline: exam.recheckDeadline,
          locked: exam.locked,
          sectionsTotal: exam.sectionsTotal,
          sectionsPublished: exam.sectionsPublished,
        })),
      },
      tableCard({
        title: `Exams, ${body.academicYear.name}`,
        columns: [
          { key: 'exam', label: 'Exam' },
          { key: 'starts', label: 'Starts' },
          { key: 'ends', label: 'Ends' },
          { key: 'recheck', label: 'Re-check until' },
          { key: 'published', label: 'Sections published', align: 'end' },
        ],
        rows: body.items.map((exam) => ({
          cells: {
            exam: text(examLabel(exam.kind)),
            starts: date(exam.startsOn),
            ends: date(exam.endsOn),
            recheck: date(exam.recheckDeadline),
            published: text(`${exam.sectionsPublished} of ${exam.sectionsTotal}`),
          },
          href: `/exams/${seg(exam.id)}`,
        })),
      }),
      source(`Exams, ${body.academicYear.name}`, appPath('/exams', { academicYearId: input.academicYearId })),
    )
  },
})

export const examOverview = readTool({
  name: 'exam_overview',
  description: 'One exam across the school: for each section, whether marks are complete and whether results are published.',
  permission: 'exams.read',
  input: z.object({ examId: IdInput('The exam id, from list_exams.') }),
  async run(input, context) {
    const found = await fetchParsed(context, ExamOverview, `/exams/${seg(input.examId)}`)
    if (!found.ok) return found.outcome
    const { exam, sections } = found.body
    const list = capped(sections)
    const label = `${examLabel(exam.kind)}, ${exam.academicYear.name}`
    return ok(
      {
        examId: exam.id,
        exam: label,
        locked: exam.locked,
        sections: list.items.map((row) => ({
          sectionId: row.section.id,
          section: className(row.grade, row.section),
          pupils: row.pupils,
          complete: row.complete,
          published: row.publication !== null,
          changedSincePublished: row.publication?.changedSince ?? false,
          readyToPublish: row.readyToPublish,
          incompletePapers: row.papers.filter((paper) => !paper.complete).map((paper) => ({ paperId: paper.paperId, subject: paper.subject.name, entered: paper.entered, expected: paper.expected })),
        })),
        total: list.total,
      },
      tableCard({
        title: label,
        columns: [
          { key: 'section', label: 'Section' },
          { key: 'pupils', label: 'Pupils', align: 'end' },
          { key: 'marks', label: 'Marks' },
          { key: 'results', label: 'Results' },
        ],
        rows: list.items.map((row) => ({
          cells: {
            section: text(className(row.grade, row.section)),
            pupils: num(row.pupils),
            marks: tag(row.complete ? 'Complete' : 'Incomplete'),
            results: tag(row.publication === null ? 'Not published' : row.publication.changedSince ? 'Changed since published' : 'Published'),
          },
        })),
        total: list.total,
      }),
      source(label, `/exams/${seg(exam.id)}`),
    )
  },
})

export const examPapers = readTool({
  name: 'exam_papers',
  description:
    'Exam papers (one exam, one section, one subject) with how many marks are entered. Filter by exam, section or subject to find a paper id.',
  permission: 'exams.read',
  input: z.object({
    examId: IdInput('Only this exam.').optional(),
    sectionId: IdInput('Only this section.').optional(),
    subjectId: IdInput('Only this subject.').optional(),
    academicYearId: YearInput(),
  }),
  async run(input, context) {
    const academicYearId = yearFor(input, context)
    if (academicYearId === null) return NO_YEAR
    const found = await fetchParsed(context, ExamPapersResponse, '/exams/papers', {
      academicYearId,
      examId: input.examId,
      sectionId: input.sectionId,
      subjectId: input.subjectId,
    })
    if (!found.ok) return found.outcome
    const list = capped(found.body.items)
    return ok(
      { papers: list.items.map(paperForModel), total: list.total },
      tableCard({
        title: 'Exam papers',
        columns: [
          { key: 'exam', label: 'Exam' },
          { key: 'section', label: 'Section' },
          { key: 'subject', label: 'Subject' },
          { key: 'entered', label: 'Marks entered' },
          { key: 'state', label: 'Window' },
        ],
        rows: list.items.map((paper) => ({
          cells: {
            exam: text(examLabel(paper.exam.kind)),
            section: text(className(paper.grade, paper.section)),
            subject: text(paper.subject.name),
            entered: text(`${paper.entered} of ${paper.expected}`),
            state: tag(humanise(paper.window.state)),
          },
          href: `/exams/papers/${seg(paper.id)}`,
        })),
        total: list.total,
      }),
      source('Exam papers', appPath('/exams', { academicYearId: input.academicYearId })),
    )
  },
})

export const paperMarks = readTool({
  name: 'paper_marks',
  description:
    "One paper's marks sheet: each pupil's marks for each component (periodic test, notebook, subject enrichment, written) and their total out of 100.",
  permission: 'exams.read',
  input: z.object({ paperId: IdInput('The paper id, from exam_papers.') }),
  async run(input, context) {
    const found = await fetchParsed(context, ExamSheet, `/exams/papers/${seg(input.paperId)}`)
    if (!found.ok) return found.outcome
    const { paper, components, rows } = found.body
    const label = `${paper.subject.name}, ${className(paper.grade, paper.section)}, ${examLabel(paper.exam.kind)}`
    const scored = rows.map((row) => {
      const values = new Map(row.cells.map((cell) => [cell.component, cell.value]))
      const total = scoreParts(components.map((component) => ({ component: component.key, value: values.get(component.key) ?? null })))
      return { row, values, total }
    })
    const list = capped(scored)
    const componentName = (key: ExamComponent) => EXAM_COMPONENTS[key].label
    return ok(
      {
        paperId: paper.id,
        paper: label,
        components: components.map((component) => ({ key: component.key, label: component.label, outOf: component.maxMarks })),
        entered: paper.entered,
        expected: paper.expected,
        pupils: list.items.map(({ row, values, total }) => ({
          studentId: row.student.id,
          name: row.student.name,
          roll: row.student.rollNumber,
          marks: Object.fromEntries(components.map((component) => [component.key, values.get(component.key) ?? null])),
          percentage: total.percentage,
        })),
        total: list.total,
      },
      tableCard({
        title: label,
        columns: [
          { key: 'roll', label: 'Roll', align: 'end' },
          { key: 'name', label: 'Pupil' },
          ...components.map((component) => ({ key: component.key, label: `${componentName(component.key)} /${component.maxMarks}`, align: 'end' as const })),
          { key: 'total', label: 'Total', align: 'end' },
        ],
        rows: list.items.map(({ row, values, total }) => ({
          cells: {
            roll: num(row.student.rollNumber),
            name: text(row.student.name),
            ...Object.fromEntries(components.map((component) => [component.key, markValue(values.get(component.key))])),
            total: percent(total.percentage),
          },
        })),
        total: list.total,
      }),
      source(`Marks, ${label}`, `/exams/papers/${seg(paper.id)}`),
    )
  },
})

export const studentResults = readTool({
  name: 'student_results',
  description:
    "One pupil's exam results for a year: each subject's marks or grade in each exam. Parents see only published results.",
  permission: 'exams.read',
  input: z.object({
    studentId: IdInput('The pupil id, from find_students.'),
    exam: ExamKind.optional().describe('Only this exam.'),
    academicYearId: YearInput(),
  }),
  async run(input, context) {
    const academicYearId = yearFor(input, context)
    if (academicYearId === null) return NO_YEAR
    const found = await fetchParsed(context, ExamResultsResponse, `/exams/students/${seg(input.studentId)}/results`, { academicYearId })
    if (!found.ok) return found.outcome
    const body = found.body
    const exams = body.exams.filter((result) => input.exam === undefined || result.exam.kind === input.exam)
    const rows = exams.flatMap((result) => result.subjects.map((subject) => ({ result, subject })))
    const list = capped(rows)
    return ok(
      {
        studentId: body.student.id,
        name: body.student.name,
        class: className(body.grade, body.section),
        academicYear: body.academicYear.name,
        shows: body.displayMode,
        exams: exams.map((result) => ({
          exam: examLabel(result.exam.kind),
          examId: result.exam.id,
          publishedAt: result.publishedAt,
          subjects: result.subjects.map((subject) => ({
            subject: subject.subject.name,
            percentage: subject.percentage,
            grade: subject.grade,
            ...(subject.components.length > 0
              ? { marks: Object.fromEntries(subject.components.map((part) => [part.component, part.value ?? null])) }
              : {}),
          })),
        })),
      },
      tableCard({
        title: `Results of ${body.student.name}, ${body.academicYear.name}`,
        columns: [
          { key: 'exam', label: 'Exam' },
          { key: 'subject', label: 'Subject' },
          ...(body.displayMode === 'marks' ? [{ key: 'percentage', label: 'Score', align: 'end' as const }] : []),
          { key: 'grade', label: 'Grade' },
        ],
        rows: list.items.map(({ result, subject }) => ({
          cells: {
            exam: text(examLabel(result.exam.kind)),
            subject: text(subject.subject.name),
            percentage: percent(subject.percentage),
            grade: tag(subject.grade),
          },
        })),
        total: list.total,
      }),
      source(`Results, ${body.student.name}`, appPath(`/exams/students/${seg(body.student.id)}`, { academicYearId: input.academicYearId })),
    )
  },
})

export const EXAM_TOOLS = toolList(listExams, examOverview, examPapers, paperMarks, studentResults)
