import { z } from 'zod'
import {
  AttendanceMark,
  StaffAttendanceDayPreview,
  StaffAttendanceDayResponse,
  type StaffAttendanceCorrectionRequest,
  type StaffAttendanceMarkRequest,
} from '@erp/contracts'
import { DateInput, appPath, dateLabel, fetchParsed, seg } from '../tools/present.ts'
import { proposeTool } from './types.ts'
import {
  countByMark,
  invalid,
  markCounts,
  matchPerson,
  personProblem,
  sameJson,
  shortDate,
  shutOutcome,
  typedReason,
  without,
} from './match.ts'

/**
 * Marking or correcting the staff register for one day. The person's own row
 * is left out: nobody marks their own attendance. As with a class's register,
 * the window decides the write: the whole register through the mark route on
 * today, the office's correction of changed rows with a reason afterwards.
 */

const Input = z.object({
  date: DateInput('The day. Leave out for today.').optional(),
  everyone: AttendanceMark.optional().describe(
    'The mark for every staff member not named in except. Leave out to keep the marks already saved (anyone not marked yet becomes present).',
  ),
  except: z
    .array(
      z.object({
        person: z.string().trim().min(1).max(120).describe('The staff member as the person named them: a name, a first name or an employee code.'),
        mark: AttendanceMark.describe('The mark for this staff member.'),
      }),
    )
    .max(100)
    .optional()
    .describe('Staff whose mark is different from everyone else, by name.'),
})
type Input = z.infer<typeof Input>

export const proposeStaffAttendanceDay = proposeTool<Input, StaffAttendanceDayPreview>({
  name: 'propose_staff_attendance_day',
  description:
    'Proposes marking or correcting the staff attendance register for a day, for example everyone present except one teacher on leave. Pass staff by name, not ids. Nothing is saved: the person sees the register as an editable card and saves it with Confirm.',
  kind: 'staff_attendance_day',
  permission: 'staff_attendance.record',
  input: Input,
  preview: StaffAttendanceDayPreview,
  async prepare(input, context) {
    const date = input.date ?? context.today
    const checkPath = `/staff-attendance/days/${seg(date)}`
    const found = await fetchParsed(context, StaffAttendanceDayResponse, checkPath)
    if (!found.ok) return found.outcome.status === 'failed' ? { status: 'failed' } : { status: 'not_available' }
    const day = found.body
    if (!day.window.record && !day.window.correct) return shutOutcome(day.window)
    const register = day.rows.filter((row) => !row.self)
    if (register.length === 0) return invalid(`Nobody else is on the staff register on ${dateLabel(date)}.`)

    const candidate = (row: (typeof day.rows)[number]) => ({ item: row.staff.id, name: row.staff.name, code: row.staff.employeeCode })
    const self = day.rows.find((row) => row.self)
    const named = new Map<string, AttendanceMark>()
    for (const line of input.except ?? []) {
      const match = matchPerson(line.person, register.map(candidate))
      if (match.status === 'none' && self !== undefined && matchPerson(line.person, [candidate(self)]).status === 'one') {
        return invalid('Nobody marks their own attendance. A colleague in the office does it.')
      }
      if (match.status !== 'one') return invalid(personProblem(line.person, match, `the staff register for ${dateLabel(date)}`))
      const already = named.get(match.item)
      if (already !== undefined && already !== line.mark) return invalid(`${line.person} is named twice with different marks.`)
      named.set(match.item, line.mark)
    }

    const mode = day.window.record ? 'first_entry' : 'correction'
    const rows = register.map((row) => ({
      staffId: row.staff.id,
      name: row.staff.name,
      designation: row.staff.designation?.slice(0, 120) ?? null,
      current: row.mark ?? null,
      proposed: named.get(row.staff.id) ?? input.everyone ?? row.mark ?? 'present',
    }))
    const changed = rows.filter((row) => row.proposed !== row.current)
    if (changed.length === 0) return invalid(`The staff register for ${dateLabel(date)} already has those marks.`)

    const preview: StaffAttendanceDayPreview = { kind: 'staff_attendance_day', mode, date, rows }
    const counts = countByMark(rows.map((row) => row.proposed))
    return {
      status: 'ok',
      draft: {
        kind: 'staff_attendance_day',
        title: `${mode === 'first_entry' ? 'Mark' : 'Correct'} the staff register for ${dateLabel(date)}`,
        preview,
        checkPath,
        forModel: {
          summary: `${mode === 'first_entry' ? 'Marking' : 'Correcting'} the staff register for ${dateLabel(date)}: ${markCounts(rows.map((row) => row.proposed))}.`,
          mode,
          needsReason: mode === 'correction',
          staff: rows.length,
          changes: changed.length,
          counts: { present: counts.present, absent: counts.absent, late: counts.late, leave: counts.leave, halfDay: counts.half_day },
          notPresent: rows.filter((row) => row.proposed !== 'present').map((row) => ({ name: row.name, mark: row.proposed })),
        },
        href: appPath('/attendance/staff', { date }),
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
    const path = `/staff-attendance/days/${seg(preview.date)}`
    const changed = preview.rows.filter((row) => row.proposed !== row.current)
    if (changed.length === 0) return { problem: 'Nothing has changed.' }
    if (preview.mode === 'first_entry') {
      const body: StaffAttendanceMarkRequest = { marks: preview.rows.map((row) => ({ staffId: row.staffId, mark: row.proposed })) }
      return { method: 'PUT', path, body }
    }
    const reason = typedReason(preview.reason)
    if (reason === undefined) return { problem: 'Add a reason for changing a saved register.' }
    const body: StaffAttendanceCorrectionRequest = {
      marks: changed.map((row) => ({ staffId: row.staffId, mark: row.proposed })),
      reason,
    }
    return { method: 'POST', path: `${path}/corrections`, body }
  },
  describeDone(preview) {
    if (preview.mode === 'correction') {
      const changed = preview.rows.filter((row) => row.proposed !== row.current).length
      return `Corrected the staff register for ${shortDate(preview.date)}: ${changed} ${changed === 1 ? 'mark' : 'marks'} changed.`
    }
    return `Saved the staff register for ${shortDate(preview.date)}: ${markCounts(preview.rows.map((row) => row.proposed))}.`
  },
})
