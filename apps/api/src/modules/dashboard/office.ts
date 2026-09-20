import type { Pool } from 'pg'
import { sql, type SQL } from 'drizzle-orm'
import {
  enrollments as enrollmentsTable,
  sections as sectionsTable,
  staff as staffTable,
  students as studentsTable,
  timetableEntries,
} from '@erp/db/schema'
import { planPredicate, scopedTableFor, type AuthzConnection } from '@erp/authz'
import type { RequestContext } from '@erp/contracts/server'
import type {
  DashboardAttentionItem,
  DashboardBirthday,
  DashboardClassStrength,
  OfficeDashboard,
} from '@erp/contracts'
import { decideSchoolAction, readPlan } from '../shared/index.ts'
import { ApiFailure } from '../../http/errors.ts'
import { label, predicateFor, rows } from './queries.ts'
import {
  addDays,
  birthdayMonthDay,
  buildCalendar,
  currentAcademicYear,
  monthKey,
  optionalBlock,
  type CurrentYear,
} from './calendar.ts'
import { loadSchedules, scheduleForGrade, weeklyTeachingSlots } from './bell.ts'
import { recentAuditEvents, securityAuditEvents } from './activity.ts'

/**
 * A substitution is visible when the period it covers is visible, because the
 * two describe the same lesson. This is the same rule the substitutions list
 * uses, so the dashboard can never count a row that list would hide.
 */
export async function substitutionScope(
  conn: AuthzConnection,
  context: RequestContext,
): Promise<SQL> {
  const table = scopedTableFor('timetable')
  if (!table) throw new ApiFailure('SERVICE_UNAVAILABLE')
  const plan = await readPlan(conn, context, 'timetable.read', 'timetable')
  const predicate = planPredicate(plan, table)
  return sql`EXISTS (SELECT 1 FROM timetable_entries
      WHERE timetable_entries.school_id = substitutions.school_id
        AND timetable_entries.section_id = substitutions.section_id
        AND timetable_entries.period_index = substitutions.period_index
        AND timetable_entries.day_of_week = extract(isodow from substitutions.date)::int
        AND ${predicate})`
}

/**
 * A class strength is a count of children, so it is counted through the
 * enrollment plan: a caller whose enrollment scope is narrower than the
 * sections they may read strengths of gets the narrower number.
 */
export async function enrollmentScope(
  conn: AuthzConnection,
  context: RequestContext,
): Promise<SQL> {
  const table = scopedTableFor('enrollment')
  if (!table) throw new ApiFailure('SERVICE_UNAVAILABLE')
  const plan = await readPlan(conn, context, 'students.read_enrollments', 'enrollment')
  return planPredicate(plan, table)
}

interface CoverCounts {
  readonly teachersAway: number
  readonly periodsWithoutCover: number
}

async function coverCounts(
  conn: AuthzConnection,
  context: RequestContext,
  date: string,
): Promise<CoverCounts> {
  const scope = await substitutionScope(conn, context)
  const [row] = await rows<{ away: number; uncovered: number }>(
    conn,
    sql`SELECT count(DISTINCT substitutions.absent_staff_id)::int AS away,
               count(*) FILTER (WHERE substitutions.substitute_staff_id IS NULL)::int AS uncovered
          FROM substitutions
         WHERE substitutions.date = ${date}::date AND ${scope}`,
  )
  return {
    teachersAway: row?.away ?? 0,
    periodsWithoutCover: row?.uncovered ?? 0,
  }
}

async function countInvitationsExpiring(
  conn: AuthzConnection,
  context: RequestContext,
): Promise<number | undefined> {
  const decision = await decideSchoolAction(conn, context, 'members.invite')
  if (!decision.allowed) return undefined
  const [row] = await rows<{ total: number }>(
    conn,
    sql`SELECT count(*)::int AS total FROM school_invitations
         WHERE school_id = ${context.schoolId}::uuid AND status = 'pending'
           AND expires_at > ${context.now}::timestamptz
           AND expires_at <= ${context.now}::timestamptz + interval '24 hours'`,
  )
  return row?.total ?? 0
}

async function countStudentsWithoutGuardianPhone(
  conn: AuthzConnection,
  context: RequestContext,
): Promise<number> {
  const plan = await readPlan(conn, context, 'students.read_guardian_contact', 'student')
  const [row] = await rows<{ total: number }>(
    conn,
    sql`SELECT count(*)::int AS total FROM ${studentsTable}
         WHERE ${predicateFor(plan)} AND ${studentsTable.status} = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM student_guardians sg
               JOIN guardians g ON g.school_id = sg.school_id AND g.id = sg.guardian_id
              WHERE sg.school_id = ${studentsTable.schoolId} AND sg.student_id = ${studentsTable.id}
                AND g.phone IS NOT NULL AND btrim(g.phone) <> '')`,
  )
  return row?.total ?? 0
}

async function countStudentsWithoutConsent(
  conn: AuthzConnection,
  context: RequestContext,
): Promise<number> {
  const plan = await readPlan(conn, context, 'students.read_consents', 'student')
  const [row] = await rows<{ total: number }>(
    conn,
    sql`SELECT count(*)::int AS total FROM ${studentsTable}
         WHERE ${predicateFor(plan)} AND ${studentsTable.status} = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM guardian_consents gc
              WHERE gc.school_id = ${studentsTable.schoolId} AND gc.student_id = ${studentsTable.id})`,
  )
  return row?.total ?? 0
}

async function countSectionsWithoutClassTeacher(
  conn: AuthzConnection,
  context: RequestContext,
  yearId: string | null,
): Promise<number> {
  const plan = await readPlan(conn, context, 'sections.read', 'section')
  if (yearId === null) return 0
  const [row] = await rows<{ total: number }>(
    conn,
    sql`SELECT count(*)::int AS total FROM ${sectionsTable}
         WHERE ${predicateFor(plan)}
           AND ${sectionsTable.academicYearId} = ${yearId}::uuid
           AND ${sectionsTable.classTeacherStaffId} IS NULL`,
  )
  return row?.total ?? 0
}

async function countEmptyTimetableSlots(
  conn: AuthzConnection,
  context: RequestContext,
  year: CurrentYear | null,
): Promise<number> {
  const sectionPlan = await readPlan(conn, context, 'sections.read', 'section')
  const timetablePlan = await readPlan(conn, context, 'timetable.read', 'timetable')
  if (year === null) return 0
  const timetableTable = scopedTableFor('timetable')
  if (!timetableTable) throw new ApiFailure('SERVICE_UNAVAILABLE')
  const filled = await rows<{ section_id: string; grade_id: string; entries: number }>(
    conn,
    sql`SELECT ${sectionsTable.id} AS section_id, ${sectionsTable.gradeId} AS grade_id,
               (SELECT count(*)::int FROM ${timetableEntries}
                 WHERE ${timetableEntries.schoolId} = ${sectionsTable.schoolId}
                   AND ${timetableEntries.sectionId} = ${sectionsTable.id}
                   AND ${timetableEntries.academicYearId} = ${sectionsTable.academicYearId}
                   AND ${planPredicate(timetablePlan, timetableTable)}) AS entries
          FROM ${sectionsTable}
         WHERE ${predicateFor(sectionPlan)}
           AND ${sectionsTable.academicYearId} = ${year.id}::uuid`,
  )
  if (filled.length === 0) return 0
  const schedules = await loadSchedules(conn, context.schoolId, year.id)
  let missing = 0
  for (const row of filled) {
    const schedule = scheduleForGrade(schedules, row.grade_id)
    if (!schedule) continue
    missing += Math.max(0, weeklyTeachingSlots(schedule) - Number(row.entries))
  }
  return missing
}

async function countStaffWithoutLogin(
  conn: AuthzConnection,
  context: RequestContext,
): Promise<number | undefined> {
  const decision = await decideSchoolAction(conn, context, 'members.read')
  if (!decision.allowed) return undefined
  const plan = await readPlan(conn, context, 'staff.read_directory', 'staff')
  const [row] = await rows<{ total: number }>(
    conn,
    sql`SELECT count(*)::int AS total FROM ${staffTable}
         WHERE ${predicateFor(plan)} AND ${staffTable.status} = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM membership_staff_links msl
              WHERE msl.school_id = ${context.schoolId}::uuid AND msl.staff_id = ${staffTable.id})
           AND NOT EXISTS (
             SELECT 1 FROM school_invitations si
              WHERE si.school_id = ${context.schoolId}::uuid AND si.status = 'pending'
                AND si.staff_id = ${staffTable.id})`,
  )
  return row?.total ?? 0
}

/** Every count the caller may read, in the order the screen lists them. */
async function attentionItems(
  conn: AuthzConnection,
  context: RequestContext,
  year: CurrentYear | null,
  cover: CoverCounts | undefined,
): Promise<DashboardAttentionItem[]> {
  const items: DashboardAttentionItem[] = []
  const add = (key: DashboardAttentionItem['key'], count: number | undefined): void => {
    if (count !== undefined) items.push({ key, count })
  }
  add('periods_without_cover', cover?.periodsWithoutCover)
  add('invitations_expiring', await countInvitationsExpiring(conn, context))
  add(
    'students_without_guardian_phone',
    await optionalBlock(() => countStudentsWithoutGuardianPhone(conn, context)),
  )
  add(
    'students_without_consent',
    await optionalBlock(() => countStudentsWithoutConsent(conn, context)),
  )
  add(
    'sections_without_class_teacher',
    await optionalBlock(() => countSectionsWithoutClassTeacher(conn, context, year?.id ?? null)),
  )
  add(
    'empty_timetable_slots',
    await optionalBlock(() => countEmptyTimetableSlots(conn, context, year)),
  )
  add('staff_without_login', await countStaffWithoutLogin(conn, context))
  return items
}

export type Glance = NonNullable<OfficeDashboard['glance']>

/**
 * The roll, and then the mix and the month's movements. Gender, admission date
 * and the date a child left all live in the sensitive block of a student
 * record, so they are counted under `students.read_sensitive` and left out for
 * a caller who holds only the basic read.
 */
export async function studentGlance(
  conn: AuthzConnection,
  context: RequestContext,
  date: string,
): Promise<Glance> {
  const basicPlan = await readPlan(conn, context, 'students.read_basic', 'student')
  const month = monthKey(date)
  const [roll] = await rows<{ total: number }>(
    conn,
    sql`SELECT count(*)::int AS total FROM ${studentsTable}
         WHERE ${predicateFor(basicPlan)} AND ${studentsTable.status} = 'active'`,
  )
  const sensitive = await optionalBlock(async () => {
    const plan = await readPlan(conn, context, 'students.read_sensitive', 'student')
    const [row] = await rows<{
      boys: number
      girls: number
      other: number
      admitted: number
      left: number
    }>(
      conn,
      sql`SELECT count(*) FILTER (WHERE ${studentsTable.status} = 'active' AND ${studentsTable.gender} = 'male')::int AS boys,
                 count(*) FILTER (WHERE ${studentsTable.status} = 'active' AND ${studentsTable.gender} = 'female')::int AS girls,
                 count(*) FILTER (WHERE ${studentsTable.status} = 'active'
                   AND (${studentsTable.gender} IS NULL OR ${studentsTable.gender} NOT IN ('male', 'female')))::int AS other,
                 count(*) FILTER (WHERE to_char(${studentsTable.admissionDate}, 'YYYY-MM') = ${month})::int AS admitted,
                 count(*) FILTER (WHERE to_char(${studentsTable.leftOn}, 'YYYY-MM') = ${month})::int AS "left"
            FROM ${studentsTable}
           WHERE ${predicateFor(plan)}`,
    )
    return {
      mix: {
        boys: row?.boys ?? 0,
        girls: row?.girls ?? 0,
        other: row?.other ?? 0,
      },
      admittedThisMonth: row?.admitted ?? 0,
      leftThisMonth: row?.left ?? 0,
    }
  })
  return {
    students: { total: roll?.total ?? 0 },
    ...(sensitive === undefined ? {} : sensitive),
  }
}

/** Students on the rolls for every teacher on the rolls, to one decimal. */
async function studentsPerTeacher(
  conn: AuthzConnection,
  context: RequestContext,
): Promise<number | undefined> {
  const studentPlan = await readPlan(conn, context, 'students.read_basic', 'student')
  const staffPlan = await readPlan(conn, context, 'staff.read_directory', 'staff')
  const [students] = await rows<{ total: number }>(
    conn,
    sql`SELECT count(*)::int AS total FROM ${studentsTable}
         WHERE ${predicateFor(studentPlan)} AND ${studentsTable.status} = 'active'`,
  )
  const [teachers] = await rows<{ total: number }>(
    conn,
    sql`SELECT count(*)::int AS total FROM ${staffTable}
         WHERE ${predicateFor(staffPlan)} AND ${staffTable.status} IN ('active', 'on_leave')
           AND ${staffTable.staffType} = 'teaching'`,
  )
  const teacherCount = teachers?.total ?? 0
  if (teacherCount === 0) return undefined
  return Math.round(((students?.total ?? 0) / teacherCount) * 10) / 10
}

/** Section counts by class, for the sections the caller may read strengths of. */
export async function classStrength(
  conn: AuthzConnection,
  context: RequestContext,
  yearId: string | null,
): Promise<DashboardClassStrength[]> {
  const plan = await readPlan(conn, context, 'sections.read_strengths', 'section')
  const enrollmentPredicate = await enrollmentScope(conn, context)
  if (yearId === null) return []
  const found = await rows<{
    grade_id: string
    grade_name: string
    section_id: string
    section_name: string
    strength: number
  }>(
    conn,
    sql`SELECT grd.id AS grade_id, grd.name AS grade_name,
               ${sectionsTable.id} AS section_id, ${sectionsTable.name} AS section_name,
               (SELECT count(*)::int FROM ${enrollmentsTable}
                 WHERE ${enrollmentsTable.schoolId} = ${sectionsTable.schoolId}
                   AND ${enrollmentsTable.sectionId} = ${sectionsTable.id}
                   AND ${enrollmentsTable.academicYearId} = ${sectionsTable.academicYearId}
                   AND ${enrollmentsTable.leftOn} IS NULL
                   AND ${enrollmentPredicate}) AS strength
          FROM ${sectionsTable}
          JOIN grades grd ON grd.school_id = ${sectionsTable.schoolId} AND grd.id = ${sectionsTable.gradeId}
         WHERE ${predicateFor(plan)} AND ${sectionsTable.academicYearId} = ${yearId}::uuid
         ORDER BY grd.sort_order, section_name`,
  )
  const byGrade = new Map<string, DashboardClassStrength>()
  for (const row of found) {
    const existing = byGrade.get(row.grade_id)
    const section = {
      id: row.section_id,
      name: label(row.section_name),
      count: Number(row.strength),
    }
    if (existing) existing.sections.push(section)
    else {
      byGrade.set(row.grade_id, {
        grade: { id: row.grade_id, name: label(row.grade_name) },
        sections: [section],
      })
    }
  }
  return [...byGrade.values()]
}

/** The twelve months of the academic year, April to March, never a gap. */
async function admissionsByMonth(
  conn: AuthzConnection,
  context: RequestContext,
  year: CurrentYear | null,
  date: string,
): Promise<{ month: string; count: number }[]> {
  const plan = await readPlan(conn, context, 'students.read_sensitive', 'student')
  const start = year?.startDate ?? `${Number(date.slice(0, 4)) - (date.slice(5, 7) < '04' ? 1 : 0)}-04-01`
  const months: string[] = []
  for (let index = 0; index < 12; index += 1) {
    const cursor = new Date(`${start.slice(0, 8)}01T00:00:00Z`)
    cursor.setUTCMonth(cursor.getUTCMonth() + index)
    months.push(cursor.toISOString().slice(0, 7))
  }
  const found = await rows<{ month: string; total: number }>(
    conn,
    sql`SELECT to_char(${studentsTable.admissionDate}, 'YYYY-MM') AS month, count(*)::int AS total
          FROM ${studentsTable}
         WHERE ${predicateFor(plan)} AND ${studentsTable.admissionDate} IS NOT NULL
         GROUP BY 1`,
  )
  const counts = new Map(found.map((row) => [row.month, Number(row.total)]))
  return months.map((month) => ({ month, count: counts.get(month) ?? 0 }))
}

type Birthdays = NonNullable<OfficeDashboard['birthdays']>

/**
 * Birthdays carry a name and a class, nothing else. Students come through the
 * student plan with their current section; staff come through the directory
 * plan and carry no class.
 */
export async function birthdayLists(
  conn: AuthzConnection,
  context: RequestContext,
  date: string,
  yearId: string | null,
): Promise<Birthdays | undefined> {
  const students = await optionalBlock(async () => {
    const plan = await readPlan(conn, context, 'students.read_sensitive', 'student')
    return rows<{ id: string; first_name: string; last_name: string | null; born: string; class_name: string | null }>(
      conn,
      sql`SELECT ${studentsTable.id} AS id, ${studentsTable.firstName} AS first_name,
                 ${studentsTable.lastName} AS last_name,
                 to_char(${studentsTable.dateOfBirth}, 'MM-DD') AS born,
                 (SELECT grd.name || ' ' || sct.name FROM ${enrollmentsTable} enr
                    JOIN sections sct ON sct.school_id = enr.school_id AND sct.id = enr.section_id
                    JOIN grades grd ON grd.school_id = sct.school_id AND grd.id = sct.grade_id
                   WHERE enr.school_id = ${studentsTable.schoolId} AND enr.student_id = ${studentsTable.id}
                     AND enr.left_on IS NULL
                     AND (${yearId}::text IS NULL OR enr.academic_year_id = ${yearId}::uuid)
                   LIMIT 1) AS class_name
            FROM ${studentsTable}
           WHERE ${predicateFor(plan)} AND ${studentsTable.status} = 'active'
             AND ${studentsTable.dateOfBirth} IS NOT NULL
           LIMIT 2000`,
    )
  })
  const staffRows = await optionalBlock(async () => {
    const plan = await readPlan(conn, context, 'staff.read_private', 'staff')
    return rows<{ id: string; first_name: string; last_name: string | null; born: string }>(
      conn,
      sql`SELECT ${staffTable.id} AS id, ${staffTable.firstName} AS first_name,
                 ${staffTable.lastName} AS last_name,
                 to_char(${staffTable.dateOfBirth}, 'MM-DD') AS born
            FROM ${staffTable}
           WHERE ${predicateFor(plan)} AND ${staffTable.status} IN ('active', 'on_leave')
             AND ${staffTable.dateOfBirth} IS NOT NULL
           LIMIT 2000`,
    )
  })
  if (students === undefined && staffRows === undefined) return undefined

  const window: { date: string; monthDay: string }[] = []
  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const day = addDays(date, ahead)
    window.push({ date: day, monthDay: day.slice(5) })
  }

  const today: DashboardBirthday[] = []
  const thisWeek: DashboardBirthday[] = []
  const place = (entry: DashboardBirthday, ahead: number): void => {
    if (ahead === 0) today.push(entry)
    else thisWeek.push(entry)
  }
  for (const row of students ?? []) {
    const ahead = window.findIndex((day) => birthdayMonthDay(row.born, day.date) === day.monthDay)
    if (ahead < 0) continue
    place(
      {
        kind: 'student',
        id: row.id,
        name: label(row.first_name, row.last_name),
        ...(row.class_name === null ? {} : { className: label(row.class_name) }),
        date: window[ahead]?.date as string,
      },
      ahead,
    )
  }
  for (const row of staffRows ?? []) {
    const ahead = window.findIndex((day) => birthdayMonthDay(row.born, day.date) === day.monthDay)
    if (ahead < 0) continue
    place(
      {
        kind: 'staff',
        id: row.id,
        name: label(row.first_name, row.last_name),
        date: window[ahead]?.date as string,
      },
      ahead,
    )
  }
  const bySoonest = (a: DashboardBirthday, b: DashboardBirthday): number =>
    a.date === b.date ? a.name.localeCompare(b.name) : a.date.localeCompare(b.date)
  return { today: today.sort(bySoonest), thisWeek: thisWeek.sort(bySoonest) }
}

/** Which parts of school setup are done, for the steps the caller may read. */
async function setupSteps(
  conn: AuthzConnection,
  context: RequestContext,
): Promise<OfficeDashboard['setup']> {
  const checks = [
    { key: 'school' as const, permission: 'school.read' as const, // The address is a sealed jsonb envelope, so "written down" is "not empty".
      query: sql`SELECT 1 FROM schools WHERE id = ${context.schoolId}::uuid AND btrim(name) <> '' AND address <> '{}'::jsonb` },
    { key: 'years' as const, permission: 'academic_years.read' as const, query: sql`SELECT 1 FROM academic_years WHERE school_id = ${context.schoolId}::uuid` },
    { key: 'grades' as const, permission: 'grades.read' as const, query: sql`SELECT 1 FROM grades WHERE school_id = ${context.schoolId}::uuid` },
    { key: 'sections' as const, permission: 'sections.read' as const, query: sql`SELECT 1 FROM sections WHERE school_id = ${context.schoolId}::uuid` },
    { key: 'subjects' as const, permission: 'subjects.read' as const, query: sql`SELECT 1 FROM subjects WHERE school_id = ${context.schoolId}::uuid` },
  ]
  const steps: { key: (typeof checks)[number]['key']; done: boolean }[] = []
  for (const check of checks) {
    const decision = await decideSchoolAction(conn, context, check.permission)
    if (!decision.allowed) continue
    const found = await rows<{ ok: number }>(conn, sql`SELECT 1 AS ok WHERE EXISTS (${check.query})`)
    steps.push({ key: check.key, done: found.length > 0 })
  }
  if (steps.length === 0) return undefined
  return { steps }
}

/**
 * The office dashboard. Every block is read through the caller's own plan in
 * this one transaction; a block whose permission they do not hold is left out
 * of the response rather than answered with a zero.
 */
export async function officeDashboard(
  conn: AuthzConnection,
  context: RequestContext,
  authPool: Pool,
  date: string,
): Promise<OfficeDashboard> {
  const holidayPlan = await optionalBlock(() => readPlan(conn, context, 'holidays.read', 'holiday'))
  const calendar = await buildCalendar(conn, holidayPlan, date)
  const year = await currentAcademicYear(conn, context.schoolId)

  const today = await optionalBlock(() => coverCounts(conn, context, date))
  const attention = await attentionItems(conn, context, year, today)
  const glance = await optionalBlock(() => studentGlance(conn, context, date))
  const perTeacher = await optionalBlock(() => studentsPerTeacher(conn, context))
  const strengths = await optionalBlock(() => classStrength(conn, context, year?.id ?? null))
  const admissions = await optionalBlock(() => admissionsByMonth(conn, context, year, date))
  const birthdays = await birthdayLists(conn, context, date, year?.id ?? null)
  const recent = await optionalBlock(() => recentAuditEvents(conn, context, authPool))
  const setup = await setupSteps(conn, context)
  const security = context.roleKeys.includes('owner')
    ? await optionalBlock(() => securityAuditEvents(conn, context, authPool))
    : undefined

  return {
    audience: 'office',
    day: calendar.day,
    academicYear: year === null ? null : { id: year.id, name: year.name },
    ...(today === undefined ? {} : { today }),
    attention,
    ...(glance === undefined ? {} : { glance }),
    ...(perTeacher === undefined ? {} : { studentsPerTeacher: perTeacher }),
    ...(strengths === undefined ? {} : { classStrength: strengths }),
    ...(admissions === undefined ? {} : { admissionsByMonth: admissions }),
    holidays: calendar.holidays,
    ...(birthdays === undefined ? {} : { birthdays }),
    ...(recent === undefined ? {} : { recentActivity: recent }),
    ...(security === undefined ? {} : { securityEvents: security }),
    ...(setup === undefined ? {} : { setup }),
  }
}
