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
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import {
  CONSENT_PURPOSES,
  EXAM_PATTERN,
  MESSAGE_BODY_MAX,
  MESSAGE_TITLE_MAX,
  renderMessageText,
  ROLE_TEMPLATES,
  type AutomaticMessageKind,
  type ExamKind,
  type MessagePlaceholder,
} from '@erp/contracts'
import { loadConfig } from '../src/config.ts'
import { createPools } from '../src/db.ts'
import { createSandboxDelivery } from '../src/delivery/index.ts'
import { createAuth, type AuthInstance } from '../src/auth/better-auth.ts'
import {
  generateStudentPassword,
  STUDENT_EMAIL_SUFFIX,
  studentPlaceholderEmail,
} from '../src/auth/student-sign-in.ts'
import { buildApp } from '../src/app.ts'
import { createLocalDocumentStorage, createMemoryDocumentStorage } from '../src/files/storage.ts'
import { crc32, deflateSync } from 'node:zlib'
import { drizzle } from 'drizzle-orm/node-postgres'
import { syncPapers } from '../src/modules/exams/setup.ts'
import { buildReportCard } from '../src/modules/report-cards/build.ts'
import { formatMessageDate, formatRupees } from '../src/modules/communication/automatic.ts'
import { loadAutomaticWording, type DispatchDependencies } from '../src/modules/communication/common.ts'
import { materialiseMessage } from '../src/modules/communication/materialise.ts'
import { decodeBase32 } from './totp-secret.ts'

/** Documented in docs/auth/WEB_SESSION.md. Development accounts only. */
/** The development password is public. A hosted build must choose its own. */
const PASSWORD = process.env.SEED_PASSWORD ?? 'sunrise-password-1'
const LOGIN_CODE = 'sunrise'
const EMAIL_DOMAIN = '@sunrise.test'
const SHORT_NAME = 'SPS'
/** The known password of the three named pupils. Development only. */
const PUPIL_PASSWORD = process.env.SEED_PUPIL_PASSWORD ?? 'sunrise-pupil-1'

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
  /** A pupil's own login: they sign in with the admission number instead of an email. */
  pupil?: { admissionNumber: string; password: string }
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
  // The fee ledger refuses every delete. Only this seed, as the table owner on
  // a developer machine, may switch that off to rebuild its own school.
  await client.query('ALTER TABLE fee_receipts DISABLE TRIGGER fee_receipts_no_change')
  await client.query('ALTER TABLE fee_receipt_lines DISABLE TRIGGER fee_receipt_lines_no_change')
  // Attendance is append-only the same way.
  await client.query('ALTER TABLE attendance_entries DISABLE TRIGGER attendance_entries_no_change')
  await client.query('ALTER TABLE staff_attendance_entries DISABLE TRIGGER staff_attendance_entries_no_change')
  // Exam marks, publications and published cards are append-only too.
  await client.query('ALTER TABLE exam_marks DISABLE TRIGGER exam_marks_no_change')
  await client.query('ALTER TABLE exam_publications DISABLE TRIGGER exam_publications_no_change')
  await client.query('ALTER TABLE report_card_versions DISABLE TRIGGER report_card_versions_no_change')
  // Consent history is append-only in the same way, and it points at the
  // memberships and pupils removed below.
  await client.query('ALTER TABLE guardian_consents DISABLE TRIGGER guardian_consents_no_update')
  // A message that went out is kept; only a draft may be deleted.
  await client.query('ALTER TABLE messages DISABLE TRIGGER messages_guard_delete')
  const tables = [
    'message_recipients', 'message_attachments', 'messages', 'message_templates', 'communication_settings',
    'guardian_consents', 'audit_event_notes',
    'attendance_entries', 'staff_attendance_entries',
    'report_card_versions', 'report_card_entries', 'exam_publications', 'exam_marks', 'exam_papers', 'exams',
    'exam_settings',
    'fee_receipt_lines', 'fee_receipts', 'fee_concessions', 'fee_student_heads',
    'fee_structures', 'fee_heads',
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
  await client.query('ALTER TABLE fee_receipts ENABLE TRIGGER fee_receipts_no_change')
  await client.query('ALTER TABLE fee_receipt_lines ENABLE TRIGGER fee_receipt_lines_no_change')
  await client.query('ALTER TABLE attendance_entries ENABLE TRIGGER attendance_entries_no_change')
  await client.query('ALTER TABLE staff_attendance_entries ENABLE TRIGGER staff_attendance_entries_no_change')
  await client.query('ALTER TABLE exam_marks ENABLE TRIGGER exam_marks_no_change')
  await client.query('ALTER TABLE exam_publications ENABLE TRIGGER exam_publications_no_change')
  await client.query('ALTER TABLE report_card_versions ENABLE TRIGGER report_card_versions_no_change')
  await client.query('ALTER TABLE guardian_consents ENABLE TRIGGER guardian_consents_no_update')
  await client.query('ALTER TABLE messages ENABLE TRIGGER messages_guard_delete')
  await client.query('DELETE FROM schools WHERE id = $1', [schoolId])

  // Identities are shared across schools, so only the ones with no membership
  // left anywhere and an address or number this script hands out are removed.
  const ids = users.rows.map((row) => row.user_id)
  if (ids.length > 0) {
    await client.query('DELETE FROM auth_session WHERE user_id = ANY($1::uuid[])', [ids])
    await client.query(
      `DELETE FROM auth_user
        WHERE id = ANY($1::uuid[])
          AND (email LIKE $2 OR email LIKE $3 OR phone_number LIKE '+9198%')
          AND NOT EXISTS (
            SELECT 1 FROM school_memberships WHERE user_id = auth_user.id)`,
      [ids, `%${EMAIL_DOMAIN}`, `%${STUDENT_EMAIL_SUFFIX}`],
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
  // Pupil passwords are hashed once the transaction has committed; the
  // generated ones are never printed or written anywhere.
  const pupilPasswords: { userId: string; password: string }[] = []
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
        `INSERT INTO grades (id, school_id, name, short_name, sort_order, level)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        // Class 1 to Class 10 carry their number, so Class 9 and 10 are the
        // senior classes whose pupils get their own logins.
        [grade.id, schoolId, grade.name, grade.shortName, grade.sortOrder,
          grade.sortOrder > 3 ? grade.sortOrder - 3 : null],
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
    // Which membership marks a class register in the attendance seed below.
    const teacherMembershipOf = new Map<string, string>()
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
      teacherMembershipOf.set(member.id, created.membershipId)
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

    // ----------------------------------------------------------- pupil logins
    // Every pupil enrolled this year in Class 9 and Class 10 has their own
    // login, written the way the product writes one: a generated
    // @student.invalid identity, a credential hashed after the commit below,
    // must_change_password set, and a 'student' membership linked to the
    // pupil. Three named pupils have a known password they have already
    // changed, a fourth has their login switched off, and one Class 9 pupil
    // has none because their primary guardian has no phone.
    const leavingThisMonth = students.filter((student) => student.status === 'active')[50]
    const seniorPupils = students.filter(
      (student) =>
        student.status === 'active' &&
        student.section !== null &&
        student.section.grade.sortOrder >= 12 &&
        student !== leavingThisMonth,
    )
    const pupilIn = (sort: number, name: string, skip: readonly StudentSeed[] = []): StudentSeed =>
      seniorPupils.find(
        (student) =>
          student.section?.grade.sortOrder === sort && student.section.name === name && !skip.includes(student),
      ) ?? (seniorPupils.find((student) => !skip.includes(student)) as StudentSeed)
    const namedPupils = [pupilIn(12, 'A'), pupilIn(13, 'A')]
    namedPupils.push(pupilIn(12, 'B', namedPupils))
    const switchedOffPupil = pupilIn(13, 'A', namedPupils)
    // Not a pupil whose guardian signs in by phone: that login would break.
    const loginPhones = new Set(logins.map((login) => login.phone))
    const noLoginPupil =
      seniorPupils.find(
        (student) =>
          student.section?.grade.sortOrder === 12 &&
          !namedPupils.includes(student) &&
          student !== switchedOffPupil &&
          !loginPhones.has(guardiansOf.get(student.id)?.[0]?.phone ?? null),
      ) ?? pupilIn(12, 'A', [...namedPupils, switchedOffPupil])
    let pupilLogins = 0
    for (const pupil of seniorPupils) {
      if (pupil === noLoginPupil) continue
      const named = namedPupils.includes(pupil)
      const known = named || pupil === switchedOffPupil
      const name = `${pupil.firstName} ${pupil.lastName}`
      const userId = randomUUID()
      const membershipId = randomUUID()
      await client.query(
        `INSERT INTO auth_user (id, name, email, email_verified, must_change_password)
         VALUES ($1, $2, $3, false, $4)`,
        [userId, name, studentPlaceholderEmail(), !known],
      )
      await client.query(
        `INSERT INTO school_memberships (id, school_id, user_id, kind, status)
         VALUES ($1, $2, $3, 'student', $4)`,
        [membershipId, schoolId, userId, pupil === switchedOffPupil ? 'suspended' : 'active'],
      )
      await client.query(
        'INSERT INTO membership_roles (school_id, membership_id, role_id) VALUES ($1, $2, $3)',
        [schoolId, membershipId, roleIds.get('student')],
      )
      await client.query(
        'INSERT INTO membership_student_links (school_id, membership_id, student_id) VALUES ($1, $2, $3)',
        [schoolId, membershipId, pupil.id],
      )
      const password = known ? PUPIL_PASSWORD : generateStudentPassword()
      pupilPasswords.push({ userId, password })
      pupilLogins += 1
      if (!known) continue
      const section = pupil.section as SectionSeed
      logins.push({
        userId,
        membershipId,
        name,
        roles: ['student'],
        email: pupil.admissionNumber,
        phone: null,
        emailPassword: false,
        mfa: false,
        linkedTo: `pupil ${pupil.admissionNumber}, ${section.grade.name} ${section.name}`,
        expect: named
          ? 'own dashboard, timetable, attendance, results and messages; no second factor'
          : 'login switched off by the office: every attempt is refused',
        pupil: { admissionNumber: pupil.admissionNumber, password },
      })
    }
    // The pupil without a login: no phone for the primary guardian, so the
    // office sees the "no guardian phone" blocker instead of a Create button.
    const noLoginGuardian = guardiansOf.get(noLoginPupil.id)?.[0]
    if (noLoginGuardian) {
      await client.query('UPDATE guardians SET phone = NULL WHERE school_id = $1 AND id = $2', [
        schoolId, noLoginGuardian.id,
      ])
    }
    console.info(
      `Pupil logins: ${pupilLogins} in Class 9 and Class 10 (one switched off); ` +
        `${noLoginPupil.firstName} ${noLoginPupil.lastName} (${noLoginPupil.admissionNumber}) has none.`,
    )

    // ------------------------------------------------- dashboard sample data
    // Every dashboard card needs something to show on the day the seed is run,
    // so the rows below are placed relative to that date rather than a fixed
    // one. Everything else in this seed stays deterministic.
    const runDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
    const shiftDays = (date: string, days: number): string => {
      const moved = new Date(`${date}T00:00:00Z`)
      moved.setUTCDate(moved.getUTCDate() + days)
      return moved.toISOString().slice(0, 10)
    }
    const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay()
    const onHoliday = (date: string): boolean =>
      holidays.some(([, start, end]) => start <= date && end >= date)
    const schoolDays: string[] = []
    for (let ahead = 0; ahead < 20 && schoolDays.length < 3; ahead += 1) {
      const candidate = shiftDays(runDate, ahead)
      if (weekdayOf(candidate) === 0 || onHoliday(candidate)) continue
      schoolDays.push(candidate)
    }

    // Substitutions: some covered by the teachers who have a login, so their
    // dashboard shows a cover duty, and two left without a stand-in.
    const coverStaff = teacherLogins.slice(0, 4)
    let placedSubstitutions = 0
    let uncovered = 0
    for (const date of schoolDays) {
      const isoDay = weekdayOf(date)
      const periods = await client.query<{ section_id: string; period_index: number; subject_id: string; staff_id: string }>(
        `SELECT section_id, period_index, subject_id, staff_id FROM timetable_entries
          WHERE school_id = $1 AND academic_year_id = $2 AND day_of_week = $3 AND staff_id IS NOT NULL
          ORDER BY period_index, section_id LIMIT 40`,
        [schoolId, yearNow.id, isoDay],
      )
      for (const row of periods.rows) {
        if (placedSubstitutions >= 6) break
        const stand = coverStaff[placedSubstitutions % coverStaff.length] as StaffSeed | undefined
        const substitute =
          uncovered < 2 && placedSubstitutions % 3 === 2
            ? null
            : stand && stand.id !== row.staff_id
              ? stand.id
              : null
        if (substitute === null) uncovered += 1
        await client.query(
          `INSERT INTO substitutions (id, school_id, date, section_id, period_index, subject_id,
                                      absent_staff_id, substitute_staff_id, reason, notified)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            randomUUID(), schoolId, date, row.section_id, row.period_index, row.subject_id,
            row.staff_id, substitute, 'Teacher on leave', substitute !== null,
          ],
        )
        placedSubstitutions += 1
      }
    }

    // Two invitations still waiting, one of them about to run out.
    // A staff invitation must name the staff record it is for, so these go to
    // two teachers who have no login yet.
    const uninvited = activeTeachers.filter((member) => !teacherLogins.includes(member))
    const invitationPlan: [string, string, number, string[], StaffSeed | undefined][] = [
      ['anita.new' + EMAIL_DOMAIN, 'a***@sunrise.test', 18, ['teacher'], uninvited[0]],
      ['vikram.new' + EMAIL_DOMAIN, 'v***@sunrise.test', 60, ['teacher'], uninvited[1]],
    ]
    for (const [identifier, masked, hours, roles, member] of invitationPlan) {
      if (!member) continue
      await client.query(
        `INSERT INTO school_invitations (id, school_id, identifier_type, identifier_normalized,
                                         destination_masked, token_digest, status, proposed_role_keys,
                                         display_name, staff_id, inviter_membership_id, expires_at)
         VALUES ($1, $2, 'email', $3, $4, $5, 'pending', $6::text[], $7, $8, $9, now() + ($10 || ' hours')::interval)`,
        [
          randomUUID(), schoolId, identifier, masked,
          createHash('sha256').update(randomBytes(32)).digest('hex'),
          roles, identifier.split('@')[0], member.id, ownerMembershipId, String(hours),
        ],
      )
    }

    // Consent on record for about three in five children, so the "waiting on"
    // card has something to wait for and something to show as done.
    for (const [index, student] of students.entries()) {
      if (index % 5 >= 3) continue
      const family = guardiansOf.get(student.id) ?? []
      const guardian = family[0]
      if (!guardian) continue
      for (const purpose of CONSENT_PURPOSES) {
        await client.query(
          `INSERT INTO guardian_consents (id, school_id, student_id, guardian_id, purpose, status,
                                          method, recorded_by_membership_id)
           VALUES ($1, $2, $3, $4, $5, 'given', 'signed_form', $6)`,
          [randomUUID(), schoolId, student.id, guardian.id, purpose, ownerMembershipId],
        )
      }
    }

    // Three families the office has no phone number for.
    const withoutPhone = students.filter((student) => student.status === 'active').slice(0, 3)
    for (const student of withoutPhone) {
      for (const guardian of guardiansOf.get(student.id) ?? []) {
        await client.query('UPDATE guardians SET phone = NULL WHERE school_id = $1 AND id = $2', [
          schoolId, guardian.id,
        ])
      }
    }

    // One class still waiting for a class teacher.
    const teacherless = sectionsNow[sectionsNow.length - 1] as SectionSeed
    await client.query(
      'UPDATE sections SET class_teacher_staff_id = NULL WHERE school_id = $1 AND id = $2',
      [schoolId, teacherless.id],
    )

    // Birthdays on the day the seed is run and inside the week after it.
    const birthdayStudents = students.filter((student) => student.status === 'active').slice(3, 6)
    for (const [index, student] of birthdayStudents.entries()) {
      const when = shiftDays(runDate, index === 0 ? 0 : index * 2)
      const born = `${student.dateOfBirth.slice(0, 4)}${when.slice(4)}`
      await client.query('UPDATE students SET date_of_birth = $3 WHERE school_id = $1 AND id = $2', [
        schoolId, student.id, born,
      ])
    }
    const birthdayStaff = activeTeachers[activeTeachers.length - 1] as StaffSeed
    await client.query(
      `UPDATE staff SET date_of_birth = (to_char(date_of_birth, 'YYYY') || $3)::date
        WHERE school_id = $1 AND id = $2`,
      [schoolId, birthdayStaff.id, runDate.slice(4)],
    )

    // Admissions spread across the months of this session, with four of them
    // in the month the seed is run and one child who left this month.
    const admissionMonths = Array.from({ length: 12 }, (_, index) => {
      const cursor = new Date(`${yearNow.start.slice(0, 8)}01T00:00:00Z`)
      cursor.setUTCMonth(cursor.getUTCMonth() + index)
      return cursor.toISOString().slice(0, 7)
    })
    const spread = students.filter((student) => student.status === 'active').slice(6, 6 + 24)
    for (const [index, student] of spread.entries()) {
      const month = admissionMonths[index % admissionMonths.length] as string
      await client.query(
        'UPDATE students SET admission_date = $3::date WHERE school_id = $1 AND id = $2',
        [schoolId, student.id, `${month}-10`],
      )
    }
    const thisMonth = students.filter((student) => student.status === 'active').slice(40, 44)
    for (const student of thisMonth) {
      await client.query(
        'UPDATE students SET admission_date = $3::date WHERE school_id = $1 AND id = $2',
        [schoolId, student.id, `${runDate.slice(0, 7)}-05`],
      )
    }
    const leftThisMonth = students.filter((student) => student.status === 'active').slice(50, 51)
    for (const student of leftThisMonth) {
      await client.query(
        `UPDATE students SET status = 'left', left_on = $3::date, left_reason = 'Family relocated'
          WHERE school_id = $1 AND id = $2`,
        [schoolId, student.id, `${runDate.slice(0, 7)}-08`],
      )
      await client.query(
        `UPDATE enrollments SET left_on = $3::date, outcome = 'left'
          WHERE school_id = $1 AND student_id = $2 AND left_on IS NULL`,
        [schoolId, student.id, `${runDate.slice(0, 7)}-08`],
      )
    }

    // ------------------------------------------------------------------ fees
    // The school's own list of what it charges, an amount for each class, a
    // few optional fees and concessions, and a ledger with something in every
    // state: paid up, part paid, nothing paid, a refund, a cancelled cheque and
    // a fine. Amounts are whole paise. Receipt numbers are written in the
    // school's own format, so the API's counter carries on after them.
    const rupees = (value: number): number => value * 100
    const feeHeadSeeds = [
      { key: 'tuition', name: 'Tuition fee', category: 'tuition', appliesTo: 'class', frequency: 'monthly' },
      { key: 'annual', name: 'Annual charges', category: 'other', appliesTo: 'class', frequency: 'yearly' },
      { key: 'exam', name: 'Examination fee', category: 'exam', appliesTo: 'class', frequency: 'half_yearly' },
      { key: 'lab', name: 'Science lab fee', category: 'lab', appliesTo: 'class', frequency: 'quarterly' },
      { key: 'library', name: 'Library fee', category: 'library', appliesTo: 'class', frequency: 'yearly' },
      { key: 'admission', name: 'Admission fee', category: 'admission', appliesTo: 'opt_in', frequency: 'one_time' },
      { key: 'transport', name: 'School bus', category: 'transport', appliesTo: 'opt_in', frequency: 'monthly' },
      { key: 'sports', name: 'Sports academy', category: 'sports', appliesTo: 'opt_in', frequency: 'quarterly' },
      { key: 'music', name: 'Music club', category: 'activity', appliesTo: 'opt_in', frequency: 'half_yearly' },
      { key: 'late', name: 'Late fee', category: 'late_fee', appliesTo: 'opt_in', frequency: 'one_time' },
    ] as const
    const feeHead = new Map<string, string>()
    for (const head of feeHeadSeeds) {
      const headId = randomUUID()
      feeHead.set(head.key, headId)
      await client.query(
        `INSERT INTO fee_heads (id, school_id, name, category, applies_to, frequency)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [headId, schoolId, head.name, head.category, head.appliesTo, head.frequency],
      )
    }
    const structure = async (key: string, gradeId: string | null, amount: number): Promise<void> => {
      await client.query(
        `INSERT INTO fee_structures (school_id, academic_year_id, fee_head_id, grade_id, amount_paise)
         VALUES ($1, $2, $3, $4, $5)`,
        [schoolId, yearNow.id, feeHead.get(key), gradeId, amount],
      )
    }
    const tuitionOf = (grade: GradeSeed): number => rupees(2200 + grade.sortOrder * 150)
    for (const grade of grades) {
      await structure('tuition', grade.id, tuitionOf(grade))
      // The lab is for the senior classes only, so the junior ones have no row.
      if (grade.sortOrder >= 9) await structure('lab', grade.id, rupees(900))
    }
    // One amount for every class, where the school charges everybody the same.
    await structure('annual', null, rupees(6500))
    await structure('exam', null, rupees(1200))
    await structure('library', null, rupees(800))
    await structure('admission', null, rupees(15000))
    await structure('transport', null, rupees(1800))
    await structure('sports', null, rupees(2500))
    await structure('music', null, rupees(3000))

    const feePupils = students.filter((student) => student.status === 'active' && student.section !== null)
    const optIn = async (student: StudentSeed, key: string, amount: number | null, startsOn: string): Promise<void> => {
      await client.query(
        `INSERT INTO fee_student_heads (school_id, student_id, academic_year_id, fee_head_id, amount_paise, starts_on)
         VALUES ($1, $2, $3, $4, $5, $6::date)`,
        [schoolId, student.id, yearNow.id, feeHead.get(key), amount, startsOn],
      )
    }
    for (const [index, student] of feePupils.entries()) {
      // A third take the bus, and the far route costs more than the structure.
      if (index % 3 === 0) await optIn(student, 'transport', index % 9 === 0 ? rupees(2400) : null, yearNow.start)
      if (index % 7 === 0) await optIn(student, 'sports', null, yearNow.start)
      if (index % 11 === 0) await optIn(student, 'music', null, yearNow.start)
      if (student.admissionDate >= yearNow.start) await optIn(student, 'admission', null, student.admissionDate)
    }
    for (const [index, student] of feePupils.entries()) {
      if (index % 13 === 0) {
        await client.query(
          `INSERT INTO fee_concessions (school_id, student_id, academic_year_id, fee_head_id, category, kind, percent_bp)
           VALUES ($1, $2, $3, $4, 'sibling', 'percent', 1000)`,
          [schoolId, student.id, yearNow.id, feeHead.get('tuition')],
        )
      } else if (index % 29 === 0) {
        await client.query(
          `INSERT INTO fee_concessions (school_id, student_id, academic_year_id, fee_head_id, category, kind, percent_bp)
           VALUES ($1, $2, $3, NULL, 'scholarship', 'percent', 5000)`,
          [schoolId, student.id, yearNow.id],
        )
      }
    }

    let receiptCounter = 0
    const ledgerRow = async (row: {
      student: StudentSeed
      kind: 'payment' | 'refund' | 'cancellation' | 'credit_adjustment' | 'debit_adjustment'
      lines: readonly (readonly [string, number])[]
      mode: string | null
      reference: string | null
      receivedOn: string
      reverses?: string
    }): Promise<string> => {
      receiptCounter += 1
      const receiptId = randomUUID()
      const total = row.lines.reduce((sum, [, amount]) => sum + amount, 0)
      await client.query(
        `INSERT INTO fee_receipts (id, school_id, student_id, academic_year_id, kind, receipt_number,
                                   amount_paise, mode, reference, received_on, payer_name,
                                   reverses_receipt_id, recorded_by_membership_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12, $13)`,
        [
          receiptId, schoolId, row.student.id, yearNow.id, row.kind,
          `${SHORT_NAME}/${yearNow.name}/R${String(receiptCounter).padStart(4, '0')}`,
          total, row.mode, row.reference, row.receivedOn,
          row.kind === 'payment' ? `Parent of ${row.student.firstName}` : null,
          row.reverses ?? null, accountant.membershipId,
        ],
      )
      for (const [key, amount] of row.lines) {
        await client.query(
          `INSERT INTO fee_receipt_lines (school_id, receipt_id, fee_head_id, amount_paise)
           VALUES ($1, $2, $3, $4)`,
          [schoolId, receiptId, feeHead.get(key), amount],
        )
      }
      return receiptId
    }
    // How many monthly instalments have fallen due by the day the seed runs.
    const monthsDue = Math.max(
      1,
      Math.min(12, (Number(runDate.slice(0, 4)) - 2026) * 12 + Number(runDate.slice(5, 7)) - 4 + 1),
    )
    const modes = ['cash', 'upi', 'cheque', 'bank_transfer', 'demand_draft'] as const
    const referenceFor = (mode: string, index: number): string | null =>
      mode === 'cash' ? null : `${mode.slice(0, 3).toUpperCase()}${String(100000 + index * 37)}`
    for (const [index, student] of feePupils.entries()) {
      const grade = (student.section as SectionSeed).grade
      const tuition = tuitionOf(grade)
      const mode = modes[index % modes.length] as string
      // Every tenth family has paid nothing yet, so the dues list has a top.
      if (index % 10 === 9) continue
      // The annual charges and the first months of tuition, early in the year.
      await ledgerRow({
        student, kind: 'payment', mode, reference: referenceFor(mode, index),
        receivedOn: shiftDays(yearNow.start, 4 + (index % 20)),
        lines: [['annual', rupees(6500)], ['library', rupees(800)], ['tuition', tuition * Math.min(2, monthsDue)]],
      })
      // Most families then keep up with tuition; a quarter fall a month or two behind.
      const paidMonths = index % 4 === 0 ? Math.max(2, monthsDue - 2) : monthsDue
      if (paidMonths > 2) {
        await ledgerRow({
          student, kind: 'payment', mode, reference: referenceFor(mode, index + 500),
          // A handful are dated today, so "collected today" has a figure.
          receivedOn: index % 25 === 0 ? runDate : shiftDays(runDate, -(3 + (index % 40))),
          lines: [['tuition', tuition * (paidMonths - 2)]],
        })
      }
    }
    // One of each thing that can happen to a payment.
    const [refunded, bounced, fined] = [feePupils[1], feePupils[2], feePupils[4]] as [StudentSeed, StudentSeed, StudentSeed]
    const overpaid = await ledgerRow({
      student: refunded, kind: 'payment', mode: 'upi', reference: 'UPI778812', receivedOn: shiftDays(runDate, -12),
      lines: [['exam', rupees(1200)]],
    })
    await ledgerRow({
      student: refunded, kind: 'refund', mode: 'bank_transfer', reference: 'NEFT552190', receivedOn: shiftDays(runDate, -6),
      lines: [['exam', rupees(400)]], reverses: overpaid,
    })
    const cheque = await ledgerRow({
      student: bounced, kind: 'payment', mode: 'cheque', reference: 'CHQ004417', receivedOn: shiftDays(runDate, -9),
      lines: [['exam', rupees(1200)]],
    })
    await ledgerRow({
      student: bounced, kind: 'cancellation', mode: null, reference: null, receivedOn: shiftDays(runDate, -3),
      lines: [['exam', rupees(1200)]], reverses: cheque,
    })
    await ledgerRow({
      student: fined, kind: 'debit_adjustment', mode: null, reference: null, receivedOn: shiftDays(runDate, -2),
      lines: [['late', rupees(200)]],
    })
    await client.query(
      `INSERT INTO number_sequences (school_id, kind, period, next_value) VALUES ($1, 'receipt', $2, $3)`,
      [schoolId, yearNow.id, receiptCounter + 1],
    )

    // ------------------------------------------------------------ attendance
    // Marked registers for every section from the first day of the year up to
    // yesterday (so a report card's term attendance reads like a real one), about
    // half the sections marked today (never Nursery A, so its class teacher
    // has a register to mark), a few office corrections, one pupil absent on
    // the last three school days, a staff register for the same weeks, and a
    // teacher whose assignment to a section ended last month.
    const lastMonthEnd = `${shiftDays(`${runDate.slice(0, 7)}-01`, -1)}`
    const leftLastMonth = teacherLogins[2] as StaffSeed
    const class1A = findSection(yearNow.id, 4, 'A') as SectionSeed
    await client.query(
      `UPDATE teaching_assignments SET effective_to = $4::date
        WHERE school_id = $1 AND staff_id = $2 AND section_id = $3 AND academic_year_id = $5`,
      [schoolId, leftLastMonth.id, class1A.id, lastMonthEnd, yearNow.id],
    )

    const enrolled = await client.query<{ student_id: string; section_id: string; joined_on: string; left_on: string | null }>(
      `SELECT student_id, section_id, to_char(joined_on, 'YYYY-MM-DD') AS joined_on,
              to_char(left_on, 'YYYY-MM-DD') AS left_on
         FROM enrollments WHERE school_id = $1 AND academic_year_id = $2`,
      [schoolId, yearNow.id],
    )
    const rosterOn = (sectionId: string, date: string): string[] =>
      enrolled.rows
        .filter((row) => row.section_id === sectionId && row.joined_on <= date && (row.left_on === null || row.left_on >= date))
        .map((row) => row.student_id)
    const isSchoolDay = (date: string): boolean =>
      date >= yearNow.start && date <= yearNow.end && weekdayOf(date) !== 0 && !onHoliday(date)
    const markedDays: string[] = []
    for (let date = yearNow.start; date <= runDate; date = shiftDays(date, 1)) {
      if (isSchoolDay(date)) markedDays.push(date)
    }
    const pastDays = markedDays.filter((date) => date < runDate)
    const todayIsSchoolDay = markedDays.includes(runDate)
    const streakSection = sectionsNow[13] as SectionSeed
    const streakDays = markedDays.slice(-3)
    const streakPupil = rosterOn(streakSection.id, runDate)[2] as string
    const markFor = (): string => {
      const roll = random()
      if (roll < 0.92) return 'present'
      if (roll < 0.95) return 'absent'
      if (roll < 0.97) return 'late'
      if (roll < 0.99) return 'leave'
      return 'half_day'
    }
    const principalMembership = principal.membershipId
    const officeMembership = (adminLogins[0] as { membershipId: string }).membershipId
    interface MarkRow { id: string; studentId: string; sectionId: string; date: string; mark: string; by: string }
    const marks: MarkRow[] = []
    for (const [index, section] of sectionsNow.entries()) {
      const teacher = classTeacherOf.get(`${section.grade.sortOrder}-${section.name}`)
      const by = (teacher && teacherMembershipOf.get(teacher.id)) ?? principalMembership
      const days = index === 0 || index % 2 === 0 ? pastDays : markedDays
      for (const date of days) {
        for (const studentId of rosterOn(section.id, date)) {
          const streak = studentId === streakPupil && streakDays.includes(date)
          marks.push({ id: randomUUID(), studentId, sectionId: section.id, date, mark: streak ? 'absent' : markFor(), by })
        }
      }
    }
    for (let start = 0; start < marks.length; start += 500) {
      const chunk = marks.slice(start, start + 500)
      const values: unknown[] = []
      const rows = chunk.map((row) => {
        values.push(row.id, schoolId, row.studentId, row.sectionId, yearNow.id, row.date, row.mark, row.by)
        const base = values.length - 8
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::date, $${base + 7}, 1, NULL, 'marking', $${base + 8})`
      })
      await client.query(
        `INSERT INTO attendance_entries (id, school_id, student_id, section_id, academic_year_id, date, mark,
                                         revision, supersedes_entry_id, kind, recorded_by_membership_id)
         VALUES ${rows.join(', ')}`,
        values,
      )
    }
    // Five office corrections: an absence that turned out to be leave.
    const corrected = marks.filter((row) => row.mark === 'absent' && row.date < runDate && row.studentId !== streakPupil).slice(0, 5)
    for (const row of corrected) {
      await client.query(
        `INSERT INTO attendance_entries (id, school_id, student_id, section_id, academic_year_id, date, mark,
                                         revision, supersedes_entry_id, kind, recorded_by_membership_id)
         VALUES ($1, $2, $3, $4, $5, $6::date, 'leave', 2, $7, 'correction', $8)`,
        [randomUUID(), schoolId, row.studentId, row.sectionId, yearNow.id, row.date, row.id, officeMembership],
      )
    }
    // The staff register, marked by the office up to yesterday; today waits.
    const staffMarks: { staffId: string; date: string; mark: string }[] = []
    for (const date of pastDays) {
      for (const member of staffList) {
        if (member.status === 'resigned' || member.status === 'retired' || member.joiningDate > date) continue
        staffMarks.push({ staffId: member.id, date, mark: member.status === 'on_leave' ? 'leave' : markFor() })
      }
    }
    for (let start = 0; start < staffMarks.length; start += 500) {
      const chunk = staffMarks.slice(start, start + 500)
      const values: unknown[] = []
      const rows = chunk.map((row) => {
        values.push(randomUUID(), schoolId, row.staffId, row.date, row.mark, officeMembership)
        const base = values.length - 6
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::date, $${base + 5}, 1, NULL, 'marking', $${base + 6})`
      })
      await client.query(
        `INSERT INTO staff_attendance_entries (id, school_id, staff_id, date, mark, revision, supersedes_entry_id, kind, recorded_by_membership_id)
         VALUES ${rows.join(', ')}`,
        values,
      )
    }
    console.info(
      `Attendance: ${marks.length} marks over ${markedDays.length} school days` +
        `${todayIsSchoolDay ? ', half the sections marked today' : ' (today is not a school day)'}, ` +
        `${corrected.length} corrections, ${staffMarks.length} staff marks; ` +
        `${leftLastMonth.firstName} ${leftLastMonth.lastName} left ${class1A.grade.name} ${class1A.name} on ${lastMonthEnd}.`,
    )

    // Last year's register too, every school day, so last year's final report
    // cards carry a full year of attendance.
    const enrolledPast = await client.query<{ student_id: string; section_id: string; joined_on: string; left_on: string | null }>(
      `SELECT student_id, section_id, to_char(joined_on, 'YYYY-MM-DD') AS joined_on,
              to_char(left_on, 'YYYY-MM-DD') AS left_on
         FROM enrollments WHERE school_id = $1 AND academic_year_id = $2`,
      [schoolId, yearPast.id],
    )
    const pastMarks: { studentId: string; sectionId: string; date: string; mark: string }[] = []
    for (let date = yearPast.start; date <= yearPast.end; date = shiftDays(date, 1)) {
      if (weekdayOf(date) === 0) continue
      for (const row of enrolledPast.rows) {
        if (row.joined_on > date || (row.left_on !== null && row.left_on < date)) continue
        pastMarks.push({ studentId: row.student_id, sectionId: row.section_id, date, mark: markFor() })
      }
    }
    for (let start = 0; start < pastMarks.length; start += 500) {
      const chunk = pastMarks.slice(start, start + 500)
      const values: unknown[] = []
      const rows = chunk.map((row) => {
        values.push(randomUUID(), schoolId, row.studentId, row.sectionId, yearPast.id, row.date, row.mark, principalMembership)
        const base = values.length - 8
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::date, $${base + 7}, 1, NULL, 'marking', $${base + 8})`
      })
      await client.query(
        `INSERT INTO attendance_entries (id, school_id, student_id, section_id, academic_year_id, date, mark,
                                         revision, supersedes_entry_id, kind, recorded_by_membership_id)
         VALUES ${rows.join(', ')}`,
        values,
      )
    }

    // ----------------------------------------------------------------- exams
    // Last year: all four exams set, marked, published, with a term 1 and a
    // final report card for everybody. This year: periodic test 1 and the
    // half-yearly marked and published for every section but one (Class 5 B,
    // whose half-yearly still has empty cells, so only the office can finish
    // it now), a few re-check corrections and one office correction after
    // the deadline, co-scholastic grades and remarks, and term 1 cards;
    // periodic test 2 open for entry today with two sections done; the annual
    // exam set for March. Dates sit around the day the seed is run.
    const conn = { client, db: drizzle(client) }
    const clampInto = (year: { start: string; end: string }, date: string): string =>
      date < year.start ? year.start : date > year.end ? year.end : date
    const examPlan: { year: typeof yearNow; kind: string; starts: string; ends: string; deadline: string }[] = [
      { year: yearPast, kind: 'periodic_test_1', starts: '2025-07-14', ends: '2025-07-16', deadline: '2025-07-25' },
      { year: yearPast, kind: 'half_yearly', starts: '2025-09-15', ends: '2025-09-22', deadline: '2025-09-30' },
      { year: yearPast, kind: 'periodic_test_2', starts: '2025-12-08', ends: '2025-12-10', deadline: '2025-12-19' },
      { year: yearPast, kind: 'annual', starts: '2026-03-02', ends: '2026-03-12', deadline: '2026-03-20' },
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
    const subjectById = new Map(subjects.map((subject) => [subject.id, subject]))
    const incompleteSection = findSection(yearNow.id, 8, 'B') as SectionSeed
    const enrolledIn = (rows: { student_id: string; section_id: string; joined_on: string; left_on: string | null }[], sectionId: string, date: string): string[] =>
      rows
        .filter((row) => row.section_id === sectionId && row.joined_on <= date && (row.left_on === null || row.left_on >= date))
        .map((row) => row.student_id)
    interface ExamMarkRow { id: string; paperId: string; examId: string; yearId: string; sectionId: string; subjectId: string; studentId: string; component: string; status: string; tenths: number | null; by: string }
    const examMarks: ExamMarkRow[] = []
    const papers = await client.query<{ id: string; exam_id: string; academic_year_id: string; section_id: string; subject_id: string }>(
      'SELECT id, exam_id, academic_year_id, section_id, subject_id FROM exam_papers WHERE school_id = $1',
      [schoolId],
    )
    const pt2Sections = new Set([findSection(yearNow.id, 9, 'A')?.id, findSection(yearNow.id, 9, 'B')?.id])
    for (const exam of examPlan) {
      const examId = examIdOf.get(`${exam.year.id}:${exam.kind}`) as string
      const current = exam.year.id === yearNow.id
      // This year's periodic test 2 is under way in two sections; the annual exam is ahead.
      if (current && exam.kind === 'annual') continue
      const rows = current ? enrolled.rows : enrolledPast.rows
      for (const paper of papers.rows.filter((row) => row.exam_id === examId)) {
        if (current && exam.kind === 'periodic_test_2' && !pt2Sections.has(paper.section_id)) continue
        const subject = subjectById.get(paper.subject_id)
        const teacher = current ? teacherFor.get(`${paper.section_id}:${paper.subject_id}`) : undefined
        const by = (teacher && teacherMembershipOf.get(teacher.id)) ?? principalMembership
        const roster = enrolledIn(rows, paper.section_id, exam.starts)
        for (const [index, studentId] of roster.entries()) {
          // Class 5 B's half-yearly is not finished: three pupils still have no written mark in the first subject.
          for (const [component, max] of COMPONENTS[exam.kind] as [string, number][]) {
            if (
              current && exam.kind === 'half_yearly' && paper.section_id === incompleteSection.id &&
              component === 'written' && index >= roster.length - 3 &&
              paper.subject_id === (subjectsFor(incompleteSection.grade).find((s) => s.type !== 'co_scholastic') as SubjectSeed).id
            ) continue
            // An optional subject a pupil does not take is marked exempt.
            const value = subject?.optional === true && index % 3 === 0 ? { status: 'exempt', tenths: null } : markValue(studentId, max)
            examMarks.push({
              id: randomUUID(), paperId: paper.id, examId, yearId: exam.year.id, sectionId: paper.section_id,
              subjectId: paper.subject_id, studentId, component, status: value.status, tenths: value.tenths, by,
            })
          }
        }
      }
    }
    for (let start = 0; start < examMarks.length; start += 400) {
      const chunk = examMarks.slice(start, start + 400)
      const values: unknown[] = []
      const rows = chunk.map((row) => {
        values.push(row.id, schoolId, row.paperId, row.examId, row.yearId, row.sectionId, row.subjectId, row.studentId, row.component, row.status, row.tenths, row.by)
        const base = values.length - 12
        return `(${Array.from({ length: 12 }, (_, i) => `$${base + i + 1}`).join(', ')}, 1, NULL, 'entry', NULL)`
      })
      await client.query(
        `INSERT INTO exam_marks (id, school_id, paper_id, exam_id, academic_year_id, section_id, subject_id, student_id,
                                 component, status, marks_tenths, recorded_by_membership_id,
                                 revision, supersedes_mark_id, kind, reason_kind)
         VALUES ${rows.join(', ')}`,
        values,
      )
    }
    // Re-checks in class: four written marks raised by the subject teacher
    // before the deadline, and one the office corrected after it. The words
    // of each reason are the audit note, as the API writes them.
    const halfYearly = examIdOf.get(`${yearNow.id}:half_yearly`) as string
    const written = examMarks.filter(
      (row) => row.examId === halfYearly && row.component === 'written' && row.status === 'marked' && (row.tenths ?? 0) <= 700 &&
        row.sectionId !== incompleteSection.id,
    )
    const reChecked = [written[3], written[40], written[97], written[160]].filter((row): row is ExamMarkRow => row !== undefined)
    const officeFix = written.find((row) => row.sectionId === class1A.id && !reChecked.includes(row))
    const correctionAudit = async (
      row: ExamMarkRow, by: string, action: string, kind: string, reasonKind: string, note: string, summary: string,
    ): Promise<void> => {
      const eventId = randomUUID()
      await client.query(
        `INSERT INTO audit_events (id, school_id, actor_membership_id, action, target_type, target_id, result, summary, safe_changes, request_id)
         VALUES ($1, $2, $3, $4, 'exam_paper', $5, 'allowed', $6, $7::jsonb, 'dev-seed')`,
        [eventId, schoolId, by, action, row.paperId, summary,
          JSON.stringify({ paperId: row.paperId, examId: row.examId, sectionId: row.sectionId, subjectId: row.subjectId, [kind === 'correction' ? 'corrected' : 'changed']: 1, reasonKind })],
      )
      await client.query(
        'INSERT INTO audit_event_notes (school_id, audit_event_id, note) VALUES ($1, $2, $3)',
        [schoolId, eventId, note],
      )
    }
    for (const row of reChecked) {
      await client.query(
        `INSERT INTO exam_marks (school_id, paper_id, exam_id, academic_year_id, section_id, subject_id, student_id,
                                 component, status, marks_tenths, revision, supersedes_mark_id, kind, reason_kind,
                                 recorded_by_membership_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'marked', $9, 2, $10, 'entry', 'recheck', $11)`,
        [schoolId, row.paperId, row.examId, row.yearId, row.sectionId, row.subjectId, row.studentId, row.component,
          Math.min(800, (row.tenths ?? 0) + 30), row.id, row.by],
      )
      await correctionAudit(row, row.by, 'exams.record_marks', 'entry', 'recheck',
        'Re-checked in class: one answer was marked short by three marks.', 'Saved marks for a paper.')
    }
    if (officeFix) {
      await client.query(
        `INSERT INTO exam_marks (school_id, paper_id, exam_id, academic_year_id, section_id, subject_id, student_id,
                                 component, status, marks_tenths, revision, supersedes_mark_id, kind, reason_kind,
                                 recorded_by_membership_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'marked', $9, 2, $10, 'correction', 'entry_error', $11)`,
        [schoolId, officeFix.paperId, officeFix.examId, officeFix.yearId, officeFix.sectionId, officeFix.subjectId,
          officeFix.studentId, officeFix.component, Math.min(800, (officeFix.tenths ?? 0) + 50), officeFix.id, officeMembership],
      )
      await correctionAudit(officeFix, officeMembership, 'exams.manage', 'correction', 'entry_error',
        'The page total was copied wrongly onto the marks sheet; corrected from the answer book.', 'Corrected marks on a paper.')
    }
    // Publications: every exam of last year, and this year's periodic test 1
    // everywhere and the half-yearly everywhere but Class 5 B.
    const allSections = sections.map((section) => section.id)
    for (const exam of examPlan) {
      if (exam.year.id === yearNow.id && (exam.kind === 'periodic_test_2' || exam.kind === 'annual')) continue
      const examId = examIdOf.get(`${exam.year.id}:${exam.kind}`) as string
      for (const section of sections.filter((row) => row.yearId === exam.year.id)) {
        if (exam.year.id === yearNow.id && exam.kind === 'half_yearly' && section.id === incompleteSection.id) continue
        if (!papers.rows.some((paper) => paper.exam_id === examId && paper.section_id === section.id)) continue
        await client.query(
          `INSERT INTO exam_publications (school_id, exam_id, academic_year_id, section_id, published_by_membership_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [schoolId, examId, exam.year.id, section.id, principalMembership],
        )
      }
    }
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
    const termEntries: { section: SectionSeed; term: string; roster: string[] }[] = []
    for (const section of sections) {
      const past = section.yearId === yearPast.id
      if (!past && section.id === incompleteSection.id) continue
      const rows = past ? enrolledPast.rows : enrolled.rows
      for (const [term, kind] of past ? [['term_1', 'half_yearly'], ['term_2', 'annual']] : [['term_1', 'half_yearly']]) {
        const exam = examPlan.find((row) => row.year.id === section.yearId && row.kind === kind)
        if (!exam) continue
        termEntries.push({ section, term: term as string, roster: enrolledIn(rows, section.id, exam.starts) })
      }
    }
    let remarkIndex = 0
    for (const entry of termEntries) {
      const teacher = entry.section.yearId === yearNow.id ? classTeacherOf.get(`${entry.section.grade.sortOrder}-${entry.section.name}`) : undefined
      const by = (teacher && teacherMembershipOf.get(teacher.id)) ?? principalMembership
      for (const studentId of entry.roster) {
        await client.query(
          `INSERT INTO report_card_entries (school_id, student_id, academic_year_id, section_id, term, work_education,
                                            art_education, health_physical_education, discipline, remarks, updated_by_membership_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [schoolId, studentId, entry.section.yearId, entry.section.id, entry.term, coGrade(), coGrade(), coGrade(), coGrade(),
            REMARKS[remarkIndex++ % REMARKS.length], by],
        )
      }
    }

    // The logo, a small emblem drawn here so no image file has to ship: a
    // navy disc with an orange sun rising over a white horizon.
    const logoPng = (): Uint8Array => {
      const size = 192
      const raw = Buffer.alloc((size * 4 + 1) * size)
      const centre = size / 2
      for (let y = 0; y < size; y += 1) {
        raw[y * (size * 4 + 1)] = 0
        for (let x = 0; x < size; x += 1) {
          const at = y * (size * 4 + 1) + 1 + x * 4
          const dx = x - centre + 0.5
          const dy = y - centre + 0.5
          const r = Math.sqrt(dx * dx + dy * dy)
          let colour: [number, number, number, number] = [0, 0, 0, 0]
          if (r <= centre - 2) colour = [30, 41, 95, 255]
          if (r <= centre - 2 && r >= centre - 10) colour = [245, 158, 11, 255]
          const sunY = centre + 22
          const sun = Math.sqrt(dx * dx + (y - sunY) ** 2)
          if (r <= centre - 10 && y <= sunY && sun <= 44) colour = [251, 146, 60, 255]
          if (r <= centre - 10 && Math.abs(y - sunY) <= 3) colour = [255, 255, 255, 255]
          raw[at] = colour[0]
          raw[at + 1] = colour[1]
          raw[at + 2] = colour[2]
          raw[at + 3] = colour[3]
        }
      }
      const chunk = (type: string, data: Buffer): Buffer => {
        const length = Buffer.alloc(4)
        length.writeUInt32BE(data.length)
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
        const crc = Buffer.alloc(4)
        crc.writeUInt32BE(crc32(body) >>> 0)
        return Buffer.concat([length, body, crc])
      }
      const header = Buffer.alloc(13)
      header.writeUInt32BE(size, 0)
      header.writeUInt32BE(size, 4)
      header[8] = 8
      header[9] = 6
      return new Uint8Array(Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
      ]))
    }
    if (process.env.DOCUMENT_STORAGE === 'blob') {
      console.warn('The logo was not seeded: DOCUMENT_STORAGE is blob, and this seed only writes to the local store.')
    } else {
      const logoKey = `logos/${schoolId}-${randomBytes(16).toString('hex')}`
      await createLocalDocumentStorage(process.env.DOCUMENT_STORAGE_DIR ?? '.documents').write(logoKey, logoPng(), 'image/png')
      await client.query(
        `UPDATE schools SET logo_storage_key = $2, logo_content_type = 'image/png', logo_updated_at = now() WHERE id = $1`,
        [schoolId, logoKey],
      )
    }

    // Published report cards, built by the same code the office's publish
    // uses: this year's term 1 card wherever the half-yearly is published,
    // and last year's term 1 and final cards.
    let cardsPublished = 0
    for (const entry of termEntries) {
      const cards = entry.section.yearId === yearNow.id ? ['term_1'] : entry.term === 'term_1' ? ['term_1'] : ['final']
      for (const card of cards) {
        for (const studentId of entry.roster) {
          const built = await buildReportCard(conn, schoolId, {
            studentId,
            sectionId: entry.section.id,
            academicYearId: entry.section.yearId,
            card: card as 'term_1' | 'final',
            today: runDate,
          })
          await client.query(
            `INSERT INTO report_card_versions (school_id, student_id, academic_year_id, section_id, card, version_number,
                                               content, remarks, content_hash, published_by_membership_id)
             VALUES ($1, $2, $3, $4, $5, 1, $6::jsonb, $7::jsonb, $8, $9)`,
            [schoolId, studentId, entry.section.yearId, entry.section.id, card, JSON.stringify(built.content),
              Object.keys(built.remarks).length === 0 ? null : JSON.stringify(built.remarks), built.hash, principalMembership],
          )
          cardsPublished += 1
        }
      }
    }
    console.info(
      `Exams: ${examPlan.length} exams over two years, ${papers.rows.length} papers, ${examMarks.length} marks, ` +
        `${reChecked.length} re-checks and ${officeFix ? 1 : 0} office correction; ` +
        `${incompleteSection.grade.name} ${incompleteSection.name} left unfinished; ${cardsPublished} report cards published; ` +
        `${allSections.length} sections.`,
    )

    // --------------------------------------------------------- communication
    // Messages for every screen: office and teacher notices over the last
    // month, one scheduled, two drafts, one withdrawn and one with a file;
    // the school's own automatic messages for the last seven school days.
    // Every sent message goes through materialiseMessage, the code a real
    // send uses, so its recipient rows are real. The seed then moves the
    // timestamps back to the day each one went out, which the database
    // refuses anybody else, so the guard is off while it does.
    //
    // Automatic messages start now, as they would on the day a school turns
    // the module on: every result, card and mark above was written moments
    // ago, so an earlier start would have the first pump run send a notice
    // for each of them. The seed writes its own sample of automatic messages
    // below instead.
    await client.query(`INSERT INTO communication_settings (school_id, automatic_since) VALUES ($1, clock_timestamp())`, [
      schoolId,
    ])

    // Consent to messages for about nine in ten families: the existing rows
    // cover the first guardian of three children in five, so every other pair
    // is filled in here, with a few withdrawn and a few never asked.
    const pairs = await client.query<{ student_id: string; guardian_id: string }>(
      `SELECT sg.student_id, sg.guardian_id FROM student_guardians sg
        WHERE sg.school_id = $1 AND NOT EXISTS (
          SELECT 1 FROM guardian_consents gc
           WHERE gc.school_id = sg.school_id AND gc.student_id = sg.student_id
             AND gc.guardian_id = sg.guardian_id AND gc.purpose = 'communication')
        ORDER BY sg.student_id, sg.guardian_id`,
      [schoolId],
    )
    let consentsGiven = 0
    let consentsWithdrawn = 0
    for (const pair of pairs.rows) {
      const roll = random()
      if (roll >= 0.95) continue
      await client.query(
        `INSERT INTO guardian_consents (id, school_id, student_id, guardian_id, purpose, status, method,
                                        recorded_by_membership_id, recorded_at)
         VALUES ($1, $2, $3, $4, 'communication', 'given', 'signed_form', $5, now() - interval '60 days')`,
        [randomUUID(), schoolId, pair.student_id, pair.guardian_id, ownerMembershipId],
      )
      if (roll < 0.9) {
        consentsGiven += 1
        continue
      }
      await client.query(
        `INSERT INTO guardian_consents (id, school_id, student_id, guardian_id, purpose, status, method,
                                        recorded_by_membership_id, recorded_at)
         VALUES ($1, $2, $3, $4, 'communication', 'withdrawn', 'in_person', $5, now() - interval '10 days')`,
        [randomUUID(), schoolId, pair.student_id, pair.guardian_id, ownerMembershipId],
      )
      consentsWithdrawn += 1
    }

    await client.query('ALTER TABLE messages DISABLE TRIGGER messages_guard_update')
    // Only the tenant client and the auth lookup are used by the send, and the
    // sign-in accounts made above are visible on this transaction alone.
    const dispatch = { pools: { auth: client } } as unknown as DispatchDependencies
    // A moment in the school's day, as the UTC timestamp the database keeps.
    const at = (date: string, hour: number, minute = 0): string =>
      new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour, minute) - 330 * 60_000).toISOString()
    let messagesSent = 0
    let recipientRows = 0
    const send = async (id: string, planned: string): Promise<void> => {
      // A sample time later today would read as sent in the future, so it is
      // brought back to a minute ago.
      const sentAt = new Date(Math.min(Date.parse(planned), Date.now() - 60_000)).toISOString()
      const made = await materialiseMessage(conn, dispatch, schoolId, id, { allowEmpty: true })
      recipientRows += made.recipients
      messagesSent += 1
      await client.query(
        `UPDATE messages SET sent_at = $3::timestamptz, created_at = $3::timestamptz - interval '20 minutes',
                             updated_at = $3::timestamptz
          WHERE school_id = $1 AND id = $2`,
        [schoolId, id, sentAt],
      )
      await client.query(
        `UPDATE message_recipients SET created_at = $3::timestamptz,
                email_next_attempt_at = CASE WHEN email_status = 'pending' THEN $3::timestamptz END
          WHERE school_id = $1 AND message_id = $2`,
        [schoolId, id, sentAt],
      )
    }
    interface NoticeSeed {
      by: string
      audience: 'school' | 'staff' | 'grade' | 'grade_range' | 'section'
      gradeId?: string
      gradeToId?: string
      sectionId?: string
      /** Families unless said otherwise; the staff audiences have none. */
      recipients?: 'families' | 'students' | 'both'
      title: string
      body: string
    }
    const insertNotice = async (notice: NoticeSeed, status: 'draft' | 'scheduled', sendAt: string | null = null): Promise<string> => {
      const id = randomUUID()
      await client.query(
        `INSERT INTO messages (id, school_id, kind, audience, grade_id, section_id, academic_year_id, title, body,
                               status, send_at, created_by_membership_id, grade_to_id, recipients)
         VALUES ($1, $2, 'notice', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [id, schoolId, notice.audience, notice.gradeId ?? null, notice.sectionId ?? null,
          notice.sectionId ? yearNow.id : null, notice.title, notice.body, status, sendAt, notice.by,
          notice.gradeToId ?? null, notice.audience === 'staff' ? null : (notice.recipients ?? 'families')],
      )
      return id
    }

    // The office's notices over the last month.
    const gradeFive = grades.find((grade) => grade.name === 'Class 5') as GradeSeed
    const gradeTen = grades.find((grade) => grade.name === 'Class 10') as GradeSeed
    const sectionOf = (sort: number, name: string): SectionSeed =>
      sectionsNow.find((section) => section.grade.sortOrder === sort && section.name === name) ?? (sectionsNow[0] as SectionSeed)
    const officeNotices: (NoticeSeed & { daysAgo: number })[] = [
      { daysAgo: 29, by: principalMembership, audience: 'school', title: 'Welcome back after the monsoon break', body: 'School reopens on Monday at the usual time. Please make sure your child carries a raincoat or umbrella every day.' },
      { daysAgo: 26, by: officeMembership, audience: 'staff', title: 'Staff meeting on Friday', body: 'All teaching staff please gather in the library at 2:30 pm on Friday to plan the half-yearly exams.' },
      { daysAgo: 24, by: officeMembership, audience: 'grade', gradeId: gradeTen.id, title: 'Board registration forms', body: 'Class 10 parents, please check the board registration details sent home and return the signed form by Thursday.' },
      { daysAgo: 21, by: principalMembership, audience: 'school', title: 'Half-yearly exam timetable', body: 'The half-yearly exams begin next month. The timetable has been shared with every class and is on the notice board.' },
      { daysAgo: 19, by: officeMembership, audience: 'section', sectionId: sectionOf(8, 'A').id, title: 'Science exhibition models', body: 'Class 5 A will present their science models on Saturday. Parents are welcome between 10 am and noon.' },
      { daysAgo: 16, by: officeMembership, audience: 'school', title: 'Fee counter timings', body: 'The fee counter is open from 8:30 am to 1 pm on school days. Payments by UPI are also accepted at the counter.' },
      { daysAgo: 14, by: principalMembership, audience: 'grade', gradeId: gradeFive.id, title: 'Educational trip to Raman Science Centre', body: 'Class 5 will visit the Raman Science Centre next Wednesday. Please send the signed permission slip by Monday.' },
      { daysAgo: 11, by: officeMembership, audience: 'staff', title: 'Attendance registers by 9:30 am', body: 'A reminder that the class register should be marked by 9:30 am so that absence notices reach families in good time.' },
      { daysAgo: 9, by: principalMembership, audience: 'school', title: 'Ganesh Chaturthi holiday', body: 'School will remain closed for Ganesh Chaturthi. Classes resume the following day as usual.' },
      { daysAgo: 6, by: officeMembership, audience: 'school', title: 'Parent-teacher meeting', body: 'The parent-teacher meeting for all classes is on Saturday from 9 am to 12 noon. Report cards can be collected then.' },
      { daysAgo: 3, by: officeMembership, audience: 'section', sectionId: sectionOf(13, 'A').id, title: 'Extra classes for Class 10 A', body: 'Extra mathematics classes will run after school on Tuesday and Thursday until the exams. Pupils may bring a snack.' },
      { daysAgo: 1, by: principalMembership, audience: 'staff', title: 'Sports day volunteers', body: 'We need six volunteers to help on sports day. Please tell the office by Friday if you can help.' },
    ]
    let withdrawnId = ''
    let attachmentMessageId = ''
    for (const [index, notice] of officeNotices.entries()) {
      const id = await insertNotice(notice, 'draft')
      if (index === 5) {
        // The one with a file: a small PDF made here, stored the way an upload is.
        attachmentMessageId = id
        const lines = ['Sunrise Public School', 'Fee counter timings', 'Monday to Saturday, 8:30 am to 1 pm']
        const stream = `BT /F1 16 Tf 72 760 Td ${lines.map((line) => `(${line}) Tj 0 -24 Td`).join(' ')} ET`
        const objects = [
          '<< /Type /Catalog /Pages 2 0 R >>',
          '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
          `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
          '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        ]
        let pdf = '%PDF-1.4\n'
        const offsets: number[] = []
        for (const [at, body] of objects.entries()) {
          offsets.push(pdf.length)
          pdf += `${at + 1} 0 obj\n${body}\nendobj\n`
        }
        const xref = pdf.length
        pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
        pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
        const bytes = new Uint8Array(Buffer.from(pdf, 'latin1'))
        const key = `messages/${schoolId}/${id}/${randomBytes(16).toString('hex')}`
        if (process.env.DOCUMENT_STORAGE !== 'blob') {
          await createLocalDocumentStorage(process.env.DOCUMENT_STORAGE_DIR ?? '.documents').write(key, bytes, 'application/pdf')
          await client.query(
            `INSERT INTO message_attachments (school_id, message_id, file_name, content_type, size_bytes, storage_key)
             VALUES ($1, $2, 'fee-counter-timings.pdf', 'application/pdf', $3, $4)`,
            [schoolId, id, bytes.length, key],
          )
        }
      }
      await send(id, at(shiftDays(runDate, -notice.daysAgo), 9, 15 + index))
      if (index === 8) withdrawnId = id
    }
    // One withdrawn: the holiday notice named the wrong day. A status change
    // alone, as the seed writes no audit rows for messages.
    await client.query(
      `UPDATE messages SET status = 'withdrawn', withdrawn_at = sent_at + interval '2 hours',
                           withdrawn_by_membership_id = $3, version = version + 1, updated_at = sent_at + interval '2 hours'
        WHERE school_id = $1 AND id = $2`,
      [schoolId, withdrawnId, principalMembership],
    )
    await client.query(
      `UPDATE message_recipients SET email_status = 'cancelled', email_next_attempt_at = NULL
        WHERE school_id = $1 AND message_id = $2 AND email_status = 'pending'`,
      [schoolId, withdrawnId],
    )

    // Teacher notices from teacher1 and teacher3 to a section they teach.
    let teacherNotices = 0
    for (const [teacherIndex, member] of [[0, teacherLogins[0]], [2, teacherLogins[2]]] as const) {
      if (!member) continue
      const by = teacherMembershipOf.get(member.id)
      if (!by) continue
      const taught = await client.query<{ section_id: string }>(
        `SELECT DISTINCT section_id FROM teaching_assignments
          WHERE school_id = $1 AND staff_id = $2 AND academic_year_id = $3 AND effective_to IS NULL
          ORDER BY section_id LIMIT 2`,
        [schoolId, member.id, yearNow.id],
      )
      const [first, second] = taught.rows.map((row) => row.section_id)
      if (!first) continue
      const notes = [
        { sectionId: first, daysAgo: 12 + teacherIndex, title: 'Homework notebooks', body: 'Please check that your child brings the homework notebook every day. It will be signed on Fridays.' },
        { sectionId: second ?? first, daysAgo: 4 + teacherIndex, title: 'Class test next week', body: 'There will be a short class test next Tuesday on the chapters covered this month. Revision sheets were handed out today.' },
      ]
      for (const note of notes) {
        const id = await insertNotice({ by, audience: 'section', sectionId: note.sectionId, title: note.title, body: note.body }, 'draft')
        await send(id, at(shiftDays(runDate, -note.daysAgo), 14, 5 + teacherIndex))
        teacherNotices += 1
      }
      if (teacherIndex === 0) {
        // teacher1 also has a draft waiting.
        await insertNotice({ by, audience: 'section', sectionId: first, title: 'Library books to return', body: 'Library books borrowed last month are due back this week.' }, 'draft')
      }
    }
    // Notices to the pupils themselves (Task 23): the office to Class 9, to
    // Class 9 to Class 10 with their families, and to every family; and one
    // teacher to their own Class 9 or 10 section (its class teacher first). Pupils with an active
    // login get an in-app row each; the rest are recorded as not reachable.
    const gradeNine = grades.find((grade) => grade.name === 'Class 9') as GradeSeed
    const pupilNotices: (NoticeSeed & { daysAgo: number })[] = [
      { daysAgo: 8, by: officeMembership, audience: 'grade', gradeId: gradeNine.id, recipients: 'students', title: 'Science lab coats from Monday', body: 'From Monday every Class 9 pupil should bring a lab coat for science practicals.' },
      { daysAgo: 5, by: principalMembership, audience: 'grade_range', gradeId: gradeNine.id, gradeToId: gradeTen.id, recipients: 'both', title: 'Career guidance talk', body: 'A career guidance talk for Class 9 and Class 10 is on Friday in the hall. Parents are welcome to attend.' },
      { daysAgo: 2, by: officeMembership, audience: 'school', recipients: 'families', title: 'Annual day rehearsals', body: 'Annual day rehearsals begin next week. Pupils taking part may stay back until 4 pm.' },
    ]
    for (const [index, notice] of pupilNotices.entries()) {
      const id = await insertNotice(notice, 'draft')
      await send(id, at(shiftDays(runDate, -notice.daysAgo), 10, 5 + index))
    }
    const seniorClassTeacher = await client.query<{ membership_id: string; section_id: string }>(
      `SELECT l.membership_id, sec.id AS section_id
         FROM sections sec
         JOIN grades gr ON gr.school_id = sec.school_id AND gr.id = sec.grade_id
         JOIN membership_staff_links l ON l.school_id = sec.school_id
          AND (l.staff_id = sec.class_teacher_staff_id OR EXISTS (
                SELECT 1 FROM teaching_assignments ta
                 WHERE ta.school_id = sec.school_id AND ta.section_id = sec.id
                   AND ta.staff_id = l.staff_id AND ta.effective_to IS NULL))
         JOIN school_memberships m ON m.school_id = l.school_id AND m.id = l.membership_id AND m.status = 'active'
         JOIN membership_roles mr ON mr.school_id = m.school_id AND mr.membership_id = m.id
         JOIN roles r ON r.school_id = mr.school_id AND r.id = mr.role_id AND r.key = 'teacher'
        WHERE sec.school_id = $1 AND sec.academic_year_id = $2 AND gr.level IN (9, 10)
        ORDER BY (l.staff_id = sec.class_teacher_staff_id) DESC, gr.level, sec.name LIMIT 1`,
      [schoolId, yearNow.id],
    )
    let pupilNoticeCount = pupilNotices.length
    const classTeacher = seniorClassTeacher.rows[0]
    if (classTeacher) {
      const id = await insertNotice(
        { by: classTeacher.membership_id, audience: 'section', sectionId: classTeacher.section_id, recipients: 'students', title: 'Project groups', body: 'Project groups for the term are on the class board. Please meet your group before Thursday.' },
        'draft',
      )
      await send(id, at(shiftDays(runDate, -1), 13, 40))
      pupilNoticeCount += 1
    }

    // One scheduled for next week, and one office draft.
    await insertNotice(
      { by: officeMembership, audience: 'school', title: 'Sports day on Saturday', body: 'Sports day is this Saturday from 8 am. Pupils should come in their house T-shirts.' },
      'scheduled',
      at(shiftDays(runDate, 7), 8, 30),
    )
    await insertNotice(
      { by: officeMembership, audience: 'grade', gradeId: gradeTen.id, title: 'Pre-board exam dates', body: 'The pre-board exam dates will be shared soon.' },
      'draft',
    )

    // The school's own messages, written with the words the pump uses and the
    // same keys, so the pump never sends any of them a second time.
    const wording = await loadAutomaticWording(conn, schoolId)
    const pupilsNow = await client.query<{
      student_id: string; first_name: string; last_name: string | null
      section_id: string; academic_year_id: string; class_label: string
    }>(
      `SELECT st.id AS student_id, st.first_name, st.last_name, en.section_id, en.academic_year_id,
              gr.name || ' ' || sec.name AS class_label
         FROM students st
         JOIN enrollments en ON en.school_id = st.school_id AND en.student_id = st.id
          AND en.academic_year_id = $2 AND en.left_on IS NULL
         JOIN sections sec ON sec.school_id = st.school_id AND sec.id = en.section_id
         JOIN grades gr ON gr.school_id = sec.school_id AND gr.id = sec.grade_id
        WHERE st.school_id = $1 AND st.status = 'active' AND st.anonymised_at IS NULL
        ORDER BY st.id`,
      [schoolId, yearNow.id],
    )
    const pupilById = new Map(pupilsNow.rows.map((row) => [row.student_id, row]))
    const automaticCounts: Record<string, number> = {}
    const automatic = async (
      kind: AutomaticMessageKind,
      key: string,
      target: { studentId: string } | { staffId: string },
      values: Partial<Record<MessagePlaceholder, string>>,
      sentAt: string,
    ): Promise<void> => {
      const pupil = 'studentId' in target ? pupilById.get(target.studentId) : undefined
      if ('studentId' in target && !pupil) return
      const filled = {
        school: 'Sunrise Public School',
        ...(pupil
          ? { pupil_name: [pupil.first_name, pupil.last_name].filter(Boolean).join(' '), pupil_first_name: pupil.first_name, class: pupil.class_label }
          : {}),
        ...values,
      }
      const id = randomUUID()
      await client.query(
        `INSERT INTO messages (id, school_id, kind, audience, student_id, staff_id, section_id, academic_year_id,
                               title, body, status, template_id, dedupe_key, recipients)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', $11, $12, $13)`,
        [id, schoolId, kind, kind === 'birthday_staff' ? 'staff_member' : 'pupil',
          pupil?.student_id ?? null, 'staffId' in target ? target.staffId : null,
          pupil?.section_id ?? null, pupil?.academic_year_id ?? null,
          renderMessageText(wording[kind].title, filled).slice(0, MESSAGE_TITLE_MAX),
          renderMessageText(wording[kind].body, filled).slice(0, MESSAGE_BODY_MAX),
          wording[kind].templateId ?? null, key,
          // A pupil's birthday wish goes to the pupil too; the rest to families.
          kind === 'birthday_staff' ? null : kind === 'birthday_pupil' ? 'both' : 'families'],
      )
      await send(id, sentAt)
      automaticCounts[kind] = (automaticCounts[kind] ?? 0) + 1
    }

    // Absences on the last seven school days, from the register as it stands.
    const lastSchoolDays: string[] = []
    for (let back = 0; back < 20 && lastSchoolDays.length < 7; back += 1) {
      const candidate = shiftDays(runDate, -back)
      if (weekdayOf(candidate) === 0 || onHoliday(candidate)) continue
      lastSchoolDays.push(candidate)
    }
    const absences = await client.query<{ student_id: string; date: string }>(
      `SELECT student_id, to_char(date, 'YYYY-MM-DD') AS date FROM (
         SELECT DISTINCT ON (student_id, date) student_id, date, mark
           FROM attendance_entries
          WHERE school_id = $1 AND academic_year_id = $2 AND date = ANY($3::date[])
          ORDER BY student_id, date, revision DESC) latest
        WHERE mark = 'absent'
        ORDER BY date DESC, student_id
        LIMIT 40`,
      [schoolId, yearNow.id, lastSchoolDays],
    )
    for (const row of absences.rows) {
      await automatic('absence', `absence:${row.student_id}:${row.date}`, { studentId: row.student_id },
        { date: formatMessageDate(row.date) }, at(row.date, 10, 5))
    }

    // Results of the latest published exam, for two sections.
    const latestPublished = await client.query<{ exam_id: string; kind: string; section_id: string; published: string }>(
      `SELECT ep.exam_id, e.kind, ep.section_id, to_char(e.recheck_deadline, 'YYYY-MM-DD') AS published
         FROM exam_publications ep JOIN exams e ON e.school_id = ep.school_id AND e.id = ep.exam_id
        WHERE ep.school_id = $1 AND ep.academic_year_id = $2
        ORDER BY e.starts_on DESC, ep.section_id
        LIMIT 2`,
      [schoolId, yearNow.id],
    )
    for (const publication of latestPublished.rows) {
      const sentOn = publication.published > runDate ? runDate : publication.published
      for (const pupil of pupilsNow.rows.filter((row) => row.section_id === publication.section_id)) {
        await automatic('result', `result:${publication.exam_id}:${pupil.student_id}`, { studentId: pupil.student_id },
          { exam: EXAM_PATTERN[publication.kind as ExamKind].label }, at(sentOn, 16, 0))
      }
    }

    // Three pupil birthdays and one staff birthday over the last week, and a
    // few fee reminders.
    const year = runDate.slice(0, 4)
    for (const [index, pupil] of pupilsNow.rows.filter((_, index) => index % 97 === 5).slice(0, 3).entries()) {
      await automatic('birthday_pupil', `birthday_pupil:${pupil.student_id}:${year}`, { studentId: pupil.student_id }, {},
        at(lastSchoolDays[index * 2] ?? runDate, 8, 0))
    }
    // The staff member whose birthday the dashboard seed put on today.
    await automatic('birthday_staff', `birthday_staff:${birthdayStaff.id}:${year}`, { staffId: birthdayStaff.id },
      { staff_name: `${birthdayStaff.firstName} ${birthdayStaff.lastName}`, staff_first_name: birthdayStaff.firstName },
      at(runDate, 8, 0))
    const dueOn = shiftDays(runDate, 3)
    for (const [index, pupil] of pupilsNow.rows.filter((_, index) => index % 61 === 7).slice(0, 4).entries()) {
      await automatic('fee_reminder', `fee_reminder:${pupil.student_id}:${dueOn}`, { studentId: pupil.student_id },
        { amount: formatRupees([450000, 1250000, 325000, 780000][index] ?? 450000), due_date: formatMessageDate(dueOn) },
        at(runDate, 8, 5))
    }

    // About seven in ten app deliveries read, some time after they went out,
    // and about eight in ten waiting emails handed over.
    const readRows = await client.query(
      `UPDATE message_recipients r
          SET read_at = LEAST(now(), m.sent_at + ((abs(hashtext(r.id::text)) % 2880) || ' minutes')::interval)
         FROM messages m
        WHERE r.school_id = $1 AND m.school_id = r.school_id AND m.id = r.message_id
          AND m.status = 'sent' AND r.in_app AND abs(hashtext(r.id::text || 'read')) % 10 < 7`,
      [schoolId],
    )
    const emailed = await client.query(
      `UPDATE message_recipients r
          SET email_status = 'sent', email_attempts = 1, email_next_attempt_at = NULL,
              email_sent_at = LEAST(now(), m.sent_at + interval '2 minutes')
         FROM messages m
        WHERE r.school_id = $1 AND m.school_id = r.school_id AND m.id = r.message_id
          AND r.email_status = 'pending' AND abs(hashtext(r.id::text || 'mail')) % 10 < 8`,
      [schoolId],
    )
    await client.query('ALTER TABLE messages ENABLE TRIGGER messages_guard_update')
    console.info(
      `Messages: ${officeNotices.length} office and ${teacherNotices} teacher notices (one withdrawn, one with a file` +
        `${attachmentMessageId && process.env.DOCUMENT_STORAGE !== 'blob' ? '' : ' not stored'}), one scheduled, two drafts; ` +
        `${pupilNoticeCount} notices to pupils${classTeacher ? ' (one from a teacher of the class)' : ' (no teacher of Class 9 or 10 signs in)'}; ` +
        `automatic ${Object.entries(automaticCounts).map(([kind, count]) => `${kind} ${count}`).join(', ')}; ` +
        `${messagesSent} sent to ${recipientRows} recipient rows, ${readRows.rowCount ?? 0} read, ${emailed.rowCount ?? 0} emails sent; ` +
        `communication consent added for ${consentsGiven} pairs and withdrawn for ${consentsWithdrawn}.`,
    )

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
    for (const pupil of pupilPasswords) await setPassword(auth, pupil.userId, pupil.password)
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
    const method = login.pupil
      ? 'school code + admission number + password'
      : login.emailPassword
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
      password: login.pupil?.password ?? (login.emailPassword ? PASSWORD : ''),
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
      `\nPassword for the named pupils (admission number as the username): ${PUPIL_PASSWORD}` +
      `\nCurrent second-factor code: pnpm --filter @erp/api dev:totp <totp_secret>` +
      '\nOne-time codes for the parent phone logins: GET /api/dev/outbox' +
      `\nAccounts also written to ${csvPath}` +
      '\nThe Fixture A and Fixture B schools are untouched.',
  )
}

await main()
