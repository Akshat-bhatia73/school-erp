import { z } from 'zod'
import {
  AttendanceDayPreview,
  AttendanceDayResponse,
  AttendanceMark,
  type AttendanceCorrectionRequest,
  type AttendanceMarkRequest,
} from '@erp/contracts'
import { DateInput, appPath, className, dateLabel, fetchParsed, seg } from '../tools/present.ts'
import { proposeTool } from './types.ts'
import {
  countByMark,
  expected,
  findSection,
  invalid,
  markCounts,
  matchPerson,
  personProblem,
  sameJson,
  shortDate,
  shutOutcome,
  typedReason,
  unaskedProblem,
  without,
} from './match.ts'

/**
 * Marking or correcting one section's register for one day.
 *
 * Which write it becomes follows the register's own window, exactly as the
 * register screen decides: while the day's register is open to the person
 * (today, and they may mark it) it is the whole roll through the mark route,
 * whether or not it was marked earlier today; otherwise it is the office's
 * correction of the changed pupils with a reason.
 */

const Input = z.object({
  section: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .describe('The class and section as people say it, such as "9A", "Class 9 A" or "Nursery A", or its id.'),
  date: DateInput('The day. Leave out for today.').optional(),
  everyone: AttendanceMark.optional().describe(
    'The mark for every pupil not named in except. Leave out to keep the marks already saved. Only give it when the person said so ("everyone else present"): never guess it for pupils they did not mention.',
  ),
  except: z
    .array(
      z.object({
        pupil: z.string().trim().min(1).max(120).describe('The pupil as the person named them: a name, a first name or an admission number.'),
        mark: AttendanceMark.describe('The mark for this pupil.'),
      }),
    )
    .max(60)
    .optional()
    .describe('Pupils whose mark is different from everyone else, by name.'),
})
type Input = z.infer<typeof Input>

export const proposeAttendanceDay = proposeTool<Input, AttendanceDayPreview>({
  name: 'propose_attendance_day',
  description:
    "Proposes marking or correcting one class's attendance for a day, for example everyone present except two pupils who are absent. Pass the class and the pupils by name, not ids. Nothing is saved: the person sees the register as an editable card and saves it with Confirm.",
  kind: 'attendance_day',
  permission: 'attendance.record',
  input: Input,
  preview: AttendanceDayPreview,
  async prepare(input, context) {
    const section = await findSection(context, input.section)
    if (!section.ok) return section.outcome
    const date = input.date ?? context.today
    const checkPath = `/attendance/sections/${seg(section.id)}/days/${seg(date)}`
    const found = await fetchParsed(context, AttendanceDayResponse, checkPath)
    if (!found.ok) return found.outcome.status === 'failed' ? { status: 'failed' } : { status: 'not_available' }
    const day = found.body
    const label = className(day.grade, day.section) ?? day.section.name
    if (!day.window.record && !day.window.correct) return shutOutcome(day.window)
    if (day.rows.length === 0) return invalid(`Nobody is on ${label}'s register on ${dateLabel(date)}.`)

    const where = `${label}'s register`
    const named = new Map<string, AttendanceMark>()
    for (const line of input.except ?? []) {
      const match = matchPerson(
        line.pupil,
        day.rows.map((row) => ({
          item: row.student.id,
          name: row.student.name,
          code: row.student.admissionNumber,
          rollNumber: row.student.rollNumber,
        })),
      )
      if (match.status !== 'one') return invalid(personProblem(line.pupil, match, where))
      const already = named.get(match.item)
      if (already !== undefined && already !== line.mark) return invalid(`${line.pupil} is named twice with different marks.`)
      named.set(match.item, line.mark)
    }

    const mode = day.window.record ? 'first_entry' : 'correction'
    // A pupil the person did not name and nobody has marked is never given a
    // mark on a guess. Marking the day needs everybody, so the model must ask;
    // a correction simply leaves them as they are.
    const unasked = input.everyone === undefined ? day.rows.filter((row) => row.mark === undefined && !named.has(row.student.id)) : []
    if (mode === 'first_entry' && unasked.length > 0) return invalid(unaskedProblem(unasked.length, where))
    const rows = day.rows
      .filter((row) => !unasked.includes(row))
      .map((row) => ({
        studentId: row.student.id,
        name: row.student.name,
        rollNumber: row.student.rollNumber ?? null,
        current: row.mark ?? null,
        proposed: named.get(row.student.id) ?? input.everyone ?? row.mark!,
        revision: row.entry?.revision ?? 0,
      }))
    const changed = rows.filter((row) => row.proposed !== row.current)
    if (changed.length === 0) return invalid(`${label}'s register for ${dateLabel(date)} already has those marks.`)

    const preview: AttendanceDayPreview = {
      kind: 'attendance_day',
      mode,
      sectionId: day.section.id,
      sectionName: label.slice(0, 120),
      date,
      rows,
    }
    const counts = countByMark(rows.map((row) => row.proposed))
    return {
      status: 'ok',
      draft: {
        kind: 'attendance_day',
        title: `${mode === 'first_entry' ? 'Mark' : 'Correct'} ${label} for ${dateLabel(date)}`,
        preview,
        checkPath,
        forModel: {
          summary: `${mode === 'first_entry' ? 'Marking' : 'Correcting'} ${label} for ${dateLabel(date)}: ${markCounts(rows.map((row) => row.proposed))}.`,
          mode,
          needsReason: mode === 'correction',
          pupils: rows.length,
          changes: changed.length,
          counts: { present: counts.present, absent: counts.absent, late: counts.late, leave: counts.leave, halfDay: counts.half_day },
          notPresent: rows.filter((row) => row.proposed !== 'present').map((row) => ({ name: row.name, mark: row.proposed })),
          ...(unasked.length === 0 ? {} : { leftUnmarked: unasked.length }),
        },
        href: appPath(`/attendance/sections/${seg(day.section.id)}`, { date }),
      },
    }
  },
  sameTarget(original, edited) {
    if (edited.rows.length !== original.rows.length) return false
    return (
      sameJson(without(original, ['rows', 'reason']), without(edited, ['rows', 'reason'])) &&
      original.rows.every((row, index) => sameJson(without(row, ['proposed']), without(edited.rows[index]!, ['proposed'])))
    )
  },
  write(preview) {
    const path = `/attendance/sections/${seg(preview.sectionId)}/days/${seg(preview.date)}`
    const changed = preview.rows.filter((row) => row.proposed !== row.current)
    if (changed.length === 0) return { problem: 'Nothing has changed.' }
    if (preview.mode === 'first_entry') {
      const body: AttendanceMarkRequest = { marks: preview.rows.map((row) => ({ studentId: row.studentId, mark: row.proposed, ...expected(row) })) }
      return { method: 'PUT', path, body }
    }
    const reason = typedReason(preview.reason)
    if (reason === undefined) return { problem: 'Add a reason for changing a saved register.' }
    const body: AttendanceCorrectionRequest = {
      marks: changed.map((row) => ({ studentId: row.studentId, mark: row.proposed, ...expected(row) })),
      reason,
    }
    return { method: 'POST', path: `${path}/corrections`, body }
  },
  describeDone(preview) {
    if (preview.mode === 'correction') {
      const changed = preview.rows.filter((row) => row.proposed !== row.current).length
      return `Corrected ${preview.sectionName}'s register for ${shortDate(preview.date)}: ${changed} ${changed === 1 ? 'mark' : 'marks'} changed.`
    }
    return `Saved ${preview.sectionName}'s register for ${shortDate(preview.date)}: ${markCounts(preview.rows.map((row) => row.proposed))}.`
  },
})
