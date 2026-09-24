/**
 * Adds a school's day-to-day history to a school that already exists: the
 * attendance registers and the exams (papers, marks, publications, the class
 * teacher's grades and remarks, and published report cards) that the dev
 * seed makes for the school it builds itself, in the same shape.
 *
 *   SEED_SCHOOL_ID=<school id> MIGRATION_DATABASE_URL=<migrator url> \
 *     pnpm --filter @erp/api dev:seed-activity
 *
 * Everything else (years, sections, enrolments, subjects, staff, teaching
 * assignments, class teachers, holidays, sign-in accounts) is read from the
 * database, never created. Marks are recorded by memberships that already
 * exist in the school: a class teacher or a subject teacher through their
 * staff link where there is one, otherwise the principal or the office.
 *
 * It runs once per school: it refuses a school that already has exams, and
 * never touches a register mark somebody has already made. Rows go in as
 * multi-row inserts in one transaction, because the real target is remote.
 */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { syncPapers } from '../src/modules/exams/setup.ts'
import { buildReportCard } from '../src/modules/report-cards/build.ts'

function refuse(reason: string): never {
  console.error(`dev:seed-activity refused to run: ${reason}`)
  process.exit(1)
}

/** The same small deterministic generator as the dev seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = rng(20260401)

const shiftDays = (date: string, days: number): string => {
  const moved = new Date(`${date}T00:00:00Z`)
  moved.setUTCDate(moved.getUTCDate() + days)
  return moved.toISOString().slice(0, 10)
}
const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay()

/**
 * Inserts rows many at a time. Each column may carry a cast; the chunk size
 * keeps every statement well under the protocol's limit on parameters.
 */
async function insertMany(
  client: pg.PoolClient,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
  casts: Readonly<Record<string, string>> = {},
): Promise<void> {
  const perChunk = Math.max(1, Math.floor(20000 / columns.length))
  for (let start = 0; start < rows.length; start += perChunk) {
    const chunk = rows.slice(start, start + perChunk)
    const values: unknown[] = []
    const tuples = chunk.map((row) => {
      const cells = columns.map((column, index) => {
        values.push(row[index])
        const cast = casts[column]
        return `$${values.length}${cast ? `::${cast}` : ''}`
      })
      return `(${cells.join(', ')})`
    })
    await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, values)
  }
}

interface YearRow { id: string; name: string; start: string; end: string; status: string }
interface SectionRow { id: string; yearId: string; gradeId: string; sortOrder: number; gradeName: string; name: string; classTeacher: string | null }
interface EnrolmentRow { student_id: string; section_id: string; joined_on: string; left_on: string | null }

async function main(): Promise<void> {
  const schoolId = process.env.SEED_SCHOOL_ID
  if (!schoolId) refuse('SEED_SCHOOL_ID is not set. Name the school to add history to.')
  if (process.env.NODE_ENV === 'production') refuse('NODE_ENV=production. This seed is for a developer machine only.')
  const url = process.env.MIGRATION_DATABASE_URL
  if (!url) refuse('MIGRATION_DATABASE_URL is not set.')
  if (decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) === 'erp_test')
    refuse('the database is erp_test, which belongs to the test suite.')

  const migrator = new pg.Pool({ connectionString: url })
  const client = await migrator.connect()
  try {
    const database = await client.query<{ name: string }>('SELECT current_database() AS name')
    if (database.rows[0]?.name === 'erp_test') refuse('the database is erp_test, which belongs to the test suite.')

    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.school_id', $1, true)`, [schoolId])
    await client.query('SELECT id FROM schools WHERE id = $1 FOR UPDATE', [schoolId]).then((result) => {
      if (result.rowCount === 0) refuse('no school has that id.')
    })
    const existing = await client.query('SELECT 1 FROM exams WHERE school_id = $1 LIMIT 1', [schoolId])
    if ((existing.rowCount ?? 0) > 0) refuse('the school already has exams, so its history was seeded before.')

    // ------------------------------------------------------ what is there
    const runDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
    const years = await client.query<YearRow>(
      `SELECT id, name, status, to_char(start_date, 'YYYY-MM-DD') AS start, to_char(end_date, 'YYYY-MM-DD') AS end
         FROM academic_years WHERE school_id = $1`,
      [schoolId],
    )
    const yearNow = years.rows.find((row) => row.status === 'current')
    const yearPast = years.rows
      .filter((row) => row.status === 'closed' && yearNow !== undefined && row.end < yearNow.start)
      .sort((left, right) => right.end.localeCompare(left.end))[0]
    if (!yearNow || !yearPast) refuse('the school needs a current year and a closed year before it.')

    const sections = (
      await client.query<{ id: string; year_id: string; grade_id: string; sort_order: number; grade_name: string; name: string; class_teacher: string | null }>(
        `SELECT s.id, s.academic_year_id AS year_id, s.grade_id, g.sort_order, g.name AS grade_name, s.name,
                s.class_teacher_staff_id AS class_teacher
           FROM sections s JOIN grades g ON g.school_id = s.school_id AND g.id = s.grade_id
          WHERE s.school_id = $1 AND s.academic_year_id = ANY($2::uuid[])
          ORDER BY g.sort_order, s.name`,
        [schoolId, [yearPast.id, yearNow.id]],
      )
    ).rows.map((row): SectionRow => ({
      id: row.id, yearId: row.year_id, gradeId: row.grade_id, sortOrder: row.sort_order,
      gradeName: row.grade_name, name: row.name, classTeacher: row.class_teacher,
    }))
    const sectionsNow = sections.filter((row) => row.yearId === yearNow.id)
    const sectionById = new Map(sections.map((row) => [row.id, row]))
    // The dev seed's named sections, or a stand-in when this school has none.
    const findSection = (sortOrder: number, name: string, fallback: number): SectionRow | undefined =>
      sectionsNow.find((row) => row.sortOrder === sortOrder && row.name === name) ?? sectionsNow[fallback]

    const enrolmentsOf = async (yearId: string): Promise<EnrolmentRow[]> =>
      (
        await client.query<EnrolmentRow>(
          `SELECT student_id, section_id, to_char(joined_on, 'YYYY-MM-DD') AS joined_on,
                  to_char(left_on, 'YYYY-MM-DD') AS left_on
             FROM enrollments WHERE school_id = $1 AND academic_year_id = $2
            ORDER BY section_id, roll_number NULLS LAST, student_id`,
          [schoolId, yearId],
        )
      ).rows
    const enrolled = await enrolmentsOf(yearNow.id)
    const enrolledPast = await enrolmentsOf(yearPast.id)
    const enrolledIn = (rows: EnrolmentRow[], sectionId: string, date: string): string[] =>
      rows
        .filter((row) => row.section_id === sectionId && row.joined_on <= date && (row.left_on === null || row.left_on >= date))
        .map((row) => row.student_id)

    const holidays = (
      await client.query<{ start: string; end: string }>(
        `SELECT to_char(start_date, 'YYYY-MM-DD') AS start, to_char(end_date, 'YYYY-MM-DD') AS end
           FROM holidays WHERE school_id = $1`,
        [schoolId],
      )
    ).rows
    const isSchoolDay = (year: YearRow, date: string): boolean =>
      date >= year.start && date <= year.end && weekdayOf(date) !== 0 &&
      !holidays.some((holiday) => holiday.start <= date && holiday.end >= date)

    // Who can be named as having done things: memberships in this school,
    // reached from staff through their links.
    const membershipOfStaff = new Map(
      (
        await client.query<{ staff_id: string; membership_id: string }>(
          'SELECT staff_id, membership_id FROM membership_staff_links WHERE school_id = $1',
          [schoolId],
        )
      ).rows.map((row) => [row.staff_id, row.membership_id]),
    )
    const officeRoles = await client.query<{ id: string; key: string }>(
      `SELECT m.id, r.key FROM school_memberships m
         JOIN membership_roles mr ON mr.school_id = m.school_id AND mr.membership_id = m.id
         JOIN roles r ON r.school_id = mr.school_id AND r.id = mr.role_id
        WHERE m.school_id = $1 AND m.status = 'active' AND r.key IN ('principal', 'admin', 'owner')
        ORDER BY m.created_at, m.id`,
      [schoolId],
    )
    const firstWith = (key: string): string | undefined => officeRoles.rows.find((row) => row.key === key)?.id
    const officeMembership = firstWith('admin') ?? firstWith('principal') ?? firstWith('owner')
    const principalMembership = firstWith('principal') ?? officeMembership
    if (!officeMembership || !principalMembership) refuse('the school has no active principal, office or owner member to record the history.')
    const classTeacherMembership = (section: SectionRow): string =>
      (section.classTeacher && membershipOfStaff.get(section.classTeacher)) || principalMembership

    // Subject teachers from the teaching assignments, as of a given date.
    const assignments = (
      await client.query<{ staff_id: string; section_id: string; subject_id: string; starts: string; ends: string | null }>(
        `SELECT staff_id, section_id, subject_id, to_char(effective_from, 'YYYY-MM-DD') AS starts,
                to_char(effective_to, 'YYYY-MM-DD') AS ends
           FROM teaching_assignments WHERE school_id = $1`,
        [schoolId],
      )
    ).rows
    const subjectTeacherMembership = (sectionId: string, subjectId: string, date: string): string => {
      const assignment = assignments.find(
        (row) => row.section_id === sectionId && row.subject_id === subjectId && row.starts <= date &&
          (row.ends === null || row.ends >= date) && membershipOfStaff.has(row.staff_id),
      )
      return (assignment && membershipOfStaff.get(assignment.staff_id)) ?? principalMembership
    }

    // ------------------------------------------------------------ attendance
    // Every school day of the current year up to yesterday, and every school
    // day of the closed year, for every pupil on a roster that day. A pupil
    // and date that already carries a mark is left exactly as it is.
    const alreadyMarked = new Set(
      (
        await client.query<{ student_id: string; date: string }>(
          `SELECT DISTINCT student_id, to_char(date, 'YYYY-MM-DD') AS date FROM attendance_entries WHERE school_id = $1`,
          [schoolId],
        )
      ).rows.map((row) => `${row.student_id}:${row.date}`),
    )
    const markFor = (): string => {
      const roll = random()
      if (roll < 0.92) return 'present'
      if (roll < 0.95) return 'absent'
      if (roll < 0.97) return 'late'
      if (roll < 0.99) return 'leave'
      return 'half_day'
    }
    const daysOf = (year: YearRow, until: string): string[] => {
      const days: string[] = []
      for (let date = year.start; date <= year.end && date <= until; date = shiftDays(date, 1)) {
        if (isSchoolDay(year, date)) days.push(date)
      }
      return days
    }
    const pastDays = daysOf(yearNow, shiftDays(runDate, -1))
    const closedYearDays = daysOf(yearPast, yearPast.end)
    // One pupil absent on the last three school days, as in the dev seed.
    const streakSection = sectionsNow[13] ?? sectionsNow[0]
    const streakDays = pastDays.slice(-3)
    const streakPupil = streakSection ? enrolledIn(enrolled, streakSection.id, shiftDays(runDate, -1))[2] : undefined

    interface MarkRow { id: string; studentId: string; sectionId: string; yearId: string; date: string; mark: string; by: string }
    const marks: MarkRow[] = []
    let skippedMarks = 0
    for (const [year, rows, days] of [[yearNow, enrolled, pastDays], [yearPast, enrolledPast, closedYearDays]] as const) {
      for (const section of sections.filter((row) => row.yearId === year.id)) {
        const by = classTeacherMembership(section)
        for (const date of days) {
          for (const studentId of enrolledIn(rows, section.id, date)) {
            if (alreadyMarked.has(`${studentId}:${date}`)) {
              skippedMarks += 1
              continue
            }
            const streak = year.id === yearNow.id && studentId === streakPupil && streakDays.includes(date)
            marks.push({ id: randomUUID(), studentId, sectionId: section.id, yearId: year.id, date, mark: streak ? 'absent' : markFor(), by })
          }
        }
      }
    }
    await insertMany(
      client,
      'attendance_entries',
      ['id', 'school_id', 'student_id', 'section_id', 'academic_year_id', 'date', 'mark', 'revision', 'kind', 'recorded_by_membership_id'],
      marks.map((row) => [row.id, schoolId, row.studentId, row.sectionId, row.yearId, row.date, row.mark, 1, 'marking', row.by]),
      { date: 'date' },
    )
    // Five office corrections this year: an absence that turned out to be leave.
    const corrected = marks
      .filter((row) => row.yearId === yearNow.id && row.mark === 'absent' && row.studentId !== streakPupil)
      .slice(0, 5)
    await insertMany(
      client,
      'attendance_entries',
      ['id', 'school_id', 'student_id', 'section_id', 'academic_year_id', 'date', 'mark', 'revision', 'supersedes_entry_id', 'kind', 'recorded_by_membership_id'],
      corrected.map((row) => [randomUUID(), schoolId, row.studentId, row.sectionId, row.yearId, row.date, 'leave', 2, row.id, 'correction', officeMembership]),
      { date: 'date' },
    )
    // The staff register, marked by the office up to yesterday, skipping any
    // day somebody has already marked for that member of staff.
    const staffMarked = new Set(
      (
        await client.query<{ staff_id: string; date: string }>(
          `SELECT DISTINCT staff_id, to_char(date, 'YYYY-MM-DD') AS date FROM staff_attendance_entries WHERE school_id = $1`,
          [schoolId],
        )
      ).rows.map((row) => `${row.staff_id}:${row.date}`),
    )
    const staffList = (
      await client.query<{ id: string; status: string; joined: string | null }>(
        `SELECT id, status, to_char(joining_date, 'YYYY-MM-DD') AS joined FROM staff WHERE school_id = $1 ORDER BY id`,
        [schoolId],
      )
    ).rows
    const staffMarks: unknown[][] = []
    for (const date of pastDays) {
      for (const member of staffList) {
        if (member.status === 'resigned' || member.status === 'retired') continue
        if ((member.joined !== null && member.joined > date) || staffMarked.has(`${member.id}:${date}`)) continue
        staffMarks.push([randomUUID(), schoolId, member.id, date, member.status === 'on_leave' ? 'leave' : markFor(), 1, 'marking', officeMembership])
      }
    }
    await insertMany(
      client,
      'staff_attendance_entries',
      ['id', 'school_id', 'staff_id', 'date', 'mark', 'revision', 'kind', 'recorded_by_membership_id'],
      staffMarks,
      { date: 'date' },
    )

    // ----------------------------------------------------------------- exams
    // The closed year: all four exams set, marked and published, with a term 1
    // and a final report card for everybody. This year: periodic test 1 and the
    // half-yearly marked and published for every section but one (Class 5 B,
    // whose half-yearly still has empty cells), a few re-check changes and one
    // office correction, co-scholastic grades and remarks, and term 1 cards;
    // periodic test 2 open with two sections done; the annual exam set for March.
    const conn = { client, db: drizzle(client) }
    const clampInto = (year: YearRow, date: string): string =>
      date < year.start ? year.start : date > year.end ? year.end : date
    const pastStart = Number(yearPast.start.slice(0, 4))
    const examPlan: { year: YearRow; kind: string; starts: string; ends: string; deadline: string }[] = [
      { year: yearPast, kind: 'periodic_test_1', starts: `${pastStart}-07-14`, ends: `${pastStart}-07-16`, deadline: `${pastStart}-07-25` },
      { year: yearPast, kind: 'half_yearly', starts: `${pastStart}-09-15`, ends: `${pastStart}-09-22`, deadline: `${pastStart}-09-30` },
      { year: yearPast, kind: 'periodic_test_2', starts: `${pastStart}-12-08`, ends: `${pastStart}-12-10`, deadline: `${pastStart}-12-19` },
      { year: yearPast, kind: 'annual', starts: `${pastStart + 1}-03-02`, ends: `${pastStart + 1}-03-12`, deadline: `${pastStart + 1}-03-20` },
      ...[
        { kind: 'periodic_test_1', starts: -70, ends: -68, deadline: -60 },
        { kind: 'half_yearly', starts: -16, ends: -9, deadline: -4 },
        { kind: 'periodic_test_2', starts: -2, ends: -1, deadline: 10 },
        { kind: 'annual', starts: 150, ends: 158, deadline: 165 },
      ].map((row) => ({
        year: yearNow,
        kind: row.kind,
        starts: clampInto(yearNow, shiftDays(runDate, row.starts)),
        ends: clampInto(yearNow, shiftDays(runDate, row.ends)),
        deadline: clampInto(yearNow, shiftDays(runDate, row.deadline)),
      })),
    ]
    const examIdOf = new Map<string, string>()
    for (const exam of examPlan) {
      const id = randomUUID()
      examIdOf.set(`${exam.year.id}:${exam.kind}`, id)
      await client.query(
        `INSERT INTO exams (id, school_id, academic_year_id, kind, starts_on, ends_on, recheck_deadline)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, schoolId, exam.year.id, exam.kind, exam.starts, exam.ends, exam.deadline],
      )
      await syncPapers(conn, schoolId, { id, academic_year_id: exam.year.id })
    }
    const COMPONENTS: Record<string, [string, number][]> = {
      periodic_test_1: [['periodic_test', 10]],
      half_yearly: [['notebook', 5], ['subject_enrichment', 5], ['written', 80]],
      periodic_test_2: [['periodic_test', 10]],
      annual: [['notebook', 5], ['subject_enrichment', 5], ['written', 80]],
    }
    // Each pupil has a steady level, so their marks tell one story across exams.
    const abilityOf = new Map<string, number>()
    const ability = (studentId: string): number => {
      const known = abilityOf.get(studentId)
      if (known !== undefined) return known
      const level = Math.min(0.97, Math.max(0.3, 0.55 + random() * 0.4))
      abilityOf.set(studentId, level)
      return level
    }
    const markValue = (studentId: string, max: number): { status: string; tenths: number | null } => {
      const roll = random()
      if (max === 80 && roll < 0.012) return { status: 'absent', tenths: null }
      if (max === 80 && roll < 0.018) return { status: 'medical', tenths: null }
      const raw = (ability(studentId) + (random() - 0.5) * 0.2) * max
      // Whole or half marks, as teachers give them.
      const halves = Math.round(Math.min(max, Math.max(0, raw)) * 2)
      return { status: 'marked', tenths: halves * 5 }
    }
    const optional = new Set(
      (
        await client.query<{ key: string }>(
          `SELECT academic_year_id || ':' || grade_id || ':' || subject_id AS key
             FROM grade_subjects WHERE school_id = $1 AND is_optional`,
          [schoolId],
        )
      ).rows.map((row) => row.key),
    )
    const papers = await client.query<{ id: string; exam_id: string; academic_year_id: string; section_id: string; subject_id: string }>(
      `SELECT p.id, p.exam_id, p.academic_year_id, p.section_id, p.subject_id
         FROM exam_papers p JOIN subjects s ON s.school_id = p.school_id AND s.id = p.subject_id
        WHERE p.school_id = $1 ORDER BY s.name, p.id`,
      [schoolId],
    )
    const incompleteSection = findSection(8, 'B', 12)
    // Class 5 B's half-yearly is not finished: three pupils still have no
    // written mark in its first subject.
    const incompleteSubject = papers.rows.find((paper) => paper.section_id === incompleteSection?.id)?.subject_id
    const pt2Sections = new Set([findSection(9, 'A', 13)?.id, findSection(9, 'B', 14)?.id])
    interface ExamMarkRow { id: string; paperId: string; examId: string; yearId: string; sectionId: string; subjectId: string; studentId: string; component: string; status: string; tenths: number | null; by: string }
    const examMarks: ExamMarkRow[] = []
    for (const exam of examPlan) {
      const examId = examIdOf.get(`${exam.year.id}:${exam.kind}`) as string
      const current = exam.year.id === yearNow.id
      // This year's periodic test 2 is under way in two sections; the annual exam is ahead.
      if (current && exam.kind === 'annual') continue
      const rows = current ? enrolled : enrolledPast
      for (const paper of papers.rows.filter((row) => row.exam_id === examId)) {
        if (current && exam.kind === 'periodic_test_2' && !pt2Sections.has(paper.section_id)) continue
        const section = sectionById.get(paper.section_id) as SectionRow
        const isOptional = optional.has(`${exam.year.id}:${section.gradeId}:${paper.subject_id}`)
        const by = subjectTeacherMembership(paper.section_id, paper.subject_id, exam.starts)
        const roster = enrolledIn(rows, paper.section_id, exam.starts)
        for (const [index, studentId] of roster.entries()) {
          for (const [component, max] of COMPONENTS[exam.kind] as [string, number][]) {
            if (
              current && exam.kind === 'half_yearly' && paper.section_id === incompleteSection?.id &&
              component === 'written' && index >= roster.length - 3 && paper.subject_id === incompleteSubject
            ) continue
            // An optional subject a pupil does not take is marked exempt.
            const value = isOptional && index % 3 === 0 ? { status: 'exempt', tenths: null } : markValue(studentId, max)
            examMarks.push({
              id: randomUUID(), paperId: paper.id, examId, yearId: exam.year.id, sectionId: paper.section_id,
              subjectId: paper.subject_id, studentId, component, status: value.status, tenths: value.tenths, by,
            })
          }
        }
      }
    }
    await insertMany(
      client,
      'exam_marks',
      ['id', 'school_id', 'paper_id', 'exam_id', 'academic_year_id', 'section_id', 'subject_id', 'student_id',
        'component', 'status', 'marks_tenths', 'recorded_by_membership_id', 'revision', 'kind'],
      examMarks.map((row) => [row.id, schoolId, row.paperId, row.examId, row.yearId, row.sectionId, row.subjectId,
        row.studentId, row.component, row.status, row.tenths, row.by, 1, 'entry']),
    )
    // Re-checks in class: four written marks raised by the subject teacher
    // before the deadline, and one the office corrected after it. The words
    // of each reason are the audit note, as the API and the dev seed write them.
    const halfYearly = examIdOf.get(`${yearNow.id}:half_yearly`) as string
    const written = examMarks.filter(
      (row) => row.examId === halfYearly && row.component === 'written' && row.status === 'marked' && (row.tenths ?? 0) <= 700 &&
        row.sectionId !== incompleteSection?.id,
    )
    const reChecked = [written[3], written[40], written[97], written[160]].filter((row): row is ExamMarkRow => row !== undefined)
    const officeFixSection = findSection(4, 'A', 3)
    const officeFix = written.find((row) => row.sectionId === officeFixSection?.id && !reChecked.includes(row))
    const changes: { row: ExamMarkRow; by: string; kind: string; reasonKind: string; raise: number; action: string; note: string; summary: string }[] = [
      ...reChecked.map((row) => ({
        row, by: row.by, kind: 'entry', reasonKind: 'recheck', raise: 30, action: 'exams.record_marks',
        note: 'Re-checked in class: one answer was marked short by three marks.', summary: 'Saved marks for a paper.',
      })),
      ...(officeFix
        ? [{
            row: officeFix, by: officeMembership, kind: 'correction', reasonKind: 'entry_error', raise: 50, action: 'exams.manage',
            note: 'The page total was copied wrongly onto the marks sheet; corrected from the answer book.', summary: 'Corrected marks on a paper.',
          }]
        : []),
    ]
    await insertMany(
      client,
      'exam_marks',
      ['school_id', 'paper_id', 'exam_id', 'academic_year_id', 'section_id', 'subject_id', 'student_id', 'component',
        'status', 'marks_tenths', 'revision', 'supersedes_mark_id', 'kind', 'reason_kind', 'recorded_by_membership_id'],
      changes.map(({ row, by, kind, reasonKind, raise }) => [schoolId, row.paperId, row.examId, row.yearId, row.sectionId,
        row.subjectId, row.studentId, row.component, 'marked', Math.min(800, (row.tenths ?? 0) + raise), 2, row.id, kind, reasonKind, by]),
    )
    const audits = changes.map((change) => ({ ...change, eventId: randomUUID() }))
    await insertMany(
      client,
      'audit_events',
      ['id', 'school_id', 'actor_membership_id', 'action', 'target_type', 'target_id', 'result', 'summary', 'safe_changes', 'request_id'],
      audits.map(({ eventId, row, by, action, kind, reasonKind, summary }) => [eventId, schoolId, by, action, 'exam_paper', row.paperId,
        'allowed', summary, JSON.stringify({ paperId: row.paperId, examId: row.examId, sectionId: row.sectionId, subjectId: row.subjectId,
          [kind === 'correction' ? 'corrected' : 'changed']: 1, reasonKind }), 'seed-activity']),
      { safe_changes: 'jsonb' },
    )
    await insertMany(
      client,
      'audit_event_notes',
      ['school_id', 'audit_event_id', 'note'],
      audits.map(({ eventId, note }) => [schoolId, eventId, note]),
    )
    // Publications: every exam of the closed year, and this year's periodic
    // test 1 everywhere and the half-yearly everywhere but Class 5 B.
    const publications: unknown[][] = []
    for (const exam of examPlan) {
      if (exam.year.id === yearNow.id && (exam.kind === 'periodic_test_2' || exam.kind === 'annual')) continue
      const examId = examIdOf.get(`${exam.year.id}:${exam.kind}`) as string
      for (const section of sections.filter((row) => row.yearId === exam.year.id)) {
        if (exam.year.id === yearNow.id && exam.kind === 'half_yearly' && section.id === incompleteSection?.id) continue
        if (!papers.rows.some((paper) => paper.exam_id === examId && paper.section_id === section.id)) continue
        publications.push([schoolId, examId, exam.year.id, section.id, principalMembership])
      }
    }
    await insertMany(
      client,
      'exam_publications',
      ['school_id', 'exam_id', 'academic_year_id', 'section_id', 'published_by_membership_id'],
      publications,
    )
    // The class teacher's part: co-scholastic grades and remarks for every
    // term that has been assessed.
    const REMARKS = [
      'Works steadily and asks good questions. Should read more at home.',
      'A cheerful member of the class who helps others. Needs to take more care with handwriting.',
      'Has made real progress this term. Keep practising the tables every day.',
      'Participates well in class discussions. Must complete homework on time.',
      'Shows a keen interest in science projects. Should revise regularly before tests.',
      'Polite and attentive. Needs more confidence when speaking in front of the class.',
    ]
    const coGrade = (): string => {
      const roll = random()
      return roll < 0.55 ? 'A' : roll < 0.9 ? 'B' : 'C'
    }
    const termEntries: { section: SectionRow; term: string; roster: string[] }[] = []
    for (const section of sections) {
      const past = section.yearId === yearPast.id
      if (!past && section.id === incompleteSection?.id) continue
      const rows = past ? enrolledPast : enrolled
      for (const [term, kind] of past ? [['term_1', 'half_yearly'], ['term_2', 'annual']] : [['term_1', 'half_yearly']]) {
        const exam = examPlan.find((row) => row.year.id === section.yearId && row.kind === kind)
        if (!exam) continue
        termEntries.push({ section, term: term as string, roster: enrolledIn(rows, section.id, exam.starts) })
      }
    }
    let remarkIndex = 0
    const entryRows: unknown[][] = []
    for (const entry of termEntries) {
      const by = classTeacherMembership(entry.section)
      for (const studentId of entry.roster) {
        entryRows.push([schoolId, studentId, entry.section.yearId, entry.section.id, entry.term, coGrade(), coGrade(), coGrade(),
          coGrade(), REMARKS[remarkIndex++ % REMARKS.length], by])
      }
    }
    await insertMany(
      client,
      'report_card_entries',
      ['school_id', 'student_id', 'academic_year_id', 'section_id', 'term', 'work_education', 'art_education',
        'health_physical_education', 'discipline', 'remarks', 'updated_by_membership_id'],
      entryRows,
    )

    // Published report cards, built by the same code the office's publish
    // uses: this year's term 1 card wherever the half-yearly is published, and
    // the closed year's term 1 and final cards. Building reads one pupil at a
    // time; the versions go in together.
    const cardRows: unknown[][] = []
    for (const entry of termEntries) {
      const card: 'term_1' | 'final' = entry.term === 'term_1' ? 'term_1' : 'final'
      for (const studentId of entry.roster) {
        const built = await buildReportCard(conn, schoolId, {
          studentId, sectionId: entry.section.id, academicYearId: entry.section.yearId, card, today: runDate,
        })
        cardRows.push([schoolId, studentId, entry.section.yearId, entry.section.id, card, 1, JSON.stringify(built.content),
          Object.keys(built.remarks).length === 0 ? null : JSON.stringify(built.remarks), built.hash, principalMembership])
      }
    }
    await insertMany(
      client,
      'report_card_versions',
      ['school_id', 'student_id', 'academic_year_id', 'section_id', 'card', 'version_number', 'content', 'remarks',
        'content_hash', 'published_by_membership_id'],
      cardRows,
      { content: 'jsonb', remarks: 'jsonb' },
    )

    await client.query('COMMIT')
    console.info(
      `Attendance: ${marks.length} pupil marks (${skippedMarks} pupil days already marked and left alone), ` +
        `${corrected.length} corrections, ${staffMarks.length} staff marks.`,
    )
    console.info(
      `Exams: ${examPlan.length} exams over two years, ${papers.rows.length} papers, ${examMarks.length} marks, ` +
        `${reChecked.length} re-checks and ${officeFix ? 1 : 0} office correction, ${publications.length} publications; ` +
        `${incompleteSection ? `${incompleteSection.gradeName} ${incompleteSection.name}` : 'no section'} left unfinished; ` +
        `${entryRows.length} grade and remark entries; ${cardRows.length} report cards published.`,
    )
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await migrator.end()
  }
}

await main()
