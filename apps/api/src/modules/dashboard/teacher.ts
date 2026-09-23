import { sql } from 'drizzle-orm'
import {
  enrollments as enrollmentsTable,
  sections as sectionsTable,
  students as studentsTable,
  timetableEntries,
} from '@erp/db/schema'
import { loadRelationshipFactsFor, type AuthzConnection } from '@erp/authz'
import type { RequestContext } from '@erp/contracts/server'
import type {
  DashboardBirthday,
  DashboardClassAttendance,
  DashboardLesson,
  DashboardTimelineSlot,
  TeacherDashboard,
} from '@erp/contracts'
import { readPlan } from '../shared/index.ts'
import { label, predicateFor, rows } from './queries.ts'
import {
  addDays,
  birthdayMonthDay,
  buildCalendar,
  currentAcademicYear,
  optionalBlock,
} from './calendar.ts'
import { loadSchedules, scheduleForGrade, type Schedule } from './bell.ts'
import { enrollmentScope, substitutionScope } from './office.ts'
import { attendancePlans } from '../attendance/figures.ts'
import { marksToEnter } from './exams.ts'

type WeekRow = {
  section_id: string
  grade_id: string
  grade_name: string
  section_name: string
  subject_id: string
  subject_name: string
  day_of_week: number
  period_index: number
  room_number: string | null
}

/** The caller's own periods for the whole week, through the timetable plan. */
async function ownWeek(
  conn: AuthzConnection,
  context: RequestContext,
  staffId: string,
  yearId: string,
): Promise<WeekRow[]> {
  const plan = await readPlan(conn, context, 'timetable.read', 'timetable')
  return rows<WeekRow>(
    conn,
    sql`SELECT sct.id AS section_id, sct.grade_id AS grade_id, grd.name AS grade_name,
               sct.name AS section_name, sbj.id AS subject_id, sbj.name AS subject_name,
               ${timetableEntries.dayOfWeek} AS day_of_week,
               ${timetableEntries.periodIndex} AS period_index,
               ${timetableEntries.roomNumber} AS room_number
          FROM ${timetableEntries}
          JOIN sections sct ON sct.school_id = ${timetableEntries.schoolId} AND sct.id = ${timetableEntries.sectionId}
          JOIN grades grd ON grd.school_id = sct.school_id AND grd.id = sct.grade_id
          JOIN subjects sbj ON sbj.school_id = ${timetableEntries.schoolId} AND sbj.id = ${timetableEntries.subjectId}
         WHERE ${predicateFor(plan)}
           AND ${timetableEntries.staffId} = ${staffId}::uuid
           AND ${timetableEntries.academicYearId} = ${yearId}::uuid
         ORDER BY day_of_week, period_index`,
  )
}

/** The bell schedule of the class this teacher stands in front of most. */
function busiestSchedule(week: readonly WeekRow[], schedules: readonly Schedule[]): Schedule | null {
  const perGrade = new Map<string, number>()
  for (const row of week) perGrade.set(row.grade_id, (perGrade.get(row.grade_id) ?? 0) + 1)
  const ranked = [...perGrade.entries()].sort((a, b) => b[1] - a[1])
  const top = ranked[0]?.[0]
  if (top === undefined) return null
  return scheduleForGrade(schedules, top)
}

type SubstitutionRow = {
  section_id: string
  grade_id: string
  grade_name: string
  section_name: string
  subject_id: string
  subject_name: string
  period_index: number
  substitute_id: string | null
  substitute_first: string | null
  substitute_last: string | null
  absent_staff_id: string
}

/**
 * The cover duties and the absences of this teacher on one date. Both come
 * through the substitution scope, which is the timetable plan applied to the
 * period the row covers, so a cover in a class they do not teach is not shown.
 */
async function substitutionsOn(
  conn: AuthzConnection,
  context: RequestContext,
  staffId: string,
  date: string,
): Promise<SubstitutionRow[]> {
  const scope = await substitutionScope(conn, context)
  return rows<SubstitutionRow>(
    conn,
    sql`SELECT substitutions.section_id AS section_id, sct.grade_id AS grade_id,
               grd.name AS grade_name, sct.name AS section_name,
               sbj.id AS subject_id, sbj.name AS subject_name,
               substitutions.period_index::int AS period_index,
               substitutions.substitute_staff_id AS substitute_id,
               stf.first_name AS substitute_first, stf.last_name AS substitute_last,
               substitutions.absent_staff_id AS absent_staff_id
          FROM substitutions
          JOIN sections sct ON sct.school_id = substitutions.school_id AND sct.id = substitutions.section_id
          JOIN grades grd ON grd.school_id = sct.school_id AND grd.id = sct.grade_id
          JOIN subjects sbj ON sbj.school_id = substitutions.school_id AND sbj.id = substitutions.subject_id
          LEFT JOIN staff stf ON stf.school_id = substitutions.school_id AND stf.id = substitutions.substitute_staff_id
         WHERE substitutions.date = ${date}::date AND ${scope}
           AND (substitutions.substitute_staff_id = ${staffId}::uuid
                OR substitutions.absent_staff_id = ${staffId}::uuid)`,
  )
}

/**
 * Today's register for one class, as its own class teacher sees it. The
 * section must be one the caller's attendance plan reaches, and the absent
 * count is only there once somebody has marked the day.
 */
async function classAttendanceToday(
  conn: AuthzConnection,
  context: RequestContext,
  sectionId: string,
  date: string,
): Promise<DashboardClassAttendance | undefined> {
  const plans = await attendancePlans(conn, context)
  const schoolId = context.schoolId
  const [row] = await rows<{ reaches: boolean; marked: number }>(
    conn,
    sql`SELECT EXISTS (SELECT 1 FROM sections
                        WHERE sections.school_id = ${schoolId}::uuid
                          AND sections.id = ${sectionId}::uuid
                          AND (${plans.rosters})) AS reaches,
               (SELECT count(*)::int FROM attendance_entries
                 WHERE attendance_entries.school_id = ${schoolId}::uuid
                   AND attendance_entries.section_id = ${sectionId}::uuid
                   AND attendance_entries.date = ${date}::date
                   AND (${plans.entries})) AS marked`,
  )
  if (row?.reaches !== true) return undefined
  if (Number(row.marked ?? 0) === 0) return { date, marked: false }
  const [absent] = await rows<{ total: number }>(
    conn,
    sql`SELECT count(*)::int AS total FROM (
           SELECT DISTINCT ON (attendance_entries.student_id) attendance_entries.mark
             FROM attendance_entries
            WHERE attendance_entries.school_id = ${schoolId}::uuid
              AND attendance_entries.section_id = ${sectionId}::uuid
              AND attendance_entries.date = ${date}::date
              AND (${plans.entries})
            ORDER BY attendance_entries.student_id, attendance_entries.revision DESC
         ) cur
        WHERE cur.mark = 'absent'`,
  )
  return { date, marked: true, absent: absent?.total ?? 0 }
}

/** The class this teacher is the class teacher of, with its strength. */
async function myClass(
  conn: AuthzConnection,
  context: RequestContext,
  staffId: string,
  yearId: string,
  date: string,
  schoolDay: boolean,
): Promise<TeacherDashboard['myClass']> {
  const sectionPlan = await readPlan(conn, context, 'sections.read_strengths', 'section')
  const enrollmentPredicate = await enrollmentScope(conn, context)
  const [section] = await rows<{
    id: string
    grade_name: string
    section_name: string
    strength: number
  }>(
    conn,
    sql`SELECT ${sectionsTable.id} AS id, grd.name AS grade_name, ${sectionsTable.name} AS section_name,
               (SELECT count(*)::int FROM ${enrollmentsTable}
                 WHERE ${enrollmentsTable.schoolId} = ${sectionsTable.schoolId}
                   AND ${enrollmentsTable.sectionId} = ${sectionsTable.id}
                   AND ${enrollmentsTable.academicYearId} = ${sectionsTable.academicYearId}
                   AND ${enrollmentsTable.leftOn} IS NULL
                   AND ${enrollmentPredicate}) AS strength
          FROM ${sectionsTable}
          JOIN grades grd ON grd.school_id = ${sectionsTable.schoolId} AND grd.id = ${sectionsTable.gradeId}
         WHERE ${predicateFor(sectionPlan)}
           AND ${sectionsTable.academicYearId} = ${yearId}::uuid
           AND ${sectionsTable.classTeacherStaffId} = ${staffId}::uuid
         LIMIT 1`,
  )
  if (!section) return undefined

  const birthdaysThisWeek = await optionalBlock(async () => {
    const studentPlan = await readPlan(conn, context, 'students.read_sensitive', 'student')
    const found = await rows<{
      id: string
      first_name: string
      last_name: string | null
      born: string
    }>(
      conn,
      sql`SELECT ${studentsTable.id} AS id, ${studentsTable.firstName} AS first_name,
                 ${studentsTable.lastName} AS last_name,
                 to_char(${studentsTable.dateOfBirth}, 'MM-DD') AS born
            FROM ${studentsTable}
           WHERE ${predicateFor(studentPlan)} AND ${studentsTable.status} = 'active'
             AND ${studentsTable.dateOfBirth} IS NOT NULL
             AND EXISTS (SELECT 1 FROM ${enrollmentsTable} enr
                          WHERE enr.school_id = ${studentsTable.schoolId}
                            AND enr.student_id = ${studentsTable.id}
                            AND enr.section_id = ${section.id}::uuid
                            AND enr.left_on IS NULL)
           LIMIT 200`,
    )
    const window = Array.from({ length: 8 }, (_, ahead) => addDays(date, ahead))
    const birthdays: DashboardBirthday[] = []
    for (const row of found) {
      const day = window.find((value) => birthdayMonthDay(row.born, value) === value.slice(5))
      if (day === undefined) continue
      birthdays.push({
        kind: 'student',
        id: row.id,
        name: label(row.first_name, row.last_name),
        className: label(section.grade_name, section.section_name),
        date: day,
      })
    }
    return birthdays.sort((a, b) => (a.date === b.date ? a.name.localeCompare(b.name) : a.date.localeCompare(b.date)))
  })

  // The register is a thing that happens on a school day, so a Sunday or a
  // holiday carries no line about it at all.
  const attendanceToday = schoolDay
    ? await optionalBlock(() => classAttendanceToday(conn, context, section.id, date))
    : undefined

  return {
    section: { id: section.id, name: label(section.grade_name, section.section_name) },
    strength: Number(section.strength),
    ...(birthdaysThisWeek === undefined ? {} : { birthdaysThisWeek }),
    ...(attendanceToday === undefined ? {} : { attendanceToday }),
  }
}

/**
 * The teacher dashboard: their own day, their own week and the class they look
 * after. A teacher with no staff record teaches nothing, so every block is
 * empty rather than a school-wide fallback.
 */
export async function teacherDashboard(
  conn: AuthzConnection,
  context: RequestContext,
  date: string,
): Promise<TeacherDashboard> {
  const holidayPlan = await optionalBlock(() => readPlan(conn, context, 'holidays.read', 'holiday'))
  const calendar = await buildCalendar(conn, holidayPlan, date)
  const facts = await loadRelationshipFactsFor(conn, context.schoolId, context.membershipId, context.now)
  const year = await currentAcademicYear(conn, context.schoolId)

  if (facts.selfStaffId === null || year === null) {
    return {
      audience: 'teacher',
      day: calendar.day,
      staffLinked: facts.selfStaffId !== null,
      academicYearId: year?.id ?? null,
      timeline: [],
      timelineDate: null,
      week: [],
      periods: [],
      holidays: calendar.holidays,
    }
  }

  const staffId = facts.selfStaffId
  const week = (await optionalBlock(() => ownWeek(conn, context, staffId, year.id))) ?? []
  const schedules = await loadSchedules(conn, context.schoolId, year.id)

  const timelineDate =
    calendar.day.kind === 'school_day' ? date : (calendar.day.nextSchoolDay?.date ?? null)
  const substitutions =
    timelineDate === null
      ? []
      : ((await optionalBlock(() => substitutionsOn(conn, context, staffId, timelineDate))) ?? [])
  const covers = substitutions.filter((row) => row.substitute_id === staffId)
  const absences = substitutions.filter((row) => row.absent_staff_id === staffId)

  // A teacher who only covers has no week of their own, and the bells still
  // ring: the class they are covering names the schedule, and failing that the
  // one schedule the school runs.
  const onlySchedule = schedules.length === 1 ? (schedules[0] ?? null) : null
  const schedule =
    busiestSchedule(week, schedules) ??
    (covers[0] ? scheduleForGrade(schedules, covers[0].grade_id) : null) ??
    onlySchedule

  const timeline: DashboardTimelineSlot[] = []
  if (timelineDate !== null && schedule !== null) {
    const isoDay = new Date(`${timelineDate}T00:00:00Z`).getUTCDay()
    for (const period of schedule.periods) {
      const own = week.find(
        (row) => row.day_of_week === isoDay && row.period_index === period.index,
      )
      const cover = covers.find((row) => row.period_index === period.index)
      let lesson: DashboardLesson | undefined
      if (cover) {
        lesson = {
          section: { id: cover.section_id, name: label(cover.grade_name, cover.section_name) },
          subject: { id: cover.subject_id, name: label(cover.subject_name) },
          cover: true,
        }
      } else if (own) {
        const away = absences.find((row) => row.period_index === period.index)
        lesson = {
          section: { id: own.section_id, name: label(own.grade_name, own.section_name) },
          subject: { id: own.subject_id, name: label(own.subject_name) },
          ...(own.room_number === null ? {} : { roomNumber: own.room_number }),
          cover: false,
          ...(away && away.substitute_id !== null
            ? {
                coveredBy: {
                  id: away.substitute_id,
                  name: label(away.substitute_first, away.substitute_last),
                },
              }
            : {}),
        }
      }
      timeline.push({
        periodIndex: period.index,
        name: period.name,
        startTime: period.startTime,
        endTime: period.endTime,
        type: period.type,
        ...(lesson === undefined ? {} : { lesson }),
      })
    }
  }

  const mine = await optionalBlock(() => myClass(conn, context, staffId, year.id, date, calendar.day.kind === 'school_day'))
  // Absent, not empty, for a teacher who records marks nowhere.
  const toEnter = await optionalBlock(() => marksToEnter(conn, context, year.id, date))

  return {
    audience: 'teacher',
    day: calendar.day,
    staffLinked: true,
    academicYearId: year.id,
    timeline,
    timelineDate: timeline.length === 0 ? null : timelineDate,
    week: week.map((row) => ({
      dayOfWeek: row.day_of_week,
      periodIndex: row.period_index,
      section: { id: row.section_id, name: label(row.grade_name, row.section_name) },
      subject: { id: row.subject_id, name: label(row.subject_name) },
      ...(row.room_number === null ? {} : { roomNumber: row.room_number }),
    })),
    periods: schedule === null ? [] : schedule.periods.map((period) => ({ ...period })),
    ...(mine === undefined ? {} : { myClass: mine }),
    ...(toEnter === undefined ? {} : { marksToEnter: toEnter }),
    holidays: calendar.holidays,
  }
}
