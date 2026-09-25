import { z } from 'zod'
import {
  AttendanceDayResponse,
  AttendanceSectionMonthResponse,
  AttendanceSectionsResponse,
  AttendanceStudentMonthResponse,
  StaffAttendanceDayResponse,
  StaffAttendanceMemberMonthResponse,
  type AttendanceMark,
  type AttendanceSummary,
} from '@erp/contracts'
import { readTool } from './types.ts'
import {
  DateInput,
  IdInput,
  MonthInput,
  appPath,
  capped,
  className,
  dateLabel,
  figuresCard,
  fetchParsed,
  monthLabel,
  num,
  ok,
  percent,
  seg,
  source,
  tableCard,
  tag,
  text,
  toolList,
} from './present.ts'

const MARK_LABELS: Readonly<Record<AttendanceMark, string>> = {
  present: 'Present',
  absent: 'Absent',
  late: 'Late',
  leave: 'Leave',
  half_day: 'Half day',
}

const markTag = (mark: AttendanceMark | undefined) => tag(mark ? MARK_LABELS[mark] : 'Not marked')

/** Present and unmarked last, so "who was absent" is at the top of the card. */
const MARK_ORDER: Readonly<Record<AttendanceMark | 'none', number>> = { absent: 0, late: 1, half_day: 2, leave: 3, none: 4, present: 5 }

function summaryForModel(summary: AttendanceSummary) {
  return {
    schoolDays: summary.schoolDays,
    present: summary.present,
    absent: summary.absent,
    late: summary.late,
    leave: summary.leave,
    halfDay: summary.halfDay,
    unmarked: summary.unmarked,
    percentage: summary.percentage,
  }
}

function summaryFigures(title: string, summary: AttendanceSummary) {
  return figuresCard(title, [
    { label: 'Attendance', value: percent(summary.percentage) },
    { label: 'School days', value: num(summary.schoolDays) },
    { label: 'Present', value: num(summary.present) },
    { label: 'Absent', value: num(summary.absent) },
    { label: 'Late', value: num(summary.late) },
    { label: 'Leave', value: num(summary.leave) },
    { label: 'Half day', value: num(summary.halfDay) },
    summary.unmarked > 0 ? { label: 'Not marked', value: num(summary.unmarked) } : undefined,
  ])
}

const date = () => DateInput('The day. Leave out for today.').optional()
const month = () => MonthInput('The month. Leave out for this month.').optional()

export const attendanceSectionsDay = readTool({
  name: 'attendance_sections_day',
  description:
    'For one day, every section you may see: whether its register is marked and how many pupils were present, absent, late or on leave.',
  permission: 'attendance.read',
  input: z.object({ date: date() }),
  async run(input, context) {
    const day = input.date ?? context.today
    const found = await fetchParsed(context, AttendanceSectionsResponse, '/attendance/sections', { date: day })
    if (!found.ok) return found.outcome
    const { items } = found.body
    const list = capped(items)
    const kind = found.body.day.kind
    return ok(
      {
        date: day,
        dayKind: kind,
        holidayName: found.body.day.holidayName,
        sections: list.items.map((row) => ({
          sectionId: row.section.id,
          section: className(row.grade, row.section),
          strength: row.strength,
          marked: row.marked,
          ...(row.counts ?? {}),
        })),
        totals: {
          sections: items.length,
          marked: items.filter((row) => row.marked).length,
          absent: items.reduce((sum, row) => sum + (row.counts?.absent ?? 0), 0),
        },
      },
      tableCard({
        title: `Attendance, ${dateLabel(day)}`,
        columns: [
          { key: 'section', label: 'Section' },
          { key: 'strength', label: 'Pupils', align: 'end' },
          { key: 'status', label: 'Register' },
          { key: 'present', label: 'Present', align: 'end' },
          { key: 'absent', label: 'Absent', align: 'end' },
          { key: 'late', label: 'Late', align: 'end' },
          { key: 'leave', label: 'Leave', align: 'end' },
        ],
        rows: list.items.map((row) => ({
          cells: {
            section: text(className(row.grade, row.section)),
            strength: num(row.strength),
            status: tag(row.marked ? 'Marked' : 'Not marked'),
            present: num(row.counts?.present),
            absent: num(row.counts?.absent),
            late: num(row.counts?.late),
            leave: num(row.counts?.leave),
          },
          href: appPath(`/attendance/sections/${seg(row.section.id)}`, { date: day }),
        })),
        total: list.total,
      }),
      source(`Attendance, ${dateLabel(day)}`, appPath('/attendance', { date: day })),
    )
  },
})

export const sectionAttendanceDay = readTool({
  name: 'section_attendance_day',
  description:
    "One section's register for one day: each pupil's mark (present, absent, late, leave, half day) or not marked yet.",
  permission: 'attendance.read',
  input: z.object({ sectionId: IdInput('The section id, from find_sections.'), date: date() }),
  async run(input, context) {
    const day = input.date ?? context.today
    const found = await fetchParsed(context, AttendanceDayResponse, `/attendance/sections/${seg(input.sectionId)}/days/${seg(day)}`)
    if (!found.ok) return found.outcome
    const body = found.body
    const label = className(body.grade, body.section) ?? body.section.name
    const rows = [...body.rows].sort(
      (a, b) =>
        MARK_ORDER[a.mark ?? 'none'] - MARK_ORDER[b.mark ?? 'none'] ||
        (a.student.rollNumber ?? 9999) - (b.student.rollNumber ?? 9999),
    )
    const list = capped(rows)
    const count = (mark: AttendanceMark) => body.rows.filter((row) => row.mark === mark).length
    return ok(
      {
        sectionId: body.section.id,
        section: label,
        date: body.date,
        dayKind: body.day.kind,
        holidayName: body.day.holidayName,
        marked: body.marked,
        counts: {
          pupils: body.rows.length,
          present: count('present'),
          absent: count('absent'),
          late: count('late'),
          leave: count('leave'),
          halfDay: count('half_day'),
          notMarked: body.rows.filter((row) => row.mark === undefined).length,
        },
        pupils: list.items.map((row) => ({ studentId: row.student.id, name: row.student.name, roll: row.student.rollNumber, mark: row.mark ?? 'not_marked' })),
      },
      tableCard({
        title: `Attendance, ${label}, ${dateLabel(body.date)}`,
        columns: [
          { key: 'roll', label: 'Roll', align: 'end' },
          { key: 'name', label: 'Pupil' },
          { key: 'mark', label: 'Mark' },
        ],
        rows: list.items.map((row) => ({
          cells: { roll: num(row.student.rollNumber), name: text(row.student.name), mark: markTag(row.mark) },
          href: `/students/${seg(row.student.id)}`,
        })),
        total: list.total,
      }),
      source(`Attendance, ${label}, ${dateLabel(body.date)}`, appPath(`/attendance/sections/${seg(body.section.id)}`, { date: body.date })),
    )
  },
})

export const sectionAttendanceMonth = readTool({
  name: 'section_attendance_month',
  description: "One section's attendance for a month: each pupil's school days, absences and percentage.",
  permission: 'attendance.read',
  input: z.object({ sectionId: IdInput('The section id, from find_sections.'), month: month() }),
  async run(input, context) {
    const wanted = input.month ?? context.today.slice(0, 7)
    const found = await fetchParsed(context, AttendanceSectionMonthResponse, `/attendance/sections/${seg(input.sectionId)}/months/${seg(wanted)}`)
    if (!found.ok) return found.outcome
    const body = found.body
    const label = className(body.grade, body.section) ?? body.section.name
    // Lowest attendance first: that is what people ask about.
    const rows = [...body.rows].sort((a, b) => (a.summary.percentage ?? 101) - (b.summary.percentage ?? 101))
    const list = capped(rows)
    return ok(
      {
        sectionId: body.section.id,
        section: label,
        month: body.month,
        pupils: list.items.map((row) => ({ studentId: row.student.id, name: row.student.name, roll: row.student.rollNumber, ...summaryForModel(row.summary) })),
        total: list.total,
      },
      tableCard({
        title: `Attendance, ${label}, ${monthLabel(body.month)}`,
        columns: [
          { key: 'name', label: 'Pupil' },
          { key: 'days', label: 'School days', align: 'end' },
          { key: 'present', label: 'Present', align: 'end' },
          { key: 'absent', label: 'Absent', align: 'end' },
          { key: 'late', label: 'Late', align: 'end' },
          { key: 'leave', label: 'Leave', align: 'end' },
          { key: 'percentage', label: 'Attendance', align: 'end' },
        ],
        rows: list.items.map((row) => ({
          cells: {
            name: text(row.student.name),
            days: num(row.summary.schoolDays),
            present: num(row.summary.present),
            absent: num(row.summary.absent),
            late: num(row.summary.late),
            leave: num(row.summary.leave),
            percentage: percent(row.summary.percentage),
          },
          href: appPath(`/attendance/students/${seg(row.student.id)}`, { month: body.month }),
        })),
        total: list.total,
      }),
      source(`Attendance, ${label}, ${monthLabel(body.month)}`, appPath(`/attendance/sections/${seg(body.section.id)}/month`, { month: body.month })),
    )
  },
})

export const studentAttendanceMonth = readTool({
  name: 'student_attendance_month',
  description: "One pupil's attendance for a month: the percentage, the counts and the dates they were absent, late or on leave.",
  permission: 'attendance.read',
  input: z.object({ studentId: IdInput('The pupil id, from find_students.'), month: month() }),
  async run(input, context) {
    const wanted = input.month ?? context.today.slice(0, 7)
    const found = await fetchParsed(context, AttendanceStudentMonthResponse, `/attendance/students/${seg(input.studentId)}/months/${seg(wanted)}`)
    if (!found.ok) return found.outcome
    const body = found.body
    const datesOf = (mark: AttendanceMark) => body.days.filter((day) => day.mark === mark).map((day) => day.date)
    return ok(
      {
        studentId: body.student.id,
        name: body.student.name,
        class: className(body.grade, body.section),
        month: body.month,
        ...summaryForModel(body.summary),
        absentOn: datesOf('absent'),
        lateOn: datesOf('late'),
        leaveOn: datesOf('leave'),
        halfDayOn: datesOf('half_day'),
      },
      summaryFigures(`Attendance of ${body.student.name}, ${monthLabel(body.month)}`, body.summary),
      source(`Attendance, ${body.student.name}, ${monthLabel(body.month)}`, appPath(`/attendance/students/${seg(body.student.id)}`, { month: body.month })),
    )
  },
})

export const staffAttendanceDay = readTool({
  name: 'staff_attendance_day',
  description: "The staff register for one day: each staff member's mark, or not marked yet.",
  permission: 'staff_attendance.read',
  input: z.object({ date: date() }),
  async run(input, context) {
    const day = input.date ?? context.today
    const found = await fetchParsed(context, StaffAttendanceDayResponse, `/staff-attendance/days/${seg(day)}`)
    if (!found.ok) return found.outcome
    const body = found.body
    const rows = [...body.rows].sort((a, b) => MARK_ORDER[a.mark ?? 'none'] - MARK_ORDER[b.mark ?? 'none'] || a.staff.name.localeCompare(b.staff.name))
    const list = capped(rows)
    const count = (mark: AttendanceMark) => body.rows.filter((row) => row.mark === mark).length
    return ok(
      {
        date: body.date,
        dayKind: body.day.kind,
        marked: body.marked,
        counts: {
          staff: body.rows.length,
          present: count('present'),
          absent: count('absent'),
          late: count('late'),
          leave: count('leave'),
          halfDay: count('half_day'),
          notMarked: body.rows.filter((row) => row.mark === undefined).length,
        },
        staff: list.items.map((row) => ({ staffId: row.staff.id, name: row.staff.name, mark: row.mark ?? 'not_marked' })),
      },
      tableCard({
        title: `Staff register, ${dateLabel(body.date)}`,
        columns: [
          { key: 'name', label: 'Staff member' },
          { key: 'designation', label: 'Designation' },
          { key: 'mark', label: 'Mark' },
        ],
        rows: list.items.map((row) => ({
          cells: { name: text(row.staff.name), designation: text(row.staff.designation), mark: markTag(row.mark) },
          href: `/attendance/staff/${seg(row.staff.id)}`,
        })),
        total: list.total,
      }),
      source(`Staff register, ${dateLabel(body.date)}`, appPath('/attendance/staff', { date: body.date })),
    )
  },
})

export const staffAttendanceMonth = readTool({
  name: 'staff_attendance_month',
  description: "One staff member's attendance for a month: the percentage, the counts and the dates they were away.",
  permission: 'staff_attendance.read',
  input: z.object({ staffId: IdInput('The staff id, from find_staff.'), month: month() }),
  async run(input, context) {
    const wanted = input.month ?? context.today.slice(0, 7)
    const found = await fetchParsed(context, StaffAttendanceMemberMonthResponse, `/staff-attendance/staff/${seg(input.staffId)}/months/${seg(wanted)}`)
    if (!found.ok) return found.outcome
    const body = found.body
    const datesOf = (mark: AttendanceMark) => body.days.filter((day) => day.mark === mark).map((day) => day.date)
    return ok(
      {
        staffId: body.staff.id,
        name: body.staff.name,
        month: body.month,
        ...summaryForModel(body.summary),
        absentOn: datesOf('absent'),
        lateOn: datesOf('late'),
        leaveOn: datesOf('leave'),
        halfDayOn: datesOf('half_day'),
      },
      summaryFigures(`Attendance of ${body.staff.name}, ${monthLabel(body.month)}`, body.summary),
      source(`Staff attendance, ${body.staff.name}, ${monthLabel(body.month)}`, appPath(`/attendance/staff/${seg(body.staff.id)}`, { month: body.month })),
    )
  },
})

export const ATTENDANCE_TOOLS = toolList(
  attendanceSectionsDay,
  sectionAttendanceDay,
  sectionAttendanceMonth,
  studentAttendanceMonth,
  staffAttendanceDay,
  staffAttendanceMonth,
)
