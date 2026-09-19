/**
 * Builds one realistic school in the development database so every screen can
 * be opened with data that looks like a real Indian school: a full grade list,
 * around three hundred students with guardians, thirty staff, a timetable and
 * the sign-in accounts for every role.
 *
 *   pnpm --filter @erp/api dev:seed
 *
 * Development only, and safe to run twice: the school it owns is deleted and
 * rebuilt from scratch in one transaction. The frozen Fixture A and Fixture B
 * schools, and the people who sign in to them, are never touched.
 *
 * A hosted test database is seeded from a developer machine with the same
 * command: point the four database URLs and AUTH_SECRET at it (second factor
 * secrets are encrypted with that secret), and set SEED_PASSWORD to a private
 * value and SEED_LOGINS_FILE to a separate file. See docs/auth/RELEASE.md.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { ROLE_TEMPLATES } from '@erp/contracts'
import { loadConfig } from '../src/config.ts'
import { createPools } from '../src/db.ts'
import { createSandboxDelivery } from '../src/delivery/index.ts'
import { createAuth, type AuthInstance } from '../src/auth/better-auth.ts'
import { buildApp } from '../src/app.ts'
import { createMemoryDocumentStorage } from '../src/files/storage.ts'
import { decodeBase32 } from './totp-secret.ts'

/** Documented in docs/auth/WEB_SESSION.md. Development accounts only. */
/** The development password is public. A hosted build must choose its own. */
const PASSWORD = process.env.SEED_PASSWORD ?? 'sunrise-password-1'
const LOGIN_CODE = 'sunrise'
const EMAIL_DOMAIN = '@sunrise.test'
const SHORT_NAME = 'SPS'

const MIGRATOR_URL =
  process.env.MIGRATION_DATABASE_URL ??
  process.env.DEV_MIGRATOR_DATABASE_URL ??
  'postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp'

function refuse(reason: string): never {
  console.error(`dev:seed refused to run: ${reason}`)
  process.exit(1)
}

/** A small deterministic generator, so two runs produce the same school. */
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
const pick = <T>(values: readonly T[]): T =>
  values[Math.floor(random() * values.length)] as T
const between = (low: number, high: number): number =>
  low + Math.floor(random() * (high - low + 1))

const MALE_NAMES = [
  'Aarav', 'Vivaan', 'Aditya', 'Reyansh', 'Kabir', 'Arjun', 'Ishaan', 'Rudra',
  'Devansh', 'Yuvraj', 'Harsh', 'Nikhil', 'Rohit', 'Siddharth', 'Manav',
  'Pranav', 'Om', 'Krish', 'Tanmay', 'Aryan', 'Dhruv', 'Kunal', 'Sarthak',
  'Rishabh', 'Naveen', 'Parth', 'Shaurya', 'Ayush', 'Vedant', 'Gaurav',
]
const FEMALE_NAMES = [
  'Ananya', 'Diya', 'Saanvi', 'Aadhya', 'Ira', 'Myra', 'Kiara', 'Anika',
  'Riya', 'Meera', 'Sneha', 'Pooja', 'Nisha', 'Shreya', 'Tanvi', 'Aditi',
  'Kavya', 'Isha', 'Neha', 'Priya', 'Radhika', 'Swara', 'Mahi', 'Bhavya',
  'Lavanya', 'Sanjana', 'Trisha', 'Vaishnavi', 'Yashika', 'Rachana',
]
const SURNAMES = [
  'Sharma', 'Verma', 'Gupta', 'Iyer', 'Nair', 'Reddy', 'Patel', 'Desai',
  'Joshi', 'Kulkarni', 'Chauhan', 'Rathore', 'Bhatt', 'Menon', 'Shetty',
  'Kapoor', 'Malhotra', 'Bose', 'Chatterjee', 'Banerjee', 'Pillai', 'Rao',
  'Saxena', 'Tiwari', 'Mishra', 'Yadav', 'Sinha', 'Ghosh', 'Deshpande',
  'Agarwal', 'Bansal', 'Khanna', 'Thakur', 'Pandey', 'Naidu', 'Dubey',
]
const OCCUPATIONS = [
  'Bank manager', 'Shop owner', 'Software engineer', 'Doctor', 'Teacher',
  'Advocate', 'Farmer', 'Chartered accountant', 'Police officer', 'Homemaker',
  'Electrician', 'Civil contractor', 'Pharmacist', 'Sales manager',
]
const LOCALITIES = [
  'Ashok Nagar', 'Model Town', 'Vasant Vihar', 'Rajendra Nagar', 'Green Park',
  'Shivaji Colony', 'Gandhi Road', 'Civil Lines', 'Indira Nagar', 'MG Road',
]
const BLOOD_GROUPS = ['A+', 'B+', 'O+', 'AB+', 'A-', 'O-']
const CATEGORIES = ['General', 'General', 'General', 'OBC', 'OBC', 'SC', 'ST', 'EWS']
const MEDICAL_NOTES = [
  'Mild dust allergy. Keeps an inhaler in the school bag.',
  'Wears spectacles. Seat towards the front of the class.',
  'Lactose intolerant. No milk in the mid-day snack.',
  'Peanut allergy. Canteen has been informed.',
  'Recovered from a fracture in 2025. No contact sport for now.',
]

function address(): string {
  return `${between(1, 240)}, ${pick(LOCALITIES)}, Nagpur, Maharashtra 4400${between(10, 35)}`
}

/** A distinct mobile block, so no seeded number can collide with a fixture. */
let phoneCounter = 0
function mobile(): string {
  phoneCounter += 1
  return `+9198${String(20000000 + phoneCounter * 37).padStart(8, '0')}`
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Text held in a jsonb column is stored as a JSON string, as the API writes it. */
const jsonText = (value: string): string => JSON.stringify(value)

interface GradeSeed {
  id: string
  name: string
  shortName: string
  sortOrder: number
}

interface SectionSeed {
  id: string
  yearId: string
  grade: GradeSeed
  name: string
}

interface SubjectSeed {
  id: string
  name: string
  code: string
  type: 'scholastic' | 'co_scholastic' | 'language' | 'elective'
  /** The lowest grade sort order that takes this subject. */
  fromSort: number
  /** The highest grade sort order that takes it, when it stops. */
  toSort: number
  optional: boolean
  /** Weekly periods, used by the timetable builder. */
  periodsPerWeek: number
}

interface StaffSeed {
  id: string
  code: string
  firstName: string
  lastName: string
  staffType: 'teaching' | 'non_teaching' | 'admin' | 'support'
  designation: string
  status: 'active' | 'on_leave' | 'resigned' | 'retired'
  department: string
  subjects: string[]
  gender: 'male' | 'female'
  phone: string
  email: string
  joiningDate: string
  leavingDate: string | null
  salary: number
}

interface StudentSeed {
  id: string
  firstName: string
  lastName: string
  gender: 'male' | 'female'
  admissionNumber: string
  admissionDate: string
  dateOfBirth: string
  category: string
  status: 'active' | 'left' | 'alumni'
  bloodGroup: string
  medicalNotes: string | null
  address: string
  leftOn: string | null
  leftReason: string | null
  section: SectionSeed | null
  rollNumber: number | null
  priorSection: SectionSeed | null
  priorOutcome: 'promoted' | 'detained' | 'left'
}

interface CsvRow {
  name: string
  roles: string
  school: string
  method: string
  email: string
  phone: string
  password: string
  totpSecret: string
  otpauthUri: string
  linkedTo: string
  expect: string
}

interface LoginSeed {
  userId: string
  membershipId: string
  name: string
  roles: string[]
  email: string
  phone: string | null
  emailPassword: boolean
  mfa: boolean
  linkedTo: string
  expect: string
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const found = server.address()
  const port = typeof found === 'object' && found ? found.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function setPassword(auth: AuthInstance, userId: string, password: string): Promise<void> {
  const context = await auth.$context
  const hash = await context.password.hash(password)
  const existing = await context.internalAdapter.findCredentialAccount(userId)
  if (existing) {
    await context.internalAdapter.updatePassword(userId, hash)
    return
  }
  await context.internalAdapter.createAccount({
    userId,
    providerId: 'credential',
    accountId: userId,
    password: hash,
  })
}

/**
 * Removes the school this script owns, and only that school. audit_events is
 * append-only for the application, so its guard trigger is lifted for the
 * delete and put back inside the same transaction.
 */
async function removePreviousSchool(client: pg.PoolClient): Promise<void> {
  const found = await client.query<{ id: string }>(
    'SELECT id FROM schools WHERE login_code = $1',
    [LOGIN_CODE],
  )
  const schoolId = found.rows[0]?.id
  if (!schoolId) return

  const users = await client.query<{ user_id: string }>(
    'SELECT user_id FROM school_memberships WHERE school_id = $1',
    [schoolId],
  )
  await client.query('UPDATE schools SET current_academic_year_id = NULL WHERE id = $1', [schoolId])
  await client.query('ALTER TABLE audit_events DISABLE TRIGGER audit_no_update')
  const tables = [
    'export_jobs', 'student_import_previews',
    'timetable_entries', 'substitutions', 'teaching_assignments',
    'bell_schedule_grades', 'bell_schedules', 'holidays', 'grade_subjects',
    'student_documents', 'guardian_student_access', 'student_guardians',
    'enrollments', 'membership_student_links', 'membership_guardian_links',
    'membership_staff_links', 'resource_access_rules', 'school_invitations',
    'membership_roles', 'role_permissions', 'roles', 'audit_events',
    'delivery_outbox', 'number_sequences', 'school_memberships', 'students',
    'guardians', 'sections', 'grades', 'subjects', 'academic_years', 'staff',
  ]
  for (const table of tables) {
    await client.query(`DELETE FROM ${table} WHERE school_id = $1`, [schoolId])
  }
  await client.query('ALTER TABLE audit_events ENABLE TRIGGER audit_no_update')
  await client.query('DELETE FROM schools WHERE id = $1', [schoolId])

  // Identities are shared across schools, so only the ones with no membership
  // left anywhere and an address or number this script hands out are removed.
  const ids = users.rows.map((row) => row.user_id)
  if (ids.length > 0) {
    await client.query('DELETE FROM auth_session WHERE user_id = ANY($1::uuid[])', [ids])
    await client.query(
      `DELETE FROM auth_user
        WHERE id = ANY($1::uuid[])
          AND (email LIKE $2 OR phone_number LIKE '+9198%')
          AND NOT EXISTS (
            SELECT 1 FROM school_memberships WHERE user_id = auth_user.id)`,
      [ids, `%${EMAIL_DOMAIN}`],
    )
  }
}

/**
 * Clears only the auth counters this script is responsible for: the rate-limit
 * rows keyed to the loopback address the in-process server signs in from, and
 * the OTP throttle buckets for the phone numbers this seed hands out. Counters
 * a developer is deliberately exercising for other identities are left alone.
 */
async function clearOwnAuthCounters(
  migrator: pg.Pool,
  logins: readonly LoginSeed[],
): Promise<void> {
  await migrator.query("DELETE FROM auth_rate_limit WHERE key LIKE '127.0.0.1|%'")
  const phones = logins.map((login) => login.phone).filter((phone): phone is string => phone !== null)
  if (phones.length === 0) return
  await migrator.query(
    `DELETE FROM auth_throttle
      WHERE EXISTS (SELECT 1 FROM unnest($1::text[]) AS phone WHERE key LIKE '%' || phone)`,
    [phones],
  )
}

async function main(): Promise<void> {
  const config = loadConfig()
  if (config.NODE_ENV === 'production')
    refuse('NODE_ENV=production. This seed is for a developer machine only.')
  if (config.DELIVERY_MODE !== 'sandbox')
    refuse(
      `DELIVERY_MODE=${config.DELIVERY_MODE}. Real messages would be sent to seeded recipients.`,
    )

  const migrator = new pg.Pool({ connectionString: MIGRATOR_URL })
  const client = await migrator.connect()
  const schoolId = randomUUID()
  const logins: LoginSeed[] = []
  let teacherLoad = 0

  try {
    await client.query('BEGIN')
    await removePreviousSchool(client)

    // ---------------------------------------------------------------- school
    await client.query(
      `INSERT INTO schools (id, login_code, name, short_name, status, board,
                            address, phone, email, principal_name, established_year)
       VALUES ($1, $2, 'Sunrise Public School', $3, 'active', 'CBSE',
               to_jsonb($4::text), '+912212345678', 'office@sunrise.test',
               'Meera Deshpande', 1998)`,
      [schoolId, LOGIN_CODE, SHORT_NAME, 'Ring Road, Civil Lines, Nagpur, Maharashtra 440001'],
    )

    // ----------------------------------------------------------------- roles
    const roleIds = new Map<string, string>()
    for (const [key, template] of Object.entries(ROLE_TEMPLATES)) {
      const id = randomUUID()
      roleIds.set(key, id)
      await client.query(
        'INSERT INTO roles (id, school_id, key, name, is_system) VALUES ($1, $2, $3, $4, true)',
        [id, schoolId, key, template.displayName],
      )
      for (const grant of template.grants) {
        await client.query(
          `INSERT INTO role_permissions (school_id, role_id, permission, scope)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [schoolId, id, grant.permission, grant.scope],
        )
      }
    }

    // --------------------------------------------------------- academic years
    const yearPast = { id: randomUUID(), name: '2025-26', start: '2025-04-01', end: '2026-03-31' }
    const yearNow = { id: randomUUID(), name: '2026-27', start: '2026-04-01', end: '2027-03-31' }
    for (const [year, status] of [[yearPast, 'closed'], [yearNow, 'current']] as const) {
      await client.query(
        `INSERT INTO academic_years (id, school_id, name, start_date, end_date, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [year.id, schoolId, year.name, year.start, year.end, status],
      )
    }
    await client.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [
      schoolId,
      yearNow.id,
    ])

    // ---------------------------------------------------------------- grades
    const gradeNames: [string, string][] = [
      ['Nursery', 'N'], ['LKG', 'LKG'], ['UKG', 'UKG'],
      ...Array.from({ length: 10 }, (_, index): [string, string] => [
        `Class ${index + 1}`,
        String(index + 1),
      ]),
    ]
    const grades: GradeSeed[] = gradeNames.map(([name, shortName], index) => ({
      id: randomUUID(),
      name,
      shortName,
      sortOrder: index + 1,
    }))
    for (const grade of grades) {
      await client.query(
        'INSERT INTO grades (id, school_id, name, short_name, sort_order) VALUES ($1, $2, $3, $4, $5)',
        [grade.id, schoolId, grade.name, grade.shortName, grade.sortOrder],
      )
    }

    // -------------------------------------------------------------- sections
    // Two sections from Class 1 to Class 8, one everywhere else.
    const sectionNamesFor = (grade: GradeSeed): string[] =>
      grade.sortOrder >= 4 && grade.sortOrder <= 11 ? ['A', 'B'] : ['A']
    const sections: SectionSeed[] = []
    for (const year of [yearPast, yearNow]) {
      for (const grade of grades) {
        for (const name of sectionNamesFor(grade)) {
          sections.push({ id: randomUUID(), yearId: year.id, grade, name })
        }
      }
    }
    const sectionsNow = sections.filter((section) => section.yearId === yearNow.id)
    const findSection = (yearId: string, gradeSort: number, name: string): SectionSeed | null =>
      sections.find(
        (section) =>
          section.yearId === yearId &&
          section.grade.sortOrder === gradeSort &&
          section.name === name,
      ) ??
      sections.find(
        (section) => section.yearId === yearId && section.grade.sortOrder === gradeSort,
      ) ??
      null

    // -------------------------------------------------------------- subjects
    const subjects: SubjectSeed[] = [
      { id: randomUUID(), name: 'English', code: 'ENG', type: 'language', fromSort: 1, toSort: 13, optional: false, periodsPerWeek: 5 },
      { id: randomUUID(), name: 'Hindi', code: 'HIN', type: 'language', fromSort: 1, toSort: 13, optional: false, periodsPerWeek: 4 },
      { id: randomUUID(), name: 'Sanskrit', code: 'SAN', type: 'language', fromSort: 8, toSort: 13, optional: true, periodsPerWeek: 3 },
      { id: randomUUID(), name: 'Mathematics', code: 'MAT', type: 'scholastic', fromSort: 1, toSort: 13, optional: false, periodsPerWeek: 5 },
      { id: randomUUID(), name: 'Science', code: 'SCI', type: 'scholastic', fromSort: 9, toSort: 13, optional: false, periodsPerWeek: 4 },
      { id: randomUUID(), name: 'Social Science', code: 'SST', type: 'scholastic', fromSort: 9, toSort: 13, optional: false, periodsPerWeek: 3 },
      { id: randomUUID(), name: 'EVS', code: 'EVS', type: 'scholastic', fromSort: 4, toSort: 8, optional: false, periodsPerWeek: 4 },
      { id: randomUUID(), name: 'Computer Science', code: 'CS', type: 'scholastic', fromSort: 6, toSort: 13, optional: false, periodsPerWeek: 2 },
      { id: randomUUID(), name: 'Physical Education', code: 'PE', type: 'co_scholastic', fromSort: 1, toSort: 13, optional: false, periodsPerWeek: 2 },
      { id: randomUUID(), name: 'Art', code: 'ART', type: 'co_scholastic', fromSort: 1, toSort: 13, optional: false, periodsPerWeek: 2 },
    ]
    for (const subject of subjects) {
      await client.query(
        'INSERT INTO subjects (id, school_id, name, code, type) VALUES ($1, $2, $3, $4, $5)',
        [subject.id, schoolId, subject.name, subject.code, subject.type],
      )
    }
    const subjectsFor = (grade: GradeSeed): SubjectSeed[] =>
      subjects.filter(
        (subject) => grade.sortOrder >= subject.fromSort && grade.sortOrder <= subject.toSort,
      )
    for (const year of [yearPast, yearNow]) {
      for (const grade of grades) {
        for (const subject of subjectsFor(grade)) {
          await client.query(
            `INSERT INTO grade_subjects (school_id, grade_id, academic_year_id, subject_id, is_optional)
             VALUES ($1, $2, $3, $4, $5)`,
            [schoolId, grade.id, year.id, subject.id, subject.optional],
          )
        }
      }
    }

    // ----------------------------------------------------------------- staff
    const staffPlan: {
      designation: string
      staffType: StaffSeed['staffType']
      department: string
      subjects: string[]
      salary: [number, number]
      /** Left at the end of last session; keeps their record but no classes. */
      resigned?: boolean
    }[] = [
      { designation: 'Principal', staffType: 'admin', department: 'Administration', subjects: [], salary: [120000, 120000] },
      { designation: 'Vice Principal', staffType: 'admin', department: 'Administration', subjects: [], salary: [95000, 95000] },
      { designation: 'Office Administrator', staffType: 'admin', department: 'Office', subjects: [], salary: [38000, 44000] },
      { designation: 'Office Administrator', staffType: 'admin', department: 'Office', subjects: [], salary: [38000, 44000] },
      { designation: 'Accountant', staffType: 'non_teaching', department: 'Accounts', subjects: [], salary: [46000, 52000] },
      { designation: 'Librarian', staffType: 'non_teaching', department: 'Library', subjects: [], salary: [32000, 36000] },
    ]
    // Twenty-two teachers. The pool sizes follow how many sections each
    // subject is taught in, so nobody carries far more classes than anyone else.
    const teacherPlan: [string, string[]][] = [
      ['PRT English', ['ENG']], ['TGT English', ['ENG']], ['PGT English', ['ENG']],
      ['PRT Hindi', ['HIN', 'SAN']], ['TGT Hindi', ['HIN', 'SAN']], ['PGT Hindi', ['HIN', 'SAN']],
      ['TGT Sanskrit', ['SAN', 'HIN']],
      ['PRT Mathematics', ['MAT']], ['TGT Mathematics', ['MAT']], ['PGT Mathematics', ['MAT']],
      ['PGT Science', ['SCI']], ['TGT Social Science', ['SST']],
      ['PRT EVS', ['EVS']], ['PRT EVS', ['EVS']],
      ['TGT Computer Science', ['CS']], ['PGT Computer Science', ['CS']],
      ['Physical Education Teacher', ['PE']], ['Physical Education Teacher', ['PE']],
      ['Physical Education Teacher', ['PE']],
      ['Art Teacher', ['ART']], ['Art Teacher', ['ART']], ['Art Teacher', ['ART']],
    ]
    for (const [designation, codes] of teacherPlan) {
      staffPlan.push({
        designation,
        staffType: 'teaching',
        department: 'Teaching',
        subjects: codes,
        salary: [34000, 62000],
      })
    }
    // A twenty-third teacher, who left at the end of last session. The other
    // twenty-two still cover every class, so nobody is overloaded.
    staffPlan.push({
      designation: 'TGT Mathematics',
      staffType: 'teaching',
      department: 'Teaching',
      subjects: ['MAT'],
      salary: [34000, 62000],
      resigned: true,
    })
    staffPlan.push(
      { designation: 'Peon', staffType: 'support', department: 'Support', subjects: [], salary: [16000, 18000] },
      { designation: 'Driver', staffType: 'support', department: 'Support', subjects: [], salary: [19000, 22000] },
    )

    const usedStaffNames = new Set<string>()
    const staffList: StaffSeed[] = staffPlan.map((plan, index) => {
      const gender: 'male' | 'female' = random() < 0.5 ? 'male' : 'female'
      let firstName = pick(gender === 'male' ? MALE_NAMES : FEMALE_NAMES)
      let lastName = pick(SURNAMES)
      while (usedStaffNames.has(`${firstName} ${lastName}`)) {
        firstName = pick(gender === 'male' ? MALE_NAMES : FEMALE_NAMES)
        lastName = pick(SURNAMES)
      }
      usedStaffNames.add(`${firstName} ${lastName}`)
      const joiningYear = 2026 - Math.min(20, between(1, 18))
      return {
        id: randomUUID(),
        code: `${SHORT_NAME}-E${String(index + 1).padStart(3, '0')}`,
        firstName,
        lastName,
        staffType: plan.staffType,
        designation: plan.designation,
        status: plan.resigned ? 'resigned' : 'active',
        department: plan.department,
        subjects: plan.subjects,
        gender,
        phone: mobile(),
        email: `${firstName}.${lastName}`.toLowerCase() + EMAIL_DOMAIN,
        joiningDate: iso(joiningYear, between(4, 7), between(1, 28)),
        leavingDate: plan.resigned ? '2026-03-31' : null,
        salary: between(plan.salary[0], plan.salary[1]),
      }
    })
    // Joining order is what the employee codes count, so sort and renumber.
    staffList.sort((left, right) => left.joiningDate.localeCompare(right.joiningDate))
    staffList.forEach((member, index) => {
      member.code = `${SHORT_NAME}-E${String(index + 1).padStart(3, '0')}`
    })

    const teachers = staffList.filter((member) => member.staffType === 'teaching')
    // One teacher is away on leave; they keep their classes while they are off.
    const onLeave = teachers.find((member) => member.status === 'active') as StaffSeed
    onLeave.status = 'on_leave'
    const activeTeachers = teachers.filter((member) => member.status !== 'resigned')

    for (const member of staffList) {
      await client.query(
        `INSERT INTO staff (id, school_id, employee_code, first_name, last_name, staff_type,
                            designation, status, gender, date_of_birth, phone, email,
                            address, department, employment_type, joining_date, leaving_date,
                            qualification, experience_years, monthly_salary,
                            bank_account_last4, pan_last4)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15,
                 $16, $17, $18, $19, $20, $21, $22)`,
        [
          member.id, schoolId, member.code, member.firstName, member.lastName,
          member.staffType, member.designation, member.status, member.gender,
          iso(between(1972, 1996), between(1, 12), between(1, 28)),
          member.phone, member.email, jsonText(address()), member.department,
          member.staffType === 'support' ? 'contract' : 'permanent',
          member.joiningDate, member.leavingDate,
          member.staffType === 'teaching' ? pick(['B.Ed., M.A.', 'B.Ed., M.Sc.', 'B.Ed., B.Sc.', 'M.Ed.']) : pick(['B.Com.', 'B.A.', 'Diploma']),
          between(1, 20), member.salary,
          String(between(1000, 9999)), String(between(1000, 9999)),
        ],
      )
    }

    // -------------------------------------------- class teachers and subjects
    const classTeacherOf = new Map<string, StaffSeed>()
    sectionsNow.forEach((section, index) => {
      classTeacherOf.set(
        `${section.grade.sortOrder}-${section.name}`,
        activeTeachers[index % activeTeachers.length] as StaffSeed,
      )
    })
    for (const section of sections) {
      const teacher = classTeacherOf.get(`${section.grade.sortOrder}-${section.name}`)
      await client.query(
        `INSERT INTO sections (id, school_id, grade_id, academic_year_id, name,
                               class_teacher_staff_id, room_number, capacity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 40)`,
        [
          section.id, schoolId, section.grade.id, section.yearId, section.name,
          teacher?.id ?? null,
          `${section.grade.shortName}-${section.name}`,
        ],
      )
    }

    // ------------------------------------------------- teaching assignments
    // One teacher per subject per section, always the least loaded teacher who
    // can take that subject, so nobody ends up with far more classes.
    // Nobody should be in front of more than eight different classes.
    const SECTION_CAP = 8
    const load = new Map<string, Set<string>>()
    const teacherFor = new Map<string, StaffSeed>()
    for (const section of sectionsNow) {
      for (const subject of subjectsFor(section.grade)) {
        const able = activeTeachers.filter((member) => member.subjects.includes(subject.code))
        const room = (member: StaffSeed) => (load.get(member.id)?.size ?? 0) < SECTION_CAP
        const preferred = able.filter((member) => member.subjects[0] === subject.code)
        // The specialist first, then anyone else who teaches the subject, and
        // only past the cap when every one of them is already full.
        const pool =
          preferred.filter(room).length > 0
            ? preferred.filter(room)
            : able.filter(room).length > 0
              ? able.filter(room)
              : able
        const chosen = pool
          .slice()
          .sort(
            (left, right) =>
              (load.get(left.id)?.size ?? 0) - (load.get(right.id)?.size ?? 0),
          )[0] as StaffSeed
        const sectionsTaught = load.get(chosen.id) ?? new Set<string>()
        sectionsTaught.add(section.id)
        load.set(chosen.id, sectionsTaught)
        teacherFor.set(`${section.id}:${subject.id}`, chosen)
      }
    }
    teacherLoad = Math.max(...[...load.values()].map((set) => set.size))

    for (const section of sectionsNow) {
      for (const subject of subjectsFor(section.grade)) {
        const teacher = teacherFor.get(`${section.id}:${subject.id}`)
        if (!teacher) continue
        const past = findSection(yearPast.id, section.grade.sortOrder, section.name)
        for (const [year, target] of [[yearNow, section], [yearPast, past]] as const) {
          if (!target) continue
          await client.query(
            `INSERT INTO teaching_assignments (id, school_id, staff_id, academic_year_id,
                                               section_id, subject_id, effective_from)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [randomUUID(), schoolId, teacher.id, year.id, target.id, subject.id, year.start],
          )
        }
      }
    }

    // ------------------------------------------------------- bell schedules
    const periods = [
      { index: 0, name: 'Assembly', startTime: '07:45', endTime: '08:00', type: 'assembly' },
      { index: 1, name: 'Period 1', startTime: '08:00', endTime: '08:40', type: 'period' },
      { index: 2, name: 'Period 2', startTime: '08:40', endTime: '09:20', type: 'period' },
      { index: 3, name: 'Period 3', startTime: '09:20', endTime: '10:00', type: 'period' },
      { index: 4, name: 'Short break', startTime: '10:00', endTime: '10:20', type: 'break' },
      { index: 5, name: 'Period 4', startTime: '10:20', endTime: '11:00', type: 'period' },
      { index: 6, name: 'Period 5', startTime: '11:00', endTime: '11:40', type: 'period' },
      { index: 7, name: 'Lunch', startTime: '11:40', endTime: '12:15', type: 'lunch' },
      { index: 8, name: 'Period 6', startTime: '12:15', endTime: '12:55', type: 'period' },
      { index: 9, name: 'Period 7', startTime: '12:55', endTime: '13:35', type: 'period' },
      { index: 10, name: 'Period 8', startTime: '13:35', endTime: '14:15', type: 'period' },
    ]
    const teachingSlots = periods.filter((period) => period.type === 'period').map((p) => p.index)
    // Saturday stops at this period index. The timetable generator in the API
    // reads the count the same way (it skips any Saturday slot whose period
    // index is at or past the count), so the seed has to use the same rule or
    // a regenerated Saturday would not match the seeded one.
    const saturdayPeriodCount = 5
    const saturdaySlots = teachingSlots.filter((slot) => slot < saturdayPeriodCount)
    for (const year of [yearPast, yearNow]) {
      const bellId = randomUUID()
      await client.query(
        `INSERT INTO bell_schedules (id, school_id, academic_year_id, name, working_days,
                                     periods, saturday_period_count)
         VALUES ($1, $2, $3, 'Regular', ARRAY[1,2,3,4,5,6]::smallint[], $4::jsonb, $5)`,
        [bellId, schoolId, year.id, JSON.stringify(periods), saturdayPeriodCount],
      )
      // The schedule applies to the whole school, which is every grade linked.
      for (const grade of grades) {
        await client.query(
          'INSERT INTO bell_schedule_grades (school_id, bell_schedule_id, grade_id) VALUES ($1, $2, $3)',
          [schoolId, bellId, grade.id],
        )
      }
    }

    // ------------------------------------------------------------- timetable
    // Slot by slot across the whole school, so a teacher is only ever put in
    // front of one class at a time. A section with nothing placeable keeps a
    // free period rather than taking a teacher who is already busy.
    const remaining = new Map<string, number>()
    for (const section of sectionsNow) {
      for (const subject of subjectsFor(section.grade)) {
        remaining.set(`${section.id}:${subject.id}`, subject.periodsPerWeek)
      }
    }
    // Period by period with the days inside, so a subject's weekly quota lands
    // on different days instead of filling Monday first and leaving the end of
    // the week blank.
    for (const slot of teachingSlots) {
      for (let day = 1; day <= 6; day += 1) {
        if (day === 6 && !saturdaySlots.includes(slot)) continue
        const busy = new Set<string>()
        for (const section of sectionsNow) {
          const candidates = subjectsFor(section.grade)
            .map((subject) => ({
              subject,
              left: remaining.get(`${section.id}:${subject.id}`) ?? 0,
              teacher: teacherFor.get(`${section.id}:${subject.id}`),
            }))
            .filter((entry) => entry.left > 0 && entry.teacher && !busy.has(entry.teacher.id))
            .sort((left, right) => right.left - left.left)
          const chosen = candidates[0]
          if (!chosen || !chosen.teacher) continue
          busy.add(chosen.teacher.id)
          remaining.set(`${section.id}:${chosen.subject.id}`, chosen.left - 1)
          await client.query(
            `INSERT INTO timetable_entries (id, school_id, academic_year_id, section_id,
                                            day_of_week, period_index, subject_id, staff_id, room_number)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              randomUUID(), schoolId, yearNow.id, section.id, day, slot,
              chosen.subject.id, chosen.teacher.id,
              `${section.grade.shortName}-${section.name}`,
            ],
          )
        }
      }
    }

    // -------------------------------------------------------------- holidays
    const holidays: [string, string, string, string][] = [
      ['Independence Day', '2026-08-15', '2026-08-15', 'national'],
      ['Gandhi Jayanti', '2026-10-02', '2026-10-02', 'national'],
      ['Dussehra', '2026-10-20', '2026-10-20', 'festival'],
      ['Diwali break', '2026-11-07', '2026-11-14', 'vacation'],
      ['Christmas', '2026-12-25', '2026-12-25', 'festival'],
      ['Republic Day', '2027-01-26', '2027-01-26', 'national'],
    ]
    for (const [name, start, end, type] of holidays) {
      await client.query(
        `INSERT INTO holidays (id, school_id, academic_year_id, name, start_date, end_date, type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), schoolId, yearNow.id, name, start, end, type],
      )
    }

    // -------------------------------------------------------------- students
    const admissionCounters = new Map<string, number>()
    const nextAdmissionNumber = (yearName: string): string => {
      const next = (admissionCounters.get(yearName) ?? 0) + 1
      admissionCounters.set(yearName, next)
      return `${SHORT_NAME}/${yearName}/${String(next).padStart(3, '0')}`
    }

    const students: StudentSeed[] = []
    for (const section of sectionsNow) {
      const size = between(12, 18)
      for (let seat = 0; seat < size; seat += 1) {
        const gender: 'male' | 'female' = random() < 0.52 ? 'male' : 'female'
        const age = 2 + section.grade.sortOrder
        const born = 2026 - age
        // Pre-primary has no grade below it, so everyone there is new.
        const isNew = section.grade.sortOrder === 1 || random() < 0.2
        const joinedYears = isNew ? 0 : between(1, 3)
        const yearName =
          joinedYears === 0 ? '2026-27' : ['2025-26', '2024-25', '2023-24'][joinedYears - 1] as string
        const admissionYear = 2026 - joinedYears
        const detained = !isNew && random() < 0.03
        const priorSort = detained ? section.grade.sortOrder : section.grade.sortOrder - 1
        students.push({
          id: randomUUID(),
          firstName: pick(gender === 'male' ? MALE_NAMES : FEMALE_NAMES),
          lastName: pick(SURNAMES),
          gender,
          admissionNumber: nextAdmissionNumber(yearName),
          admissionDate: iso(admissionYear, between(4, 6), between(1, 28)),
          dateOfBirth: iso(born, between(1, 12), between(1, 28)),
          category: pick(CATEGORIES),
          status: 'active',
          bloodGroup: pick(BLOOD_GROUPS),
          medicalNotes: random() < 0.08 ? pick(MEDICAL_NOTES) : null,
          address: address(),
          leftOn: null,
          leftReason: null,
          section,
          rollNumber: seat + 1,
          priorSection: isNew ? null : findSection(yearPast.id, priorSort, section.name),
          priorOutcome: detained ? 'detained' : 'promoted',
        })
      }
    }

    // Eight children whose family moved away during this session.
    for (let index = 0; index < 8; index += 1) {
      const student = students[index * 27 % students.length] as StudentSeed
      if (student.status !== 'active') continue
      student.status = 'left'
      student.leftOn = iso(2026, between(7, 11), between(1, 28))
      student.leftReason = pick([
        'Family relocated to Pune',
        'Transferred to a school nearer home',
        'Father posted out of the city',
      ])
    }

    // Five students who finished Class 10 last session and have moved on.
    const class10Past = findSection(yearPast.id, 13, 'A') as SectionSeed
    for (let index = 0; index < 5; index += 1) {
      const gender: 'male' | 'female' = index % 2 === 0 ? 'male' : 'female'
      students.push({
        id: randomUUID(),
        firstName: pick(gender === 'male' ? MALE_NAMES : FEMALE_NAMES),
        lastName: pick(SURNAMES),
        gender,
        admissionNumber: nextAdmissionNumber('2022-23'),
        admissionDate: iso(2022, 4, between(1, 28)),
        dateOfBirth: iso(2010, between(1, 12), between(1, 28)),
        category: pick(CATEGORIES),
        status: 'alumni',
        bloodGroup: pick(BLOOD_GROUPS),
        medicalNotes: null,
        address: address(),
        leftOn: '2026-03-31',
        leftReason: 'Completed Class 10',
        section: null,
        rollNumber: null,
        priorSection: class10Past,
        priorOutcome: 'promoted',
      })
    }

    for (const student of students) {
      await client.query(
        `INSERT INTO students (id, school_id, admission_number, first_name, last_name, status,
                               date_of_birth, gender, blood_group, category, nationality,
                               address, admission_date, admission_type, medical_notes,
                               left_on, left_reason, uses_transport)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Indian', $11::jsonb, $12, $13, $14,
                 $15, $16, $17)`,
        [
          student.id, schoolId, student.admissionNumber, student.firstName, student.lastName,
          student.status, student.dateOfBirth, student.gender, student.bloodGroup,
          student.category, jsonText(student.address), student.admissionDate,
          student.priorSection === null ? 'new' : 'continuing', student.medicalNotes,
          student.leftOn, student.leftReason, random() < 0.3,
        ],
      )
      if (student.priorSection) {
        await client.query(
          `INSERT INTO enrollments (id, school_id, student_id, academic_year_id, section_id,
                                    roll_number, joined_on, left_on, outcome)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            randomUUID(), schoolId, student.id, yearPast.id, student.priorSection.id,
            student.rollNumber ?? between(1, 18), yearPast.start, yearPast.end,
            student.priorOutcome,
          ],
        )
      }
      if (student.section) {
        await client.query(
          `INSERT INTO enrollments (id, school_id, student_id, academic_year_id, section_id,
                                    roll_number, joined_on, left_on, outcome)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            randomUUID(), schoolId, student.id, yearNow.id, student.section.id,
            student.rollNumber,
            student.admissionDate > yearNow.start ? student.admissionDate : yearNow.start,
            student.leftOn, student.status === 'left' ? 'left' : 'ongoing',
          ],
        )
      }
    }

    // ------------------------------------------------------------- guardians
    interface GuardianSeed {
      id: string
      firstName: string
      lastName: string
      relation: 'father' | 'mother' | 'guardian'
      phone: string
    }
    const guardiansOf = new Map<string, GuardianSeed[]>()
    const addGuardian = async (
      lastName: string,
      relation: GuardianSeed['relation'],
    ): Promise<GuardianSeed> => {
      const firstName =
        relation === 'mother' ? pick(FEMALE_NAMES) : pick(MALE_NAMES)
      const guardian: GuardianSeed = {
        id: randomUUID(),
        firstName,
        lastName,
        relation,
        phone: mobile(),
      }
      await client.query(
        `INSERT INTO guardians (school_id, id, first_name, last_name, phone, email,
                                occupation, annual_income, address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          schoolId, guardian.id, firstName, lastName, guardian.phone,
          random() < 0.5 ? `${firstName}.${lastName}`.toLowerCase() + EMAIL_DOMAIN : null,
          pick(OCCUPATIONS), between(3, 24) * 100000, jsonText(address()),
        ],
      )
      return guardian
    }
    const linkGuardians = async (
      student: StudentSeed,
      family: GuardianSeed[],
    ): Promise<void> => {
      guardiansOf.set(student.id, family)
      for (const [index, guardian] of family.entries()) {
        await client.query(
          `INSERT INTO student_guardians (school_id, student_id, guardian_id, relation, is_primary)
           VALUES ($1, $2, $3, $4, $5)`,
          [schoolId, student.id, guardian.id, guardian.relation, index === 0],
        )
      }
    }

    const siblingPool = students.filter((student) => student.status === 'active')
    const siblingPairs = new Set<string>()
    const siblingFamilies: [StudentSeed, StudentSeed][] = []
    for (let index = 0; index < 15; index += 1) {
      const first = siblingPool[index * 13 % siblingPool.length] as StudentSeed
      const second = siblingPool[(index * 13 + 7) % siblingPool.length] as StudentSeed
      if (first.id === second.id) continue
      if (siblingPairs.has(first.id) || siblingPairs.has(second.id)) continue
      // The students are already written, so the shared surname is an update.
      second.lastName = first.lastName
      await client.query('UPDATE students SET last_name = $3 WHERE school_id = $1 AND id = $2', [
        schoolId, second.id, first.lastName,
      ])
      siblingPairs.add(first.id)
      siblingPairs.add(second.id)
      const family = [
        await addGuardian(first.lastName, 'father'),
        await addGuardian(first.lastName, 'mother'),
      ]
      await linkGuardians(first, family)
      await linkGuardians(second, family)
      siblingFamilies.push([first, second])
    }
    for (const student of students) {
      if (guardiansOf.has(student.id)) continue
      const family =
        random() < 0.12
          ? [await addGuardian(student.lastName, random() < 0.5 ? 'father' : 'mother')]
          : [
              await addGuardian(student.lastName, 'father'),
              await addGuardian(student.lastName, 'mother'),
            ]
      await linkGuardians(student, family)
    }

    // ------------------------------------------------------ number sequences
    for (const year of [yearPast, yearNow]) {
      await client.query(
        `INSERT INTO number_sequences (school_id, kind, period, next_value)
         VALUES ($1, 'admission', $2, $3)`,
        [schoolId, year.id, (admissionCounters.get(year.name) ?? 0) + 1],
      )
    }
    await client.query(
      `INSERT INTO number_sequences (school_id, kind, period, next_value)
       VALUES ($1, 'employee', '', $2)`,
      [schoolId, staffList.length + 1],
    )

    // ---------------------------------------------------------------- logins
    const createUser = async (
      name: string,
      email: string,
      phone: string | null,
      kind: 'adult' | 'student',
      status: 'active' | 'suspended',
      roles: string[],
    ): Promise<{ userId: string; membershipId: string }> => {
      const userId = randomUUID()
      const membershipId = randomUUID()
      await client.query(
        `INSERT INTO auth_user (id, name, email, email_verified, phone_number, phone_number_verified)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, name, email, phone === null, phone, phone !== null],
      )
      await client.query(
        'INSERT INTO school_memberships (id, school_id, user_id, kind, status) VALUES ($1, $2, $3, $4, $5)',
        [membershipId, schoolId, userId, kind, status],
      )
      for (const role of roles) {
        await client.query(
          'INSERT INTO membership_roles (school_id, membership_id, role_id) VALUES ($1, $2, $3)',
          [schoolId, membershipId, roleIds.get(role)],
        )
      }
      return { userId, membershipId }
    }
    const linkStaff = async (membershipId: string, staffId: string): Promise<void> => {
      await client.query(
        'INSERT INTO membership_staff_links (school_id, membership_id, staff_id) VALUES ($1, $2, $3)',
        [schoolId, membershipId, staffId],
      )
    }

    const principalStaff = staffList.find((member) => member.designation === 'Principal') as StaffSeed
    const officeStaff = staffList.filter((member) => member.designation === 'Office Administrator')
    const accountantStaff = staffList.find((member) => member.designation === 'Accountant') as StaffSeed

    const trustee = await createUser('Rajesh Khandelwal', 'rajesh.trustee' + EMAIL_DOMAIN, null, 'adult', 'active', ['owner'])
    logins.push({
      ...trustee, name: 'Rajesh Khandelwal', roles: ['owner'],
      email: 'rajesh.trustee' + EMAIL_DOMAIN, phone: null, emailPassword: true, mfa: true,
      linkedTo: 'trustee, no staff record',
      expect: 'full access to every screen once the second factor is entered',
    })
    const secretary = await createUser('Sunita Kelkar', 'sunita.secretary' + EMAIL_DOMAIN, null, 'adult', 'active', ['owner'])
    logins.push({
      ...secretary, name: 'Sunita Kelkar', roles: ['owner'],
      email: 'sunita.secretary' + EMAIL_DOMAIN, phone: null, emailPassword: true, mfa: true,
      linkedTo: 'society secretary, no staff record',
      expect: 'second owner, for ownership transfer and delegation checks',
    })
    const principalName = `${principalStaff.firstName} ${principalStaff.lastName}`
    const principal = await createUser(principalName, 'principal' + EMAIL_DOMAIN, null, 'adult', 'active', ['principal'])
    await linkStaff(principal.membershipId, principalStaff.id)
    logins.push({
      ...principal, name: principalName, roles: ['principal'],
      email: 'principal' + EMAIL_DOMAIN, phone: null, emailPassword: true, mfa: true,
      linkedTo: `staff ${principalStaff.code}`,
      expect: 'runs the school: students, staff, timetable and access management',
    })
    const adminLogins = []
    for (const [index, member] of officeStaff.entries()) {
      const name = `${member.firstName} ${member.lastName}`
      const email = `office${index + 1}${EMAIL_DOMAIN}`
      const created = await createUser(name, email, null, 'adult', 'active', ['admin'])
      await linkStaff(created.membershipId, member.id)
      adminLogins.push(created)
      logins.push({
        ...created, name, roles: ['admin'], email, phone: null, emailPassword: true, mfa: true,
        linkedTo: `staff ${member.code}`,
        expect: 'office desk: admissions, records and the daily timetable',
      })
    }
    const accountantName = `${accountantStaff.firstName} ${accountantStaff.lastName}`
    const accountant = await createUser(accountantName, 'accounts' + EMAIL_DOMAIN, null, 'adult', 'active', ['accountant'])
    await linkStaff(accountant.membershipId, accountantStaff.id)
    logins.push({
      ...accountant, name: accountantName, roles: ['accountant'],
      email: 'accounts' + EMAIL_DOMAIN, phone: null, emailPassword: true, mfa: true,
      linkedTo: `staff ${accountantStaff.code}`,
      expect: 'fees and staff pay; no access to student medical records',
    })

    const teacherLogins: StaffSeed[] = activeTeachers.slice(0, 5)
    const ownerMembershipId = trustee.membershipId
    const approveAccess = async (
      guardianId: string,
      studentId: string,
      areas: string[],
    ): Promise<void> => {
      await client.query(
        `INSERT INTO guardian_student_access (school_id, guardian_id, student_id, status, areas,
                                              approved_by_membership_id, approved_at)
         VALUES ($1, $2, $3, 'approved', $4::text[], $5, now())`,
        [schoolId, guardianId, studentId, areas, ownerMembershipId],
      )
    }

    // The teacher who is also a parent gets a child of their own in the school.
    const teacherParentChild = students.find(
      (student) =>
        student.status === 'active' &&
        !siblingPairs.has(student.id) &&
        (guardiansOf.get(student.id)?.length ?? 0) === 2,
    ) as StudentSeed
    for (const [index, member] of teacherLogins.entries()) {
      const name = `${member.firstName} ${member.lastName}`
      const email = `teacher${index + 1}${EMAIL_DOMAIN}`
      const alsoParent = index === 0
      const suspended = index === 4
      const withPhone = index === 1
      const created = await createUser(
        name,
        email,
        withPhone ? mobile() : null,
        'adult',
        suspended ? 'suspended' : 'active',
        alsoParent ? ['teacher', 'parent'] : ['teacher'],
      )
      await linkStaff(created.membershipId, member.id)
      let linkedTo = `staff ${member.code}`
      if (alsoParent) {
        // The child's first guardian is this teacher: one person, one record.
        const guardian = (guardiansOf.get(teacherParentChild.id) as GuardianSeed[])[0] as GuardianSeed
        guardian.firstName = member.firstName
        guardian.lastName = member.lastName
        guardian.relation = member.gender === 'female' ? 'mother' : 'father'
        teacherParentChild.lastName = member.lastName
        await client.query(
          `UPDATE guardians SET first_name = $3, last_name = $4, phone = $5, email = $6
            WHERE school_id = $1 AND id = $2`,
          [schoolId, guardian.id, member.firstName, member.lastName, member.phone, member.email],
        )
        await client.query(
          `UPDATE student_guardians SET relation = $4
            WHERE school_id = $1 AND student_id = $2 AND guardian_id = $3`,
          [schoolId, teacherParentChild.id, guardian.id, guardian.relation],
        )
        await client.query('UPDATE students SET last_name = $3 WHERE school_id = $1 AND id = $2', [
          schoolId, teacherParentChild.id, member.lastName,
        ])
        await client.query(
          `INSERT INTO membership_guardian_links (school_id, membership_id, guardian_id, verified_at)
           VALUES ($1, $2, $3, now())`,
          [schoolId, created.membershipId, guardian.id],
        )
        await approveAccess(guardian.id, teacherParentChild.id, ['basic'])
        linkedTo = `staff ${member.code}; parent of ${teacherParentChild.firstName} ${teacherParentChild.lastName}`
      }
      // The identity carries a phone, so re-open the row and mark it verified.
      logins.push({
        ...created,
        name,
        roles: alsoParent ? ['teacher', 'parent'] : ['teacher'],
        email,
        phone: null,
        emailPassword: true,
        mfa: false,
        linkedTo,
        expect: suspended
          ? 'signs in, then the school context answers SCHOOL_ACCESS_UNAVAILABLE'
          : alsoParent
            ? 'sees their own classes as a teacher and their child as a parent'
            : withPhone
              ? 'email and password, or a one-time code on the phone'
              : 'their own classes, their own students',
      })
      if (withPhone) {
        const row = await client.query<{ phone_number: string }>(
          'SELECT phone_number FROM auth_user WHERE id = $1',
          [created.userId],
        )
        const found = logins[logins.length - 1]
        if (found) found.phone = row.rows[0]?.phone_number ?? null
      }
    }

    // Parents sign in with a one-time code on the phone, never a password.
    const parentCandidates = students.filter(
      (student) =>
        student.status === 'active' &&
        student.id !== teacherParentChild.id &&
        (guardiansOf.get(student.id)?.length ?? 0) > 0,
    )
    const leftStudent = students.find((student) => student.status === 'left') as StudentSeed
    const parentPlans: {
      children: StudentSeed[]
      access: 'approved' | 'none'
      expect: string
    }[] = [
      {
        // A real brother and sister, so the two children share one family.
        children: (siblingFamilies.find(
          ([first, second]) => first.section?.id !== second.section?.id,
        ) ?? siblingFamilies[0]) as unknown as StudentSeed[],
        access: 'approved',
        expect: 'two children in different classes; the switcher shows both',
      },
      {
        children: [leftStudent],
        access: 'approved',
        expect: 'the child has left the school, so only the closed record remains',
      },
      {
        children: [parentCandidates[9] as StudentSeed],
        access: 'none',
        expect: 'access is not approved yet: the child is not readable',
      },
      {
        children: [parentCandidates[18] as StudentSeed],
        access: 'approved',
        expect: 'one child, basic details only',
      },
      {
        children: [parentCandidates[27] as StudentSeed],
        access: 'approved',
        expect: 'one child, basic details only',
      },
    ]
    for (const [index, plan] of parentPlans.entries()) {
      const first = plan.children[0] as StudentSeed
      const guardian = (guardiansOf.get(first.id) as GuardianSeed[])[0] as GuardianSeed
      const name = `${guardian.firstName} ${guardian.lastName}`
      const created = await createUser(
        name,
        `parent${index + 1}${EMAIL_DOMAIN}`,
        guardian.phone,
        'adult',
        'active',
        ['parent'],
      )
      await client.query(
        `INSERT INTO membership_guardian_links (school_id, membership_id, guardian_id, verified_at)
         VALUES ($1, $2, $3, now())`,
        [schoolId, created.membershipId, guardian.id],
      )
      for (const child of plan.children) {
        // Every child in this family answers to the same guardian record.
        await client.query(
          `INSERT INTO student_guardians (school_id, student_id, guardian_id, relation, is_primary)
           VALUES ($1, $2, $3, $4, false) ON CONFLICT DO NOTHING`,
          [schoolId, child.id, guardian.id, guardian.relation],
        )
        if (plan.access === 'approved') await approveAccess(guardian.id, child.id, ['basic'])
      }
      logins.push({
        ...created,
        name,
        roles: ['parent'],
        email: `parent${index + 1}${EMAIL_DOMAIN}`,
        phone: guardian.phone,
        emailPassword: false,
        mfa: false,
        linkedTo: plan.children
          .map((child) => `${child.firstName} ${child.lastName} (${child.admissionNumber})`)
          .join(', '),
        expect: plan.expect,
      })
    }

    // Student sign-in is switched off everywhere; this account proves it.
    const studentRecord = parentCandidates[3] as StudentSeed
    const studentLogin = await createUser(
      `${studentRecord.firstName} ${studentRecord.lastName}`,
      'student1' + EMAIL_DOMAIN,
      null,
      'student',
      'suspended',
      ['student'],
    )
    await client.query(
      'INSERT INTO membership_student_links (school_id, membership_id, student_id) VALUES ($1, $2, $3)',
      [schoolId, studentLogin.membershipId, studentRecord.id],
    )
    logins.push({
      ...studentLogin,
      name: `${studentRecord.firstName} ${studentRecord.lastName}`,
      roles: ['student'],
      email: 'student1' + EMAIL_DOMAIN,
      phone: null,
      emailPassword: false,
      mfa: false,
      linkedTo: `student ${studentRecord.admissionNumber}`,
      expect: 'student sign-in is disabled: every attempt is refused',
    })

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  // ----------------------------------------------- passwords and second factor
  const port = await freePort()
  const serverConfig = loadConfig({
    ...process.env,
    APP_ORIGIN: `http://127.0.0.1:${port}`,
    PORT: String(port),
  })
  const pools = await createPools(serverConfig)
  const auth = createAuth(serverConfig, pools.auth, createSandboxDelivery(() => {}), pools.identity)
  const app = buildApp({
    config: serverConfig,
    auth,
    delivery: createSandboxDelivery(() => {}),
    pools,
    documents: createMemoryDocumentStorage(),
  })
  await app.listen({ port, host: '127.0.0.1' })
  const origin = `http://127.0.0.1:${port}`
  const secrets = new Map<string, { secret: string; uri: string }>()

  try {
    for (const login of logins) {
      if (login.emailPassword) await setPassword(auth, login.userId, PASSWORD)
      if (!login.mfa) continue
      await clearOwnAuthCounters(migrator, logins)
      // One cookie jar per account: a later Set-Cookie replaces the earlier
      // value for the same name, as a browser would.
      const cookies = new Map<string, string>()
      const headers = () => ({
        'content-type': 'application/json',
        origin,
        ...(cookies.size > 0
          ? {
              cookie: [...cookies]
                .map(([name, value]) => `${name}=${value}`)
                .join('; '),
            }
          : {}),
      })
      const keep = (response: Response) => {
        for (const line of response.headers.getSetCookie()) {
          const pair = line.split(';')[0] ?? ''
          const split = pair.indexOf('=')
          if (split > 0) cookies.set(pair.slice(0, split), pair.slice(split + 1))
        }
      }
      const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ email: login.email, password: PASSWORD }),
      })
      if (signIn.status !== 200)
        throw new Error(`${login.email}: sign-in failed with status ${signIn.status}`)
      keep(signIn)
      const enable = await fetch(`${origin}/api/auth/two-factor/enable`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ password: PASSWORD }),
      })
      if (enable.status !== 200)
        throw new Error(`${login.email}: enrolment failed with status ${enable.status}`)
      keep(enable)
      const body = (await enable.json()) as { totpURI: string }
      const secret = new URL(body.totpURI).searchParams.get('secret')
      if (!secret) throw new Error(`${login.email}: the enrolment carried no secret`)
      const generated = await auth.api.generateTOTP({ body: { secret: decodeBase32(secret) } })
      const verify = await fetch(`${origin}/api/auth/two-factor/verify-totp`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ code: generated.code }),
      })
      if (verify.status !== 200) {
        throw new Error(`${login.email}: verification failed with status ${verify.status}`)
      }
      secrets.set(login.userId, { secret, uri: body.totpURI })
    }
    // Enrolment needed a session; nobody should still be signed in afterwards.
    await migrator.query(
      'DELETE FROM auth_session WHERE user_id = ANY($1::uuid[])',
      [logins.map((login) => login.userId)],
    )
    await clearOwnAuthCounters(migrator, logins)
  } finally {
    await app.close()
    await pools.close()
  }

  // ------------------------------------------------------------------ output
  const rows: CsvRow[] = logins.map((login) => {
    const totp = secrets.get(login.userId)
    const method = login.emailPassword
      ? login.mfa
        ? 'email + password + TOTP'
        : login.phone
          ? 'email + password, or phone code'
          : 'email + password'
      : login.phone
        ? 'phone one-time code'
        : 'sign-in disabled'
    return {
      name: login.name,
      roles: login.roles.join(' + '),
      school: LOGIN_CODE,
      method,
      email: login.email,
      phone: login.phone ?? '',
      password: login.emailPassword ? PASSWORD : '',
      totpSecret: totp?.secret ?? '',
      otpauthUri: totp?.uri ?? '',
      linkedTo: login.linkedTo,
      expect: login.expect,
    }
  })

  const header = [
    'name', 'roles', 'school login code', 'sign-in method', 'email', 'phone',
    'password', 'totp_secret', 'otpauth_uri', 'staff or children', 'what to expect',
  ]
  const escape = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
  const csv = [
    header.join(','),
    ...rows.map((row) =>
      [
        row.name, row.roles, row.school, row.method, row.email, row.phone,
        row.password, row.totpSecret, row.otpauthUri, row.linkedTo, row.expect,
      ]
        .map(escape)
        .join(','),
    ),
  ].join('\n')

  const outputDir = path.resolve(import.meta.dirname, '..', '.dev')
  const csvPath = path.join(outputDir, process.env.SEED_LOGINS_FILE ?? 'sunrise-logins.csv')
  // The file holds working passwords, so neither it nor its directory is
  // readable by anyone but the owner of this machine account.
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  await writeFile(csvPath, `${csv}\n`, { encoding: 'utf8', mode: 0o600 })
  // A directory or file left over from an earlier run keeps its old mode,
  // so narrow both every time.
  await chmod(outputDir, 0o700)
  await chmod(csvPath, 0o600)

  const counts = await migrator.query<{ label: string; total: string }>(
    `SELECT 'students' AS label, count(*)::text AS total FROM students WHERE school_id = $1
     UNION ALL SELECT 'staff', count(*)::text FROM staff WHERE school_id = $1
     UNION ALL SELECT 'guardians', count(*)::text FROM guardians WHERE school_id = $1
     UNION ALL SELECT 'enrollments', count(*)::text FROM enrollments WHERE school_id = $1
     UNION ALL SELECT 'timetable entries', count(*)::text FROM timetable_entries WHERE school_id = $1
     UNION ALL SELECT 'teaching assignments', count(*)::text FROM teaching_assignments WHERE school_id = $1`,
    [schoolId],
  )
  await migrator.end()

  const columns: (keyof CsvRow)[] = ['name', 'roles', 'method', 'email', 'phone', 'totpSecret', 'linkedTo', 'expect']
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => row[column].length)),
  )
  const line = (values: string[]) =>
    values.map((value, index) => value.padEnd(widths[index] ?? 0)).join('  ')

  console.info(`Sunrise Public School is ready. School id: ${schoolId}`)
  console.info(`Login code: ${LOGIN_CODE}\n`)
  console.info(line(columns))
  console.info(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of rows) console.info(line(columns.map((column) => row[column])))
  console.info(
    `\n${counts.rows.map((row) => `${row.total} ${row.label}`).join(', ')}` +
      `\nBusiest teacher: ${teacherLoad} sections.` +
      `\nPassword for every email login: ${PASSWORD}` +
      `\nCurrent second-factor code: pnpm --filter @erp/api dev:totp <totp_secret>` +
      '\nOne-time codes for the parent phone logins: GET /api/dev/outbox' +
      `\nAccounts also written to ${csvPath}` +
      '\nThe Fixture A and Fixture B schools are untouched.',
  )
}

await main()
