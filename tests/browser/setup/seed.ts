/**
 * Seeds the browser suite's database. Run once, by the Playwright global
 * setup, through tsx — never by a test.
 *
 * It is deliberately a separate process: it uses the API's own configuration,
 * pool and authentication instance so a password is hashed exactly the way the
 * sign-in route verifies it, and there is no HTTP route that provisions one.
 *
 * It writes nothing the application itself could not have written, except the
 * rows the API has no endpoint for (teaching assignments and enrolments), and
 * it never touches the shared fixture people.
 */
import pg from 'pg'
import { seedFixtures } from '@erp/db/fixtures'
import { loadConfig } from '../../../apps/api/src/config.ts'
import { createPools } from '../../../apps/api/src/db.ts'
import { createSandboxDelivery } from '../../../apps/api/src/delivery/index.ts'
import { createAuth } from '../../../apps/api/src/auth/better-auth.ts'
import {
  ASSIST_GRADE_NAME,
  ASSIST_PUPILS_R,
  ASSIST_PUPILS_S,
  GRADE_A,
  SCHOOL_A,
  SCHOOL_B,
  SECTION_A1,
  YEAR_A,
  ids,
  ownerA,
  people,
  teacherAlpha,
  teacherBeta,
  teacherDual,
  teacherDelta,
  teacherDualSchoolB,
  teacherGamma,
  type Person,
} from './people.ts'

const migratorUrl = process.env.BROWSER_MIGRATOR_URL
if (!migratorUrl) throw new Error('BROWSER_MIGRATOR_URL is required')
const database = decodeURIComponent(new URL(migratorUrl).pathname.slice(1))
if (database === 'erp')
  throw new Error(
    'The browser suite refuses to seed "erp", the development database. ' +
      'Point BROWSER_MIGRATOR_URL at erp_browser.',
  )

const pool = new pg.Pool({ connectionString: migratorUrl })

async function q(sql: string, params: unknown[] = []): Promise<void> {
  await pool.query(sql, params)
}

/** A membership with roles, plus the auth identity behind it. */
async function member(
  schoolId: string,
  person: Person,
  membershipId: string,
  roleKeys: readonly string[],
): Promise<void> {
  await q(
    `INSERT INTO auth_user (id, name, email, email_verified)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email`,
    [person.userId, person.displayName, person.email],
  )
  await q(
    `INSERT INTO school_memberships (id, school_id, user_id, kind, status)
     VALUES ($1, $2, $3, 'adult', 'active')
     ON CONFLICT (school_id, user_id) DO UPDATE SET status = 'active'`,
    [membershipId, schoolId, person.userId],
  )
  // A run after a suspension test must start from a clean, active membership.
  await q(
    `UPDATE school_memberships SET status = 'active' WHERE id = $1`,
    [membershipId],
  )
  await q(
    `INSERT INTO membership_roles (school_id, membership_id, role_id)
     SELECT $1, $2, id FROM roles WHERE school_id = $1 AND key = ANY($3::text[])
     ON CONFLICT DO NOTHING`,
    [schoolId, membershipId, [...roleKeys]],
  )
}

/** A staff record linked to a membership, assigned to teach one section. */
async function teaches(input: {
  schoolId: string
  academicYearId: string
  sectionId: string
  subjectId: string
  membershipId: string
  staffId: string
  employeeCode: string
  /** The member directory shows the staff name, so it must match the person. */
  displayName: string
}): Promise<void> {
  const [firstName, ...rest] = input.displayName.split(' ')
  await q(
    `INSERT INTO staff (id, school_id, employee_code, first_name, last_name, staff_type, designation, status)
     VALUES ($1, $2, $3, $4, $5, 'teaching', 'Teacher', 'active')
     ON CONFLICT (id) DO UPDATE
       SET employee_code = EXCLUDED.employee_code,
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name`,
    [input.staffId, input.schoolId, input.employeeCode, firstName, rest.join(' ') || null],
  )
  await q(
    `INSERT INTO membership_staff_links (school_id, membership_id, staff_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [input.schoolId, input.membershipId, input.staffId],
  )
  await q(
    `INSERT INTO teaching_assignments
       (school_id, staff_id, academic_year_id, section_id, subject_id, effective_from)
     VALUES ($1, $2, $3, $4, $5, '2026-04-01') ON CONFLICT DO NOTHING`,
    [
      input.schoolId,
      input.staffId,
      input.academicYearId,
      input.sectionId,
      input.subjectId,
    ],
  )
}

async function student(input: {
  id: string
  schoolId: string
  academicYearId: string
  sectionId: string
  admissionNumber: string
  firstName: string
  lastName: string
  rollNumber: number
}): Promise<void> {
  await q(
    `INSERT INTO students (id, school_id, admission_number, first_name, last_name, status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name`,
    [
      input.id,
      input.schoolId,
      input.admissionNumber,
      input.firstName,
      input.lastName,
    ],
  )
  // There is no unique key on (school, student, year), so the enrolment is
  // rewritten rather than upserted: a re-run must not stack a second row.
  await q(
    `DELETE FROM enrollments WHERE school_id = $1 AND student_id = $2 AND academic_year_id = $3`,
    [input.schoolId, input.id, input.academicYearId],
  )
  await q(
    `INSERT INTO enrollments
       (id, school_id, student_id, academic_year_id, section_id, roll_number, joined_on)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, '2026-04-01')`,
    [
      input.schoolId,
      input.id,
      input.academicYearId,
      input.sectionId,
      input.rollNumber,
    ],
  )
}

/**
 * The assistant's class: grade Eight with sections R and S, three pupils in
 * each, Teacher Delta as their class teacher, and the assistant switched on
 * for school A (the owner's settings switch, written as its row).
 *
 * A run starts with both registers unmarked and Delta with no conversations
 * and no questions counted today. Attendance rows are append-only in the
 * database, so the trigger is lifted for the one delete and put straight back.
 */
async function assistantFixtures(): Promise<void> {
  await q(
    `INSERT INTO grades (id, school_id, name, short_name, sort_order)
     VALUES ($1, $2, $3, '8', 8) ON CONFLICT (school_id, name) DO NOTHING`,
    [ids.gradeAssist, SCHOOL_A, ASSIST_GRADE_NAME],
  )
  for (const [sectionId, name] of [
    [ids.sectionAssistR, 'R'],
    [ids.sectionAssistS, 'S'],
  ] as const) {
    await q(
      `INSERT INTO sections (id, school_id, academic_year_id, grade_id, name)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [sectionId, SCHOOL_A, YEAR_A, ids.gradeAssist, name],
    )
  }
  for (const [sectionId, pupils, prefix] of [
    [ids.sectionAssistR, ASSIST_PUPILS_R, 'BR/2026-27/3'],
    [ids.sectionAssistS, ASSIST_PUPILS_S, 'BR/2026-27/4'],
  ] as const) {
    for (const pupil of pupils) {
      const [firstName = '', lastName = ''] = pupil.name.split(' ')
      await student({
        id: pupil.id,
        schoolId: SCHOOL_A,
        academicYearId: YEAR_A,
        sectionId,
        admissionNumber: `${prefix}${String(pupil.roll).padStart(2, '0')}`,
        firstName,
        lastName,
        rollNumber: pupil.roll,
      })
    }
  }

  await member(SCHOOL_A, teacherDelta, teacherDelta.membershipId, ['teacher'])
  for (const sectionId of [ids.sectionAssistR, ids.sectionAssistS]) {
    await teaches({
      schoolId: SCHOOL_A,
      academicYearId: YEAR_A,
      sectionId,
      subjectId: ids.subjectA,
      membershipId: teacherDelta.membershipId,
      staffId: teacherDelta.staffId,
      employeeCode: 'BR-E105',
      displayName: teacherDelta.displayName,
    })
  }
  await q(
    `UPDATE sections SET class_teacher_staff_id = $3
      WHERE school_id = $1 AND id = ANY($2::uuid[])`,
    [SCHOOL_A, [ids.sectionAssistR, ids.sectionAssistS], teacherDelta.staffId],
  )

  await q(
    `INSERT INTO assistant_settings (school_id, enabled) VALUES ($1, true)
     ON CONFLICT (school_id) DO UPDATE SET enabled = true`,
    [SCHOOL_A],
  )
  await q('DELETE FROM assistant_threads WHERE school_id = $1 AND membership_id = $2', [
    SCHOOL_A,
    teacherDelta.membershipId,
  ])
  await q('DELETE FROM assistant_usage WHERE school_id = $1 AND membership_id = $2', [
    SCHOOL_A,
    teacherDelta.membershipId,
  ])

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('ALTER TABLE attendance_entries DISABLE TRIGGER attendance_entries_no_change')
    await client.query(
      'DELETE FROM attendance_entries WHERE school_id = $1 AND section_id = ANY($2::uuid[])',
      [SCHOOL_A, [ids.sectionAssistR, ids.sectionAssistS]],
    )
    await client.query('ALTER TABLE attendance_entries ENABLE TRIGGER attendance_entries_no_change')
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function main(): Promise<void> {
  await seedFixtures(pool)

  // ---- school A -------------------------------------------------------
  await q(
    `INSERT INTO subjects (id, school_id, name, code, type)
     VALUES ($1, $2, 'Browser Studies', 'BRW', 'scholastic')
     ON CONFLICT (id) DO NOTHING`,
    [ids.subjectA, SCHOOL_A],
  )
  await q(
    `INSERT INTO sections (id, school_id, academic_year_id, grade_id, name)
     VALUES ($1, $2, $3, $4, 'B')
     ON CONFLICT (id) DO NOTHING`,
    [ids.sectionA2, SCHOOL_A, YEAR_A, GRADE_A],
  )
  await student({
    id: ids.studentAlpha,
    schoolId: SCHOOL_A,
    academicYearId: YEAR_A,
    sectionId: SECTION_A1,
    admissionNumber: 'BR/2026-27/101',
    firstName: 'Alpha',
    lastName: 'Learner',
    rollNumber: 11,
  })
  await student({
    id: ids.studentBeta,
    schoolId: SCHOOL_A,
    academicYearId: YEAR_A,
    sectionId: ids.sectionA2,
    admissionNumber: 'BR/2026-27/102',
    firstName: 'Beta',
    lastName: 'Learner',
    rollNumber: 12,
  })

  // The promotion pair: a next year, a section in each year and two students
  // nobody teaches, so a promotion run disturbs no other test.
  await q(
    `INSERT INTO academic_years (id, school_id, name, start_date, end_date, status)
     VALUES ($1, $2, '2027-28', '2027-04-01', '2028-03-31', 'upcoming')
     ON CONFLICT (school_id, name) DO NOTHING`,
    [ids.yearANext, SCHOOL_A],
  )
  await q(
    `INSERT INTO sections (id, school_id, academic_year_id, grade_id, name)
     VALUES ($1, $2, $3, $4, 'P') ON CONFLICT (id) DO NOTHING`,
    [ids.sectionPromoteFrom, SCHOOL_A, YEAR_A, GRADE_A],
  )
  await q(
    `INSERT INTO sections (id, school_id, academic_year_id, grade_id, name)
     VALUES ($1, $2, $3, $4, 'Q') ON CONFLICT (id) DO NOTHING`,
    [ids.sectionPromoteTo, SCHOOL_A, ids.yearANext, GRADE_A],
  )
  // A re-run must find these two where it left them, whatever the last
  // promotion did to their enrolments.
  await q(
    `DELETE FROM enrollments WHERE school_id = $1 AND student_id = ANY($2::uuid[])`,
    [SCHOOL_A, [ids.studentPromoteOne, ids.studentPromoteTwo]],
  )
  await student({
    id: ids.studentPromoteOne,
    schoolId: SCHOOL_A,
    academicYearId: YEAR_A,
    sectionId: ids.sectionPromoteFrom,
    admissionNumber: 'BR/2026-27/103',
    firstName: 'Promote',
    lastName: 'Learner',
    rollNumber: 13,
  })
  await student({
    id: ids.studentPromoteTwo,
    schoolId: SCHOOL_A,
    academicYearId: YEAR_A,
    sectionId: ids.sectionPromoteFrom,
    admissionNumber: 'BR/2026-27/104',
    firstName: 'Stayput',
    lastName: 'Learner',
    rollNumber: 14,
  })

  await member(SCHOOL_A, teacherAlpha, teacherAlpha.membershipId, ['teacher'])
  await member(SCHOOL_A, teacherBeta, teacherBeta.membershipId, ['teacher'])
  await member(SCHOOL_A, teacherGamma, teacherGamma.membershipId, ['teacher'])
  await member(SCHOOL_A, teacherDual, teacherDual.membershipId, ['teacher'])
  await member(SCHOOL_A, ownerA, ownerA.membershipId, ['owner'])

  for (const [person, sectionId, code] of [
    [teacherAlpha, SECTION_A1, 'BR-E101'],
    [teacherBeta, ids.sectionA2, 'BR-E102'],
    [teacherGamma, SECTION_A1, 'BR-E103'],
    [teacherDual, SECTION_A1, 'BR-E104'],
  ] as const) {
    await teaches({
      schoolId: SCHOOL_A,
      academicYearId: YEAR_A,
      sectionId,
      subjectId: ids.subjectA,
      membershipId: person.membershipId,
      staffId: person.staffId,
      employeeCode: code,
      displayName: person.displayName,
    })
  }

  await assistantFixtures()

  // ---- school B, so one person can hold two memberships ---------------
  await q(
    `INSERT INTO academic_years (id, school_id, name, start_date, end_date, status)
     VALUES ($1, $2, '2026-27', '2026-04-01', '2027-03-31', 'current')
     ON CONFLICT (school_id, name) DO NOTHING`,
    [ids.yearB, SCHOOL_B],
  )
  await q(
    `INSERT INTO grades (id, school_id, name, short_name, sort_order)
     VALUES ($1, $2, 'Seven', '7', 7) ON CONFLICT (school_id, name) DO NOTHING`,
    [ids.gradeB, SCHOOL_B],
  )
  await q(
    `INSERT INTO sections (id, school_id, academic_year_id, grade_id, name)
     VALUES ($1, $2, $3, $4, 'A') ON CONFLICT (id) DO NOTHING`,
    [ids.sectionB1, SCHOOL_B, ids.yearB, ids.gradeB],
  )
  await q(
    `INSERT INTO subjects (id, school_id, name, code, type)
     VALUES ($1, $2, 'Browser Studies', 'BRW', 'scholastic')
     ON CONFLICT (id) DO NOTHING`,
    [ids.subjectB, SCHOOL_B],
  )
  await student({
    id: ids.studentBravo,
    schoolId: SCHOOL_B,
    academicYearId: ids.yearB,
    sectionId: ids.sectionB1,
    admissionNumber: 'BR/2026-27/201',
    firstName: 'Bravo',
    lastName: 'Learner',
    rollNumber: 21,
  })
  await member(SCHOOL_B, teacherDual, teacherDualSchoolB.membershipId, [
    'teacher',
  ])
  await teaches({
    schoolId: SCHOOL_B,
    academicYearId: ids.yearB,
    sectionId: ids.sectionB1,
    subjectId: ids.subjectB,
    membershipId: teacherDualSchoolB.membershipId,
    staffId: teacherDualSchoolB.staffId,
    employeeCode: 'BR-E201',
    displayName: teacherDual.displayName,
  })

  // ---- passwords, and a clean second-factor state ---------------------
  const config = loadConfig({
    ...process.env,
    APP_ORIGIN: process.env.APP_ORIGIN ?? 'http://localhost:5174',
  })
  const pools = await createPools(config)
  const auth = createAuth(
    config,
    pools.auth,
    createSandboxDelivery(() => {}),
    pools.identity,
  )
  try {
    const context = await auth.$context
    for (const person of people) {
      const hash = await context.password.hash(person.password)
      const existing = await context.internalAdapter.findCredentialAccount(
        person.userId,
      )
      if (existing) await context.internalAdapter.updatePassword(person.userId, hash)
      else
        await context.internalAdapter.createAccount({
          userId: person.userId,
          providerId: 'credential',
          accountId: person.userId,
          password: hash,
        })
    }
  } finally {
    await pools.close()
  }

  // The owner enrols a fresh authenticator inside the test that needs one, so
  // every run starts from no second factor at all.
  await q('DELETE FROM auth_two_factor WHERE user_id = ANY($1::uuid[])', [
    people.map((p) => p.userId),
  ])
  await q(
    'UPDATE auth_user SET two_factor_enabled = false WHERE id = ANY($1::uuid[])',
    [people.map((p) => p.userId)],
  )
  // Sessions from an earlier run would otherwise survive into this one.
  await q('DELETE FROM auth_session WHERE user_id = ANY($1::uuid[])', [
    people.map((p) => p.userId),
  ])
  await q('DELETE FROM auth_rate_limit')
  await q('DELETE FROM auth_throttle')
}

try {
  await main()
} finally {
  await pool.end()
}
