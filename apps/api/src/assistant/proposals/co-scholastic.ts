import { z } from 'zod'
import {
  CO_SCHOLASTIC_AREAS,
  CoScholasticArea,
  CoScholasticGrade,
  CoScholasticPreview,
  ReportCardEntriesResponse,
  ReportCardKind,
  type CoScholasticGrades,
  type ExamTerm,
  type ReportCardEntriesSaveRequest,
} from '@erp/contracts'
import { appPath, className, fetchParsed, seg } from '../tools/present.ts'
import { proposeTool } from './types.ts'
import { findSection, invalid, matchPerson, personProblem, sameJson, without } from './match.ts'

/**
 * The class teacher's co-scholastic grades and remarks for one section and
 * one report card. Only the pupils whose grades or remarks change are sent,
 * each with the version of the entry it replaces.
 *
 * Each row carries its entry's version (0 when nothing is saved), which the
 * save route checks, so a saved entry is changed exactly as on the report
 * cards screen and somebody else's newer save is never overwritten.
 */

const CARD_LABELS: Readonly<Record<ReportCardKind, string>> = { term_1: 'Term 1 report card', final: 'Final report card' }

/** The term whose entries a card is filled from: the final card's own term is term 2. */
const TERM_OF: Readonly<Record<ReportCardKind, ExamTerm>> = { term_1: 'term_1', final: 'term_2' }

const AREAS = CoScholasticArea.options

const Input = z.object({
  section: z.string().trim().min(1).max(60).describe('The class and section as people say it, such as "9A" or "Class 9 A", or its id.'),
  card: ReportCardKind.describe('term_1 for the Term 1 report card, final for the final report card (term 2).'),
  grades: z
    .array(
      z.object({
        pupil: z.string().trim().min(1).max(120).describe('The pupil as the person named them: a name, a first name or an admission number.'),
        area: CoScholasticArea.describe('work_education, art_education, health_physical_education or discipline.'),
        grade: CoScholasticGrade.describe('A, B or C.'),
      }),
    )
    .max(800)
    .optional()
    .describe('Grades to set, one per pupil and area.'),
  remarks: z
    .array(
      z.object({
        pupil: z.string().trim().min(1).max(120).describe('The pupil as the person named them.'),
        text: z.string().trim().min(1).max(1000).describe("The class teacher's remark for the report card."),
      }),
    )
    .max(200)
    .optional()
    .describe('Remarks to set, one per pupil.'),
})
type Input = z.infer<typeof Input>

type Row = CoScholasticPreview['rows'][number]

const EMPTY: CoScholasticGrades = { work_education: null, art_education: null, health_physical_education: null, discipline: null }

const remarkOf = (value: string | null | undefined): string | null => {
  const text = value?.trim() ?? ''
  return text === '' ? null : text
}

function rowChanged(row: Row): boolean {
  return AREAS.some((area) => row.proposed[area] !== row.current[area]) || remarkOf(row.proposedRemarks) !== remarkOf(row.currentRemarks)
}

export const proposeCoScholastic = proposeTool<Input, CoScholasticPreview>({
  name: 'propose_co_scholastic',
  description:
    "Proposes co-scholastic grades (A, B or C for work education, art education, health and physical education, discipline) and report card remarks for pupils of one class. Pass the class and pupils by name. Nothing is saved: the person sees the grades as an editable card and saves them with Confirm.",
  kind: 'co_scholastic',
  permission: 'report_cards.manage',
  input: Input,
  preview: CoScholasticPreview,
  async prepare(input, context) {
    if ((input.grades ?? []).length === 0 && (input.remarks ?? []).length === 0) {
      return invalid('Say which grades or remarks to set.')
    }
    const section = await findSection(context, input.section)
    if (!section.ok) return section.outcome
    const term = TERM_OF[input.card]
    const checkPath = `/report-cards/sections/${seg(section.id)}/terms/${term}/entries`
    const found = await fetchParsed(context, ReportCardEntriesResponse, checkPath)
    if (!found.ok) return found.outcome.status === 'failed' ? { status: 'failed' } : { status: 'not_available' }
    const body = found.body
    if (!body.allowedActions.includes('report_cards.manage')) return { status: 'not_available' }
    const label = className(body.grade, body.section) ?? body.section.name
    if (body.rows.length === 0) return invalid(`Nobody is on ${label}'s roster for the ${CARD_LABELS[input.card].toLowerCase()}.`)

    const candidates = body.rows.map((row) => ({
      item: row.student.id,
      name: row.student.name,
      code: row.student.admissionNumber,
      rollNumber: row.student.rollNumber,
    }))
    const where = `${label}'s roster`
    const named = new Map<string, CoScholasticGrade>()
    const grades = new Map<string, CoScholasticGrades>()
    const remarks = new Map<string, string>()
    for (const line of input.grades ?? []) {
      const match = matchPerson(line.pupil, candidates)
      if (match.status !== 'one') return invalid(personProblem(line.pupil, match, where))
      const key = `${match.item}:${line.area}`
      const already = named.get(key)
      if (already !== undefined && already !== line.grade) {
        return invalid(`${line.pupil} is given two different ${CO_SCHOLASTIC_AREAS[line.area].toLowerCase()} grades.`)
      }
      named.set(key, line.grade)
      const current = grades.get(match.item) ?? body.rows.find((row) => row.student.id === match.item)?.entry?.grades ?? EMPTY
      grades.set(match.item, { ...current, [line.area]: line.grade })
    }
    for (const line of input.remarks ?? []) {
      const match = matchPerson(line.pupil, candidates)
      if (match.status !== 'one') return invalid(personProblem(line.pupil, match, where))
      const already = remarks.get(match.item)
      if (already !== undefined && already !== line.text.trim()) return invalid(`${line.pupil} is given two different remarks.`)
      remarks.set(match.item, line.text.trim())
    }

    const rows: Row[] = body.rows.map((row) => {
      const current = row.entry?.grades ?? EMPTY
      const currentRemarks = row.entry?.remarks ?? null
      return {
        studentId: row.student.id,
        name: row.student.name,
        rollNumber: row.student.rollNumber ?? null,
        version: row.entry?.version ?? 0,
        current,
        proposed: grades.get(row.student.id) ?? current,
        currentRemarks,
        proposedRemarks: remarks.has(row.student.id) ? remarks.get(row.student.id)! : currentRemarks,
      }
    })
    const changed = rows.filter(rowChanged)
    if (changed.length === 0) return invalid(`Those grades and remarks are already saved for ${label}.`)

    const preview: CoScholasticPreview = {
      kind: 'co_scholastic',
      sectionId: body.section.id,
      sectionName: label.slice(0, 120),
      card: input.card,
      rows,
    }
    return {
      status: 'ok',
      draft: {
        kind: 'co_scholastic',
        title: `Co-scholastic grades and remarks, ${label}, ${CARD_LABELS[input.card]}`,
        preview,
        checkPath,
        forModel: {
          summary: `Grades or remarks for ${changed.length} ${changed.length === 1 ? 'pupil' : 'pupils'} of ${label}, ${CARD_LABELS[input.card]}.`,
          pupils: changed.map((row) => ({
            name: row.name,
            grades: Object.fromEntries(AREAS.filter((area) => row.proposed[area] !== row.current[area]).map((area) => [area, row.proposed[area]])),
            remarkChanged: remarkOf(row.proposedRemarks) !== remarkOf(row.currentRemarks),
          })),
        },
        href: appPath(`/exams/report-cards/sections/${seg(body.section.id)}`, { tab: 'entries', term }),
      },
    }
  },
  sameTarget(original, edited) {
    if (edited.rows.length !== original.rows.length) return false
    return (
      sameJson(without(original, ['rows']), without(edited, ['rows'])) &&
      original.rows.every((row, index) =>
        sameJson(without(row, ['proposed', 'proposedRemarks']), without(edited.rows[index]!, ['proposed', 'proposedRemarks'])),
      )
    )
  },
  write(preview) {
    const changed = preview.rows.filter(rowChanged)
    if (changed.length === 0) return { problem: 'Nothing has changed.' }
    const lines: ReportCardEntriesSaveRequest['rows'] = []
    for (const row of changed) {
      lines.push({ studentId: row.studentId, expectedVersion: row.version, grades: row.proposed, remarks: remarkOf(row.proposedRemarks) })
    }
    const term = TERM_OF[preview.card]
    const body: ReportCardEntriesSaveRequest = { rows: lines }
    return { method: 'PUT', path: `/report-cards/sections/${seg(preview.sectionId)}/terms/${term}/entries`, body }
  },
  describeDone(preview) {
    const count = preview.rows.filter(rowChanged).length
    return `Saved co-scholastic grades and remarks for ${count} ${count === 1 ? 'pupil' : 'pupils'} of ${preview.sectionName}, ${CARD_LABELS[preview.card]}.`
  },
})
