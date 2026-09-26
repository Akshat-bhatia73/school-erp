/**
 * The people and records the scenarios are written about, read from the
 * fixture database after the seed and the eval's own additions. The dev seed
 * picks names deterministically but places some rows relative to the day it
 * runs (which registers are marked today), so nothing here is hard-coded.
 */
import type pg from 'pg'
import type { EvalRole, Facts, PersonFact, PupilFact, SectionFact } from './types.ts'

/** The seeded logins each role signs in as (apps/api/.dev/sunrise-logins.csv). */
export const LOGINS: Readonly<Record<EvalRole, string>> = {
  owner: 'rajesh.trustee@sunrise.test',
  principal: 'principal@sunrise.test',
  admin: 'office1@sunrise.test',
  accountant: 'accounts@sunrise.test',
  // A teacher and nothing else, class teacher of UKG A.
  teacher: 'teacher3@sunrise.test',
  // Two children in different classes.
  parent: 'parent1@sunrise.test',
  // A Class 9 pupil whose guardian allowed the assistant.
  pupil: 'SPS/2023-24/091',
}

export const LOGIN_CODE = 'sunrise'

function sectionOf(row: { section_id: string; grade: string; section: string }): SectionFact {
  const label = `${row.grade} ${row.section}`
  const numbered = /^Class (\d+)$/.exec(row.grade)
  return { id: row.section_id, label, short: numbered ? `${numbered[1]}${row.section}` : label }
}

interface PupilRow {
  id: string
  first_name: string
  last_name: string
  admission_number: string
  section_id: string
  grade: string
  section: string
}

function pupilOf(row: PupilRow): PupilFact {
  return {
    id: row.id,
    name: `${row.first_name} ${row.last_name}`,
    firstName: row.first_name,
    lastName: row.last_name,
    admissionNumber: row.admission_number,
    section: sectionOf(row),
  }
}

const PUPILS = `
  SELECT s.id, s.first_name, s.last_name, s.admission_number, se.id AS section_id, g.name AS grade, se.name AS section
    FROM students s
    JOIN enrollments e ON e.student_id = s.id AND e.left_on IS NULL
    JOIN sections se ON se.id = e.section_id
    JOIN grades g ON g.id = se.grade_id
    JOIN academic_years y ON y.id = e.academic_year_id AND y.status = 'current'
   WHERE s.school_id = $1 AND s.status = 'active'`

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`The seeded school has no ${what}. Seed a fresh database (see docs/assistant/EVALS.md).`)
  return value
}

export async function schoolIdOf(db: pg.Pool): Promise<string> {
  const found = await db.query<{ id: string }>('SELECT id FROM schools WHERE login_code = $1', [LOGIN_CODE])
  return must(found.rows[0], 'Sunrise school').id
}

export async function loadFacts(db: pg.Pool): Promise<Facts> {
  const school = must(
    (
      await db.query<{ id: string; name: string; today: string; tomorrow: string; sunday: boolean; year_id: string; year_name: string }>(
        `SELECT s.id, s.name,
                to_char((now() AT TIME ZONE s.timezone)::date, 'YYYY-MM-DD') AS today,
                to_char((now() AT TIME ZONE s.timezone)::date + 1, 'YYYY-MM-DD') AS tomorrow,
                extract(dow FROM (now() AT TIME ZONE s.timezone)::date) = 0 AS sunday,
                y.id AS year_id, y.name AS year_name
           FROM schools s JOIN academic_years y ON y.id = s.current_academic_year_id
          WHERE s.login_code = $1`,
        [LOGIN_CODE],
      )
    ).rows[0],
    'Sunrise school with a current year',
  )
  const schoolId = school.id
  const holiday = await db.query('SELECT 1 FROM holidays WHERE school_id = $1 AND $2::date BETWEEN start_date AND end_date', [
    schoolId,
    school.today,
  ])

  const people = {} as Record<EvalRole, PersonFact>
  for (const [role, login] of Object.entries(LOGINS) as [EvalRole, string][]) {
    const found =
      role === 'pupil'
        ? await db.query<{ name: string; membership_id: string; user_id: string }>(
            `SELECT u.name, m.id AS membership_id, u.id AS user_id
               FROM students s
               JOIN membership_student_links l ON l.student_id = s.id
               JOIN school_memberships m ON m.id = l.membership_id
               JOIN auth_user u ON u.id = m.user_id
              WHERE s.school_id = $1 AND s.admission_number = $2`,
            [schoolId, login],
          )
        : await db.query<{ name: string; membership_id: string; user_id: string }>(
            `SELECT u.name, m.id AS membership_id, u.id AS user_id
               FROM auth_user u JOIN school_memberships m ON m.user_id = u.id AND m.school_id = $1
              WHERE u.email = $2`,
            [schoolId, login],
          )
    const row = must(found.rows[0], `login ${login}`)
    people[role] = { name: row.name, membershipId: row.membership_id, userId: row.user_id }
  }

  // The teacher: their class, its pupils, a section they never teach, a paper.
  const staffId = must(
    (
      await db.query<{ staff_id: string }>('SELECT staff_id FROM membership_staff_links WHERE membership_id = $1', [
        people.teacher.membershipId,
      ])
    ).rows[0],
    'staff record for the teacher',
  ).staff_id
  const classRow = must(
    (
      await db.query<{ section_id: string; grade: string; section: string }>(
        `SELECT se.id AS section_id, g.name AS grade, se.name AS section
           FROM sections se JOIN grades g ON g.id = se.grade_id
          WHERE se.class_teacher_staff_id = $1 AND se.academic_year_id = $2`,
        [staffId, school.year_id],
      )
    ).rows[0],
    'class for the teacher',
  )
  const classSection = sectionOf(classRow)
  const classPupils = (await db.query<PupilRow>(`${PUPILS} AND se.id = $2 ORDER BY e.roll_number, s.id`, [schoolId, classSection.id])).rows.map(
    pupilOf,
  )

  const pupilSelf = pupilOf(must((await db.query<PupilRow>(`${PUPILS} AND s.admission_number = $2`, [schoolId, LOGINS.pupil])).rows[0], 'pupil login'))
  const nineA = (await db.query<PupilRow>(`${PUPILS} AND se.id = $2 ORDER BY e.roll_number, s.id`, [schoolId, pupilSelf.section.id])).rows.map(pupilOf)
  const taught = await db.query(
    `SELECT 1 FROM teaching_assignments WHERE staff_id = $1 AND section_id = $2
     UNION ALL SELECT 1 FROM sections WHERE id = $2 AND class_teacher_staff_id = $1`,
    [staffId, pupilSelf.section.id],
  )
  if (taught.rows.length > 0) throw new Error('The teacher login teaches the pupil login\'s class; the access scenarios need a class they do not teach.')
  // The other pupil logins of the class, so "a classmate" is someone with an ordinary record.
  const classmate = must(
    nineA.find((pupil) => pupil.id !== pupilSelf.id),
    'classmate for the pupil login',
  )
  const other9A = must(
    nineA.filter((pupil) => pupil.id !== pupilSelf.id && pupil.id !== classmate.id).at(-1),
    'second classmate',
  )
  const classTeacher = must(
    (
      await db.query<{ name: string }>(
        `SELECT st.first_name || ' ' || st.last_name AS name FROM sections se JOIN staff st ON st.id = se.class_teacher_staff_id WHERE se.id = $1`,
        [pupilSelf.section.id],
      )
    ).rows[0],
    'class teacher of the pupil login',
  ).name

  const paper = (
    await db.query<{ section_id: string; grade: string; section: string; subject: string }>(
      `SELECT se.id AS section_id, g.name AS grade, se.name AS section, sub.name AS subject
         FROM exam_papers p
         JOIN exams x ON x.id = p.exam_id AND x.kind = 'periodic_test_2' AND x.academic_year_id = $2
         JOIN teaching_assignments ta ON ta.section_id = p.section_id AND ta.subject_id = p.subject_id
              AND ta.staff_id = $1 AND ta.effective_to IS NULL
         JOIN sections se ON se.id = p.section_id
         JOIN grades g ON g.id = se.grade_id
         JOIN subjects sub ON sub.id = p.subject_id
        WHERE NOT EXISTS (SELECT 1 FROM exam_marks m WHERE m.paper_id = p.id)
          AND x.starts_on <= $3::date
        ORDER BY g.sort_order DESC, se.name
        LIMIT 1`,
      [staffId, school.year_id, school.today],
    )
  ).rows[0]
  const openPaper = paper
    ? {
        section: sectionOf(paper),
        subject: paper.subject,
        pupils: (await db.query<PupilRow>(`${PUPILS} AND se.id = $2 ORDER BY e.roll_number, s.id LIMIT 3`, [schoolId, paper.section_id])).rows.map(
          pupilOf,
        ),
      }
    : null

  const twinNames = new Map<string, PupilFact[]>()
  for (const pupil of classPupils) twinNames.set(pupil.firstName, [...(twinNames.get(pupil.firstName) ?? []), pupil])
  const twins = must(
    [...twinNames.values()].find((list) => list.length >= 2),
    'two pupils sharing a first name in the teacher\'s class (evals/extras.ts)',
  )

  const marked = must(
    (
      await db.query<{ section_id: string; grade: string; section: string }>(
        `SELECT se.id AS section_id, g.name AS grade, se.name AS section
           FROM sections se JOIN grades g ON g.id = se.grade_id
          WHERE se.academic_year_id = $1
            AND EXISTS (SELECT 1 FROM attendance_entries a WHERE a.section_id = se.id AND a.date = $2::date)
          ORDER BY g.sort_order DESC, se.name LIMIT 1`,
        [school.year_id, school.today],
      )
    ).rows[0] ?? { section_id: pupilSelf.section.id, grade: 'Class 9', section: 'A' },
    'section',
  )

  const children = (
    await db.query<PupilRow>(
      `${PUPILS} AND s.id IN (
         SELECT sg.student_id FROM membership_guardian_links l
           JOIN student_guardians sg ON sg.guardian_id = l.guardian_id
          WHERE l.membership_id = $2)
       ORDER BY s.first_name`,
      [schoolId, people.parent.membershipId],
    )
  ).rows.map(pupilOf)
  if (children.length === 0) throw new Error('The parent login has no children in the seeded school.')

  const injected = must(
    classPupils.find((pupil) => !twins.includes(pupil) && pupil.id !== classPupils[0]?.id),
    'pupil for the injected note',
  )

  const named = classPupils.filter((pupil) => twinNames.get(pupil.firstName)?.length === 1 && pupil.id !== injected.id)
  if (named.length < 3) throw new Error('The teacher\'s class needs three pupils with first names of their own.')

  const staffMember = must(
    (
      await db.query<{ id: string; first_name: string; last_name: string }>(
        `SELECT st.id, st.first_name, st.last_name FROM staff st
          WHERE st.school_id = $1 AND st.status = 'active' AND st.staff_type = 'teaching'
            AND NOT EXISTS (SELECT 1 FROM membership_staff_links l WHERE l.staff_id = st.id AND l.membership_id = $2)
            AND (SELECT count(*) FROM staff o WHERE o.school_id = st.school_id AND o.first_name = st.first_name) = 1
          ORDER BY st.employee_code LIMIT 1`,
        [schoolId, people.admin.membershipId],
      )
    ).rows[0],
    'staff member for the staff register',
  )

  return {
    schoolId,
    schoolName: school.name,
    today: school.today,
    tomorrow: school.tomorrow,
    schoolDay: !school.sunday && holiday.rows.length === 0,
    yearName: school.year_name,
    people,
    teacher: {
      staffId,
      classSection,
      classPupils,
      named,
      otherSection: pupilSelf.section,
      openPaper,
      twins: [twins[0]!, twins[1]!],
    },
    principalView: { pupil: other9A, markedSection: sectionOf(marked) },
    parent: { children, otherChild: other9A },
    pupil: { self: pupilSelf, classmate, classTeacher },
    injected,
    staffMember: { id: staffMember.id, name: `${staffMember.first_name} ${staffMember.last_name}`, firstName: staffMember.first_name },
  }
}
