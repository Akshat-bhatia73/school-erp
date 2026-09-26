import { z } from 'zod'
import {
  AvailableTeacherSuggestionList,
  BellSchedule,
  BellScheduleList,
  SectionDetail,
  SectionTimetable,
  StaffTimetable,
  SubstitutionDay,
  TeacherLoadList,
  TimetableCell,
} from '@erp/contracts'
import { readTool, type ToolCallContext } from './types.ts'
import {
  DAY_NAMES,
  DateInput,
  IdInput,
  NO_YEAR,
  YearInput,
  appPath,
  capped,
  dateLabel,
  dayOfWeek,
  fetchParsed,
  num,
  ok,
  seg,
  source,
  tableCard,
  tag,
  text,
  toolList,
  yearFor,
  type TableColumn,
  type TableRow,
} from './present.ts'

type Cell = z.infer<typeof TimetableCell>
type Period = { readonly name: string; readonly startTime: string; readonly endTime: string; readonly type: string }

/** The bell periods by index, from the class's own schedule or the year's first one; empty when none can be read. */
async function periodsFor(context: ToolCallContext, academicYearId: string, gradeId?: string): Promise<Map<number, Period>> {
  const periods = gradeId
    ? await fetchParsed(context, BellSchedule, `/timetable/bell-schedules/for-grade/${seg(gradeId)}`, { academicYearId })
    : await fetchParsed(context, BellScheduleList, '/timetable/bell-schedules', { academicYearId })
  if (!periods.ok) return new Map()
  const schedule = Array.isArray(periods.body) ? periods.body[0] : periods.body
  return new Map((schedule?.periods ?? []).map((period) => [period.index, period]))
}

const dayInput = z.number().int().min(1).max(6).optional().describe('Only this day: 1 is Monday ... 6 is Saturday. Leave out for the whole week.')

function periodLabel(periods: Map<number, Period>, index: number): string {
  const period = periods.get(index)
  return period ? `${period.name} (${period.startTime}–${period.endTime})` : `Period ${index + 1}`
}

/**
 * A week as a table: one row per period, one column per day. With a day, the
 * lessons of that day only, one row each.
 */
function weekCard(title: string, cells: readonly Cell[], periods: Map<number, Period>, describe: (cell: Cell) => string, day?: number) {
  if (day !== undefined) {
    const lessons = cells.filter((cell) => cell.dayOfWeek === day).sort((a, b) => a.periodIndex - b.periodIndex)
    return tableCard({
      title: `${title}, ${DAY_NAMES[day]}`,
      columns: [
        { key: 'period', label: 'Period' },
        { key: 'lesson', label: 'Lesson' },
        { key: 'room', label: 'Room' },
      ],
      rows: lessons.map((cell) => ({
        cells: { period: text(periodLabel(periods, cell.periodIndex)), lesson: text(describe(cell)), room: text(cell.roomNumber) },
      })),
    })
  }
  const days = [...new Set(cells.map((cell) => cell.dayOfWeek))].sort()
  const shownDays = days.length > 0 ? days : [1, 2, 3, 4, 5, 6]
  const indices = [...new Set(cells.map((cell) => cell.periodIndex))].sort((a, b) => a - b)
  const columns: TableColumn[] = [
    { key: 'period', label: 'Period' },
    ...shownDays.map((value) => ({ key: `d${value}`, label: DAY_NAMES[value]!.slice(0, 3) })),
  ]
  const rows: TableRow[] = indices.map((index) => ({
    cells: Object.fromEntries([
      ['period', text(periodLabel(periods, index))],
      ...shownDays.map((value) => {
        const cell = cells.find((candidate) => candidate.dayOfWeek === value && candidate.periodIndex === index)
        return [`d${value}`, text(cell ? describe(cell) : undefined)]
      }),
    ]),
  }))
  return tableCard({ title, columns, rows })
}

function cellForModel(cell: Cell) {
  return {
    day: DAY_NAMES[cell.dayOfWeek],
    periodIndex: cell.periodIndex,
    section: cell.section.name,
    sectionId: cell.section.id,
    subject: cell.subject.name,
    teacher: cell.teacher?.name,
    staffId: cell.teacher?.id,
    room: cell.roomNumber,
  }
}

export const sectionTimetable = readTool({
  name: 'section_timetable',
  description: "A section's weekly timetable: subject and teacher for every period, or for one day.",
  permission: 'timetable.read',
  input: z.object({ sectionId: IdInput('The section id, from find_sections.'), day: dayInput, academicYearId: YearInput() }),
  async run(input, context) {
    const academicYearId = yearFor(input, context)
    if (academicYearId === null) return NO_YEAR
    const found = await fetchParsed(context, SectionTimetable, `/timetable/sections/${seg(input.sectionId)}`, { academicYearId })
    if (!found.ok) return found.outcome
    const section = await fetchParsed(context, SectionDetail, `/sections/${seg(input.sectionId)}`)
    const gradeId = section.ok ? section.body.gradeId : undefined
    const periods = await periodsFor(context, academicYearId, gradeId)
    const cells = found.body.cells.filter((cell) => input.day === undefined || cell.dayOfWeek === input.day)
    const label = found.body.cells[0]?.section.name ?? 'Section'
    return ok(
      {
        sectionId: input.sectionId,
        section: label,
        periods: Object.fromEntries([...periods].map(([index, period]) => [index, `${period.name} ${period.startTime}-${period.endTime}`])),
        lessons: cells.map(cellForModel),
      },
      weekCard(`Timetable of ${label}`, cells, periods, (cell) => [cell.subject.name, cell.teacher?.name].filter(Boolean).join(' · '), input.day),
      source(`Timetable, ${label}`, appPath('/timetable', { gradeId, sectionId: input.sectionId })),
    )
  },
})

export const teacherTimetable = readTool({
  name: 'teacher_timetable',
  description: "A teacher's weekly timetable: which section and subject they teach each period, or on one day.",
  permission: 'timetable.read',
  input: z.object({ staffId: IdInput('The staff id, from find_staff.'), day: dayInput, academicYearId: YearInput() }),
  async run(input, context) {
    const academicYearId = yearFor(input, context)
    if (academicYearId === null) return NO_YEAR
    const found = await fetchParsed(context, StaffTimetable, `/timetable/staff/${seg(input.staffId)}`, { academicYearId })
    if (!found.ok) return found.outcome
    const periods = await periodsFor(context, academicYearId)
    const cells = found.body.cells.filter((cell) => input.day === undefined || cell.dayOfWeek === input.day)
    const name = found.body.cells[0]?.teacher?.name ?? 'the teacher'
    return ok(
      { staffId: input.staffId, teacher: name, periodsPerWeek: found.body.cells.length, lessons: cells.map(cellForModel) },
      weekCard(`Timetable of ${name}`, cells, periods, (cell) => `${cell.subject.name} · ${cell.section.name}`, input.day),
      source(`Timetable, ${name}`, appPath('/timetable/teachers', { staffId: input.staffId })),
    )
  },
})

type Schedule = z.infer<typeof BellSchedule>

/**
 * The period running at `now` (HH:MM, school time) on a weekday, from the
 * year's bell schedule for that day. Anything else is a sentence saying why
 * there is no lesson now, with the next period when there is one.
 */
function periodAt(
  schedule: Schedule,
  weekday: number,
  now: string,
): { readonly periodIndex: number } | { readonly note: string; readonly nextPeriod?: { periodIndex: number; name: string; startsAt: string } } {
  if (!schedule.workingDays.includes(weekday)) return { note: `${DAY_NAMES[weekday]} is not a school day on the bell schedule.` }
  let lessons = [...schedule.periods].sort((a, b) => a.startTime.localeCompare(b.startTime))
  // On Saturday only the first few teaching periods run, when the schedule says so.
  if (weekday === 6 && schedule.saturdayPeriodCount !== undefined) {
    const kept = new Set(lessons.filter((period) => period.type === 'period').slice(0, schedule.saturdayPeriodCount).map((period) => period.index))
    const last = lessons.filter((period) => kept.has(period.index)).at(-1)
    lessons = lessons.filter((period) =>
      period.type === 'period' ? kept.has(period.index) : last !== undefined && period.startTime < last.endTime,
    )
  }
  const current = lessons.find((period) => period.startTime <= now && now < period.endTime)
  if (current?.type === 'period') return { periodIndex: current.index }
  const next = lessons.find((period) => period.type === 'period' && period.startTime > now)
  const nextPeriod = next ? { periodIndex: next.index, name: next.name, startsAt: next.startTime } : undefined
  const first = lessons.find((period) => period.type === 'period')
  const note = current
    ? `It is ${current.name} now (${current.startTime}–${current.endTime}), not a lesson.`
    : first !== undefined && now < first.startTime
      ? 'School has not started yet.'
      : next === undefined
        ? 'Lessons are over for the day.'
        : 'No lesson is running now.'
  return nextPeriod ? { note, nextPeriod } : { note }
}

export const freeTeachers = readTool({
  name: 'free_teachers',
  description:
    'Teachers with no lesson in one period of one day, best suited first. Use it to find cover for an absent teacher, and for "who is free now" (leave out the period).',
  permission: 'timetable.manage_entries',
  input: z.object({
    periodIndex: z
      .number()
      .int()
      .min(0)
      .max(60)
      .optional()
      .describe('The period index, as section_timetable and teacher_timetable give it. Leave out for the period running now.'),
    date: DateInput('The day. Leave out for today.').optional(),
    subjectId: IdInput('Prefer teachers of this subject.').optional(),
    academicYearId: YearInput(),
  }),
  async run(input, context) {
    const academicYearId = yearFor(input, context)
    if (academicYearId === null) return NO_YEAR
    const day = input.date ?? context.today
    const weekday = dayOfWeek(day)
    if (weekday === 0) return ok({ date: day, note: 'That day is a Sunday; there are no lessons.' })
    let periodIndex = input.periodIndex
    if (periodIndex === undefined) {
      const askPeriod = { needs: 'periodIndex', hint: 'Say which period, or call bell_schedules for the periods.' }
      if (day !== context.today || context.now === undefined) return ok({ date: day, ...askPeriod })
      const schedules = await fetchParsed(context, BellScheduleList, '/timetable/bell-schedules', { academicYearId })
      if (!schedules.ok) return schedules.outcome
      const schedule = schedules.body.find((candidate) => candidate.workingDays.includes(weekday)) ?? schedules.body[0]
      if (schedule === undefined) return ok({ date: day, now: context.now, note: 'The school has no bell schedule, so there is no period now.' })
      const running = periodAt(schedule, weekday, context.now)
      if (!('periodIndex' in running)) return ok({ date: day, now: context.now, noPeriodNow: true, ...running })
      periodIndex = running.periodIndex
    }
    const found = await fetchParsed(context, AvailableTeacherSuggestionList, '/timetable/free-teachers', {
      academicYearId,
      dayOfWeek: weekday,
      periodIndex,
      subjectId: input.subjectId,
    })
    if (!found.ok) return found.outcome
    const list = capped(found.body)
    const periods = await periodsFor(context, academicYearId)
    return ok(
      {
        date: day,
        day: DAY_NAMES[weekday],
        ...(input.periodIndex === undefined ? { now: context.now } : {}),
        period: periodLabel(periods, periodIndex),
        periodIndex,
        teachers: list.items.map((row) => ({ staffId: row.teacher.id, name: row.teacher.name, teachesSubject: row.teachesSubject, periodsPerWeek: row.periodsPerWeek })),
        shown: list.items.length,
        total: list.total,
      },
      tableCard({
        title: `Free teachers, ${DAY_NAMES[weekday]}, ${periodLabel(periods, periodIndex)}`,
        columns: [
          { key: 'name', label: 'Teacher' },
          { key: 'subject', label: 'Teaches the subject' },
          { key: 'load', label: 'Periods a week', align: 'end' },
        ],
        rows: list.items.map((row) => ({
          cells: { name: text(row.teacher.name), subject: tag(row.teachesSubject ? 'Yes' : 'No'), load: num(row.periodsPerWeek) },
        })),
        total: list.total,
      }),
      source(`Substitutions, ${dateLabel(day)}`, appPath('/timetable/substitutions', { date: day })),
    )
  },
})

export const substitutionsOnDay = readTool({
  name: 'substitutions_on_day',
  description: 'The cover arranged for absent teachers on one day: period, section, subject, who is away and who covers.',
  permission: 'timetable.read',
  input: z.object({ date: DateInput('The day. Leave out for today.').optional() }),
  async run(input, context) {
    const day = input.date ?? context.today
    const found = await fetchParsed(context, SubstitutionDay, '/timetable/substitutions', { date: day })
    if (!found.ok) return found.outcome
    const list = capped(found.body.substitutions)
    const periods = context.academicYearId ? await periodsFor(context, context.academicYearId) : new Map<number, Period>()
    return ok(
      {
        date: day,
        substitutions: list.items.map((row) => ({
          periodIndex: row.periodIndex,
          period: periodLabel(periods, row.periodIndex),
          section: row.section.name,
          subject: row.subject.name,
          absentTeacher: row.absentTeacher.name,
          substituteTeacher: row.substituteTeacher?.name ?? null,
          notified: row.notified,
        })),
        shown: list.items.length,
        total: list.total,
      },
      tableCard({
        title: `Substitutions, ${dateLabel(day)}`,
        columns: [
          { key: 'period', label: 'Period' },
          { key: 'section', label: 'Section' },
          { key: 'subject', label: 'Subject' },
          { key: 'absent', label: 'Away' },
          { key: 'cover', label: 'Cover' },
        ],
        rows: list.items.map((row) => ({
          cells: {
            period: text(periodLabel(periods, row.periodIndex)),
            section: text(row.section.name),
            subject: text(row.subject.name),
            absent: text(row.absentTeacher.name),
            cover: row.substituteTeacher ? text(row.substituteTeacher.name) : tag('No cover'),
          },
        })),
        total: list.total,
      }),
      source(`Substitutions, ${dateLabel(day)}`, appPath('/timetable/substitutions', { date: day })),
    )
  },
})

export const teacherLoads = readTool({
  name: 'teacher_loads',
  description: 'How many periods a week each teacher teaches, in how many sections and subjects.',
  permission: 'timetable.read_teacher_loads',
  input: z.object({ academicYearId: YearInput() }),
  async run(input, context) {
    const academicYearId = yearFor(input, context)
    if (academicYearId === null) return NO_YEAR
    const found = await fetchParsed(context, TeacherLoadList, '/timetable/teacher-loads', { academicYearId })
    if (!found.ok) return found.outcome
    const sorted = [...found.body].sort((a, b) => b.periodsPerWeek - a.periodsPerWeek)
    const list = capped(sorted)
    return ok(
      {
        teachers: list.items.map((row) => ({ staffId: row.teacher.id, name: row.teacher.name, periodsPerWeek: row.periodsPerWeek, sections: row.sectionsCount, subjects: row.subjectsCount })),
        shown: list.items.length,
        total: list.total,
      },
      tableCard({
        title: 'Teacher loads',
        columns: [
          { key: 'name', label: 'Teacher' },
          { key: 'periods', label: 'Periods a week', align: 'end' },
          { key: 'sections', label: 'Sections', align: 'end' },
          { key: 'subjects', label: 'Subjects', align: 'end' },
        ],
        rows: list.items.map((row) => ({
          cells: { name: text(row.teacher.name), periods: num(row.periodsPerWeek), sections: num(row.sectionsCount), subjects: num(row.subjectsCount) },
          href: appPath('/timetable/teachers', { staffId: row.teacher.id }),
        })),
        total: list.total,
      }),
      source('Teacher loads', '/timetable/teachers'),
    )
  },
})

export const bellSchedules = readTool({
  name: 'bell_schedules',
  description: 'The school day: each period and break with its start and end time, for each bell schedule of the year.',
  permission: 'timetable.read',
  input: z.object({ academicYearId: YearInput() }),
  async run(input, context) {
    const academicYearId = yearFor(input, context)
    if (academicYearId === null) return NO_YEAR
    const found = await fetchParsed(context, BellScheduleList, '/timetable/bell-schedules', { academicYearId })
    if (!found.ok) return found.outcome
    const schedules = found.body
    const rows = schedules.flatMap((schedule) =>
      schedule.periods.map((period) => ({ schedule: schedule.name, ...period })),
    )
    return ok(
      {
        schedules: schedules.map((schedule) => ({
          name: schedule.name,
          workingDays: schedule.workingDays.map((value) => DAY_NAMES[value]),
          periods: schedule.periods.map((period) => ({ index: period.index, name: period.name, start: period.startTime, end: period.endTime, type: period.type })),
        })),
      },
      tableCard({
        title: 'Bell schedule',
        columns: [
          ...(schedules.length > 1 ? [{ key: 'schedule', label: 'Schedule' }] : []),
          { key: 'name', label: 'Period' },
          { key: 'start', label: 'Starts' },
          { key: 'end', label: 'Ends' },
          { key: 'type', label: 'Type' },
        ],
        rows: rows.map((row) => ({
          cells: { schedule: text(row.schedule), name: text(row.name), start: text(row.startTime), end: text(row.endTime), type: tag(row.type) },
        })),
      }),
      source('Periods and bells', '/timetable/periods'),
    )
  },
})

export const TIMETABLE_TOOLS = toolList(
  sectionTimetable,
  teacherTimetable,
  freeTeachers,
  substitutionsOnDay,
  teacherLoads,
  bellSchedules,
)
