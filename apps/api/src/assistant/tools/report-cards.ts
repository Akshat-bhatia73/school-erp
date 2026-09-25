import { z } from 'zod'
import {
  CO_SCHOLASTIC_AREAS,
  ReportCardKind,
  ReportCardSectionResponse,
  ReportCardSectionsResponse,
  ReportCardView,
  StudentReportCardsResponse,
  type CoScholasticArea,
} from '@erp/contracts'
import { readTool } from './types.ts'
import {
  IdInput,
  NO_YEAR,
  YearInput,
  appPath,
  capped,
  className,
  datetime,
  fetchParsed,
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

const CARD_LABELS: Readonly<Record<ReportCardKind, string>> = { term_1: 'Term 1 report card', final: 'Final report card' }

const cardInput = () => ReportCardKind.optional().describe('term_1 (after the half-yearly) or final (after the annual). Term 1 by default.')

export const reportCardSections = readTool({
  name: 'report_card_sections',
  description: 'For one kind of report card, every section: how many pupils have a published card and whether the section is ready to publish.',
  permission: 'report_cards.read',
  input: z.object({ card: cardInput(), academicYearId: YearInput() }),
  async run(input, context) {
    const academicYearId = yearFor(input, context)
    if (academicYearId === null) return NO_YEAR
    const card = input.card ?? 'term_1'
    const found = await fetchParsed(context, ReportCardSectionsResponse, '/report-cards/sections', { academicYearId, card })
    if (!found.ok) return found.outcome
    const body = found.body
    const list = capped(body.items)
    const title = `${CARD_LABELS[card]}s, ${body.academicYear.name}`
    return ok(
      {
        card,
        academicYear: body.academicYear.name,
        sections: list.items.map((row) => ({
          sectionId: row.section.id,
          section: className(row.grade, row.section),
          pupils: row.pupils,
          published: row.published,
          changedSincePublished: row.changedSincePublished,
          coScholasticEntered: row.coScholasticEntered,
          examsReady: row.examsReady,
        })),
        total: list.total,
      },
      tableCard({
        title,
        columns: [
          { key: 'section', label: 'Section' },
          { key: 'pupils', label: 'Pupils', align: 'end' },
          { key: 'published', label: 'Published', align: 'end' },
          { key: 'grades', label: 'Co-scholastic done', align: 'end' },
          { key: 'exams', label: 'Exams' },
        ],
        rows: list.items.map((row) => ({
          cells: {
            section: text(className(row.grade, row.section)),
            pupils: num(row.pupils),
            published: num(row.published),
            grades: num(row.coScholasticEntered),
            exams: tag(row.examsReady ? 'Ready' : 'Not ready'),
          },
          href: appPath(`/exams/report-cards/sections/${seg(row.section.id)}`, { tab: 'cards', card }),
        })),
        total: list.total,
      }),
      source(title, appPath('/exams/report-cards', { academicYearId: input.academicYearId, card })),
    )
  },
})

export const sectionReportCards = readTool({
  name: 'section_report_cards',
  description: "One section's report cards of one kind: each pupil's newest published version, if any, and whether it has changed since.",
  permission: 'report_cards.read',
  input: z.object({ sectionId: IdInput('The section id, from find_sections.'), card: cardInput() }),
  async run(input, context) {
    const card = input.card ?? 'term_1'
    const found = await fetchParsed(context, ReportCardSectionResponse, `/report-cards/sections/${seg(input.sectionId)}/cards/${seg(card)}`)
    if (!found.ok) return found.outcome
    const body = found.body
    const label = className(body.grade, body.section) ?? body.section.name
    const list = capped(body.rows)
    const title = `${CARD_LABELS[card]}s, ${label}`
    return ok(
      {
        sectionId: body.section.id,
        section: label,
        card,
        academicYear: body.academicYear.name,
        readyToPublish: body.readyToPublish,
        exams: body.exams.map((exam) => ({ kind: exam.kind, published: exam.published, changedSincePublished: exam.changedSincePublished })),
        pupils: list.items.map((row) => ({
          studentId: row.student.id,
          name: row.student.name,
          versionId: row.latest?.versionId ?? null,
          publishedAt: row.latest?.publishedAt,
          changedSince: row.latest?.changedSince,
        })),
        total: list.total,
      },
      tableCard({
        title,
        columns: [
          { key: 'name', label: 'Pupil' },
          { key: 'status', label: 'Card' },
          { key: 'published', label: 'Published at' },
        ],
        rows: list.items.map((row) => ({
          cells: {
            name: text(row.student.name),
            status: tag(row.latest === null ? 'Not published' : row.latest.changedSince ? 'Changed since published' : 'Published'),
            published: datetime(row.latest?.publishedAt),
          },
          ...(row.latest ? { href: `/exams/report-cards/${seg(row.latest.versionId)}` } : {}),
        })),
        total: list.total,
      }),
      source(title, appPath(`/exams/report-cards/sections/${seg(body.section.id)}`, { tab: 'cards', card })),
    )
  },
})

export const studentReportCards = readTool({
  name: 'student_report_cards',
  description: "Every published report card of one pupil for a year, newest first, with the version id to open one.",
  permission: 'report_cards.read',
  input: z.object({ studentId: IdInput('The pupil id, from find_students.'), academicYearId: YearInput() }),
  async run(input, context) {
    const academicYearId = yearFor(input, context)
    if (academicYearId === null) return NO_YEAR
    const found = await fetchParsed(context, StudentReportCardsResponse, `/report-cards/students/${seg(input.studentId)}`, { academicYearId })
    if (!found.ok) return found.outcome
    const body = found.body
    const list = capped(body.cards)
    return ok(
      {
        studentId: body.student.id,
        name: body.student.name,
        academicYear: body.academicYear.name,
        cards: list.items.map((card) => ({ versionId: card.id, card: card.card, version: card.versionNumber, publishedAt: card.publishedAt, latest: card.latest })),
      },
      tableCard({
        title: `Report cards of ${body.student.name}, ${body.academicYear.name}`,
        columns: [
          { key: 'card', label: 'Card' },
          { key: 'version', label: 'Version', align: 'end' },
          { key: 'published', label: 'Published at' },
          { key: 'latest', label: 'Status' },
        ],
        rows: list.items.map((card) => ({
          cells: {
            card: text(CARD_LABELS[card.card]),
            version: num(card.versionNumber),
            published: datetime(card.publishedAt),
            latest: tag(card.latest ? 'Latest' : 'Replaced'),
          },
          href: `/exams/report-cards/${seg(card.id)}`,
        })),
        total: list.total,
      }),
      source(`Report cards, ${body.student.name}`, appPath(`/exams/students/${seg(body.student.id)}`, { academicYearId: input.academicYearId })),
    )
  },
})

export const reportCard = readTool({
  name: 'report_card',
  description:
    'One published report card: each subject with its term percentages and grades, co-scholastic grades, attendance, the overall result and the class teacher remarks.',
  permission: 'report_cards.read',
  input: z.object({ versionId: IdInput('The report card version id, from student_report_cards or section_report_cards.') }),
  async run(input, context) {
    const found = await fetchParsed(context, ReportCardView, `/report-cards/versions/${seg(input.versionId)}`)
    if (!found.ok) return found.outcome
    const view = found.body
    const { content } = view
    const href = `/exams/report-cards/${seg(view.id)}`
    const title = `${CARD_LABELS[view.card]}, ${content.student.name}, ${content.academicYear.name}`
    const term = (row: (typeof content.scholastic)[number], key: 'term_1' | 'term_2') => row.terms.find((value) => value.term === key)
    const showMarks = content.displayMode === 'marks'
    return ok(
      {
        versionId: view.id,
        card: view.card,
        version: view.versionNumber,
        latest: view.latest,
        publishedAt: view.publishedAt,
        studentId: content.student.id,
        name: content.student.name,
        class: className(content.grade, content.section),
        shows: content.displayMode,
        subjects: content.scholastic.map((row) => ({
          subject: row.subject.name,
          terms: row.terms.map((value) => ({ term: value.term, percentage: value.percentage, grade: value.grade })),
          ...(row.final ? { final: row.final } : {}),
        })),
        coScholastic: content.coScholastic.map((value) => ({
          term: value.term,
          grades: Object.fromEntries(
            (Object.keys(value.grades) as CoScholasticArea[]).map((area) => [CO_SCHOLASTIC_AREAS[area], value.grades[area]]),
          ),
        })),
        attendance: content.attendance,
        overall: content.overall,
        remarks: view.remarks,
      },
      tableCard({
        title,
        columns: [
          { key: 'subject', label: 'Subject' },
          ...(showMarks ? [{ key: 't1', label: 'Term 1', align: 'end' as const }] : []),
          { key: 'g1', label: 'Term 1 grade' },
          ...(view.card === 'final'
            ? [
                ...(showMarks ? [{ key: 't2', label: 'Term 2', align: 'end' as const }] : []),
                { key: 'g2', label: 'Term 2 grade' },
                ...(showMarks ? [{ key: 'final', label: 'Final', align: 'end' as const }] : []),
                { key: 'gf', label: 'Final grade' },
              ]
            : []),
        ],
        rows: content.scholastic.map((row) => ({
          cells: {
            subject: text(row.subject.name),
            t1: percent(term(row, 'term_1')?.percentage),
            g1: tag(term(row, 'term_1')?.grade),
            t2: percent(term(row, 'term_2')?.percentage),
            g2: tag(term(row, 'term_2')?.grade),
            final: percent(row.final?.percentage),
            gf: tag(row.final?.grade),
          },
        })),
      }),
      source(title, href),
    )
  },
})

export const REPORT_CARD_TOOLS = toolList(reportCardSections, sectionReportCards, studentReportCards, reportCard)
