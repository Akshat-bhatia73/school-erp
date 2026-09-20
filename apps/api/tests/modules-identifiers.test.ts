import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
  setFixturePassword,
  signInWithMfa,
  signInWithPassword,
  startTestServer,
  type TestServer,
} from './harness.ts'

const PASSWORD = 'Fixture-Pass!42'
// Unique per run: other test files rewrite the same fixture identities.
const OWNER_EMAIL = `identifiers-owner-${randomUUID()}@example.test`
const TEACHER_EMAIL = `identifiers-teacher-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const studentA = fixtureIds.studentA as string
const sectionA = fixtureIds.sectionA as string
const yearA = fixtureIds.yearA as string
const ownerUserId = fixtureIds.ownerAUser as string

// Rows this file owns.
const teacherUser = '10000000-0000-4000-8000-0000000019a1'
const teacherMembership = '10000000-0000-4000-8000-0000000019a2'
const teacherStaff = '10000000-0000-4000-8000-0000000019a3'
const subjectId = '10000000-0000-4000-8000-0000000019a4'

/**
 * Whole Aadhaar numbers that pass the Verhoeff check, and one that does not.
 * They are test digits: no real number appears in this file.
 */
const AADHAAR = '200000007919'
const OTHER_AADHAAR = '200000071271'
const GUARDIAN_AADHAAR = '200000253408'
const BAD_AADHAAR = '200000000001'
const PAN = 'ABCDE1234F'

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let teacher: Client

interface Basic {
  id: string
  version: number
}

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code
}

async function seedModuleRows(): Promise<void> {
  const pool = adminPool()
  await pool.query(
    `INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,'Civics','CIV','scholastic')
     ON CONFLICT (school_id,code) DO NOTHING`,
    [subjectId, schoolA],
  )
  // A teacher of 6A: no sensitive read and no guardian read, so the same
  // records answer with nothing private.
  await pool.query(
    `INSERT INTO auth_user(id,name,email) VALUES ($1,'Identifier Teacher',$2)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    [teacherUser, TEACHER_EMAIL],
  )
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')
     ON CONFLICT (school_id,user_id) DO NOTHING`,
    [teacherMembership, schoolA, teacherUser],
  )
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = 'teacher' ON CONFLICT DO NOTHING`,
    [schoolA, teacherMembership],
  )
  await pool.query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status)
     VALUES ($1,$2,'ID-A','Identifier','teaching','Teacher','active')
     ON CONFLICT (school_id,employee_code) DO NOTHING`,
    [teacherStaff, schoolA],
  )
  await pool.query(
    `INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING`,
    [schoolA, teacherMembership, teacherStaff],
  )
  await pool.query(
    `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from)
     VALUES ($1,$2,$3,$4,$5,'2026-04-01') ON CONFLICT DO NOTHING`,
    [schoolA, teacherStaff, yearA, sectionA, subjectId],
  )
  await pool.query(
    `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
     VALUES ($5,$1,$2,$3,$4,1,'2026-04-01')
     ON CONFLICT (id) DO UPDATE SET left_on = NULL, outcome = 'ongoing'`,
    [schoolA, studentA, yearA, sectionA, '10000000-0000-4000-8000-0000000019b1'],
  )
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  await adminPool().query('UPDATE auth_user SET email = $2 WHERE id = $1', [
    ownerUserId,
    OWNER_EMAIL,
  ])
  await seedModuleRows()
  await setFixturePassword(server, teacherUser, PASSWORD)
  owner = await signInWithMfa(server, {
    userId: ownerUserId,
    email: OWNER_EMAIL,
    password: PASSWORD,
  })
  teacher = await signInWithPassword(server, TEACHER_EMAIL, PASSWORD)
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [ownerUserId])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [ownerUserId])
  await server.close()
  await closeAdminPool()
})

/**
 * Each test gets its own telephone number: admission matches an existing
 * guardian of the school by number, so a shared one would carry another
 * test's edits.
 */
let phoneCounter = 0
function freshPhone(): string {
  phoneCounter += 1
  return `+9198123${String(45000 + phoneCounter).padStart(5, '0')}`
}

/** A new student with one new guardian, so each test owns its own records. */
async function admit(extra: Record<string, unknown> = {}, guardian: Record<string, unknown> = {}) {
  const response = await owner.fetch(`/api/schools/${schoolA}/students`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firstName: 'Ident',
      lastName: 'Child',
      dateOfBirth: '2015-06-01',
      gender: 'female',
      admissionDate: '2026-04-01',
      sectionId: sectionA,
      guardians: [
        {
          guardian: {
            firstName: 'Ident',
            lastName: 'Parent',
            phone: freshPhone(),
            ...guardian,
          },
          relation: 'father',
          isPrimary: true,
        },
      ],
      ...extra,
    }),
  })
  assert.equal(response.status, 201)
  return body<Basic>(response)
}

/** The guardian of a student, read back through the ordinary guardian list. */
async function guardianOf(studentId: string) {
  const list = await owner.fetch(`/api/schools/${schoolA}/students/${studentId}/guardians`)
  assert.equal(list.status, 200)
  const items = await body<Record<string, unknown>[]>(list)
  const first = items[0]
  assert.ok(first)
  return first
}

/** The current version of a student row, for a version-checked write. */
async function studentVersion(id: string): Promise<number> {
  const found = await adminPool().query<{ version: number }>(
    'SELECT version FROM students WHERE school_id = $1 AND id = $2',
    [schoolA, id],
  )
  const version = found.rows[0]?.version
  assert.ok(version !== undefined)
  return Number(version)
}

/**
 * A guardian's own version, which the contract needs for an edit but the
 * private projection quite rightly does not carry.
 */
async function guardianVersion(guardianId: string): Promise<number> {
  const found = await adminPool().query<{ version: number }>(
    'SELECT version FROM guardians WHERE school_id = $1 AND id = $2',
    [schoolA, guardianId],
  )
  const version = found.rows[0]?.version
  assert.ok(version !== undefined)
  return Number(version)
}

test('a whole Aadhaar number is accepted at admission and stored only sealed', async () => {
  const created = await admit({ aadhaar: AADHAAR })

  // Read with the migrator connection: the ciphertext column never leaves the
  // API, so this is the only way to prove the digits are not in the row.
  const stored = await adminPool().query<{
    aadhaar_ciphertext: string | null
    aadhaar_last4: string | null
  }>('SELECT aadhaar_ciphertext, aadhaar_last4 FROM students WHERE school_id = $1 AND id = $2', [
    schoolA,
    created.id,
  ])
  const row = stored.rows[0]
  assert.equal(row?.aadhaar_last4, '7919')
  assert.match(row?.aadhaar_ciphertext ?? '', /^v1\./)
  assert.equal((row?.aadhaar_ciphertext ?? '').includes(AADHAAR), false)
  // Not even the first eight digits survive anywhere in the row.
  assert.equal((row?.aadhaar_ciphertext ?? '').includes(AADHAAR.slice(0, 8)), false)
})

test('the sensitive read carries only the last four digits, never the number', async () => {
  const created = await admit({ aadhaar: AADHAAR })
  const detail = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}`)
  assert.equal(detail.status, 200)
  const text = await detail.text()
  assert.equal(text.includes(AADHAAR), false)
  const seen = JSON.parse(text) as { sensitive?: { aadhaarLast4?: string } }
  assert.equal(seen.sensitive?.aadhaarLast4, '7919')
})

test('spaces are allowed while typing and a bad checksum is refused plainly', async () => {
  const created = await admit()
  const spaced = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/sensitive`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: created.version, aadhaar: '2000 0000 7919' }),
  })
  assert.equal(spaced.status, 200)
  const stored = await adminPool().query<{ aadhaar_last4: string | null }>(
    'SELECT aadhaar_last4 FROM students WHERE school_id = $1 AND id = $2',
    [schoolA, created.id],
  )
  assert.equal(stored.rows[0]?.aadhaar_last4, '7919')

  const refused = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/sensitive`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: created.version + 1, aadhaar: BAD_AADHAAR }),
  })
  assert.equal(refused.status, 400)
  assert.equal(await codeOf(refused), 'INVALID_REQUEST')
  // Eleven digits are refused for the same plain reason.
  const short = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/sensitive`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: created.version + 1, aadhaar: '20000000791' }),
  })
  assert.equal(short.status, 400)
})

test('the Aadhaar number is revealed only once, audited, and never to a teacher', async () => {
  const created = await admit({ aadhaar: OTHER_AADHAAR })
  const revealed = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/aadhaar`)
  assert.equal(revealed.status, 200)
  assert.deepEqual(await body<{ aadhaar: string }>(revealed), { aadhaar: OTHER_AADHAAR })

  const audits = await adminPool().query<{ summary: string; safe_changes: unknown }>(
    `SELECT summary, safe_changes FROM audit_events
      WHERE school_id = $1 AND target_id = $2 AND action = 'students.read_sensitive'`,
    [schoolA, created.id],
  )
  assert.equal(audits.rowCount, 1)
  assert.equal(audits.rows[0]?.summary, 'Revealed the full Aadhaar number of a student.')
  // No digits in the audit trail, not even the last four.
  assert.equal(JSON.stringify(audits.rows[0]?.safe_changes ?? {}).includes('7127'), false)

  const refused = await teacher.fetch(`/api/schools/${schoolA}/students/${studentA}/aadhaar`)
  assert.equal(refused.status, 403)
  assert.equal(await codeOf(refused), 'ACCESS_DENIED')
})

test('a teacher reading the same student gets no sensitive block at all', async () => {
  const seen = await body<Record<string, unknown>>(
    await teacher.fetch(`/api/schools/${schoolA}/students/${studentA}`),
  )
  assert.equal('sensitive' in seen, false)
})

test('a null clears the number and its last four digits together', async () => {
  const created = await admit({ aadhaar: AADHAAR })
  const cleared = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/sensitive`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: created.version, aadhaar: null }),
  })
  assert.equal(cleared.status, 200)
  const stored = await adminPool().query<{
    aadhaar_ciphertext: string | null
    aadhaar_last4: string | null
  }>('SELECT aadhaar_ciphertext, aadhaar_last4 FROM students WHERE school_id = $1 AND id = $2', [
    schoolA,
    created.id,
  ])
  assert.equal(stored.rows[0]?.aadhaar_ciphertext, null)
  assert.equal(stored.rows[0]?.aadhaar_last4, null)
  // With nothing to show, the reveal route answers like a missing record.
  const gone = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/aadhaar`)
  assert.equal(gone.status, 404)
})

test('an audit row for a sensitive edit names the columns and holds no digits', async () => {
  const created = await admit()
  const update = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/sensitive`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: created.version, aadhaar: AADHAAR }),
  })
  assert.equal(update.status, 200)
  const audits = await adminPool().query<{ safe_changes: unknown }>(
    `SELECT safe_changes FROM audit_events
      WHERE school_id = $1 AND target_id = $2 AND action = 'students.update_sensitive'
      ORDER BY created_at DESC LIMIT 1`,
    [schoolA, created.id],
  )
  const written = JSON.stringify(audits.rows[0]?.safe_changes ?? {})
  assert.equal(written.includes(AADHAAR), false)
  // Not one run of four or more digits: no whole number and no last four.
  assert.equal(/\d{4}/.test(written), false)
  assert.ok(written.includes('aadhaar'))
})

test("a guardian's office address, PAN and Aadhaar round-trip as last digits only", async () => {
  const created = await admit(
    {},
    {
      occupation: 'Engineer',
      address: '12 Home Lane',
      officeAddress: '44 Office Road, Pune',
      pan: PAN,
      aadhaar: GUARDIAN_AADHAAR,
    },
  )
  const guardian = await guardianOf(created.id)
  assert.equal(guardian.officeAddress, '44 Office Road, Pune')
  assert.equal(guardian.panLast4, '234F')
  assert.equal(guardian.aadhaarLast4, '3408')
  // The whole numbers are not in the answer anywhere.
  const text = JSON.stringify(guardian)
  assert.equal(text.includes(PAN), false)
  assert.equal(text.includes(GUARDIAN_AADHAAR), false)

  const stored = await adminPool().query<{
    pan_ciphertext: string | null
    aadhaar_ciphertext: string | null
    office_address: string | null
  }>(
    `SELECT pan_ciphertext, aadhaar_ciphertext, office_address FROM guardians
      WHERE school_id = $1 AND id = $2`,
    [schoolA, guardian.id as string],
  )
  const row = stored.rows[0]
  assert.match(row?.pan_ciphertext ?? '', /^v1\./)
  assert.match(row?.aadhaar_ciphertext ?? '', /^v1\./)
  assert.equal((row?.pan_ciphertext ?? '').includes(PAN), false)
  assert.equal((row?.aadhaar_ciphertext ?? '').includes(GUARDIAN_AADHAAR), false)
  assert.equal(row?.office_address, '44 Office Road, Pune')
})

test('a guardian PAN that is not ten characters is refused', async () => {
  const response = await owner.fetch(`/api/schools/${schoolA}/students`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firstName: 'Ident',
      dateOfBirth: '2015-06-01',
      admissionDate: '2026-04-01',
      sectionId: sectionA,
      guardians: [
        {
          guardian: { firstName: 'Bad', phone: '+919812345678', pan: 'ABCD1234F' },
          relation: 'father',
          isPrimary: true,
        },
      ],
    }),
  })
  assert.equal(response.status, 400)
  assert.equal(await codeOf(response), 'INVALID_REQUEST')
})

test("a guardian's identity numbers are revealed once, audited, and can be cleared", async () => {
  const created = await admit({}, { pan: PAN, aadhaar: GUARDIAN_AADHAAR })
  const guardian = await guardianOf(created.id)
  const guardianId = guardian.id as string
  const url = `/api/schools/${schoolA}/students/${created.id}/guardians/${guardianId}/identity`

  const revealed = await owner.fetch(url)
  assert.equal(revealed.status, 200)
  assert.deepEqual(await body<Record<string, string>>(revealed), {
    pan: PAN,
    aadhaar: GUARDIAN_AADHAAR,
  })
  const audits = await adminPool().query<{ summary: string }>(
    `SELECT summary FROM audit_events
      WHERE school_id = $1 AND target_id = $2 AND action = 'students.read_guardians'`,
    [schoolA, guardianId],
  )
  assert.equal(audits.rowCount, 1)
  assert.equal(audits.rows[0]?.summary, 'Revealed the full identity numbers of a guardian.')

  // A teacher has no guardian read at all, so the same address is refused.
  const refused = await teacher.fetch(url)
  assert.equal(refused.status, 403)

  const cleared = await owner.fetch(
    `/api/schools/${schoolA}/students/${created.id}/guardians/${guardianId}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: await guardianVersion(guardianId),
        pan: null,
        aadhaar: null,
        officeAddress: null,
      }),
    },
  )
  assert.equal(cleared.status, 200)
  const stored = await adminPool().query<{
    pan_ciphertext: string | null
    pan_last4: string | null
    aadhaar_ciphertext: string | null
    aadhaar_last4: string | null
    office_address: string | null
  }>(
    `SELECT pan_ciphertext, pan_last4, aadhaar_ciphertext, aadhaar_last4, office_address
       FROM guardians WHERE school_id = $1 AND id = $2`,
    [schoolA, guardianId],
  )
  assert.deepEqual(stored.rows[0], {
    pan_ciphertext: null,
    pan_last4: null,
    aadhaar_ciphertext: null,
    aadhaar_last4: null,
    office_address: null,
  })
  // With neither number left there is nothing to reveal.
  assert.equal((await owner.fetch(url)).status, 404)
})

test('the subject access export opens the student\'s own number and masks a guardian\'s', async () => {
  const created = await admit(
    { aadhaar: AADHAAR },
    { officeAddress: '44 Office Road, Pune', pan: PAN, aadhaar: GUARDIAN_AADHAAR },
  )
  const response = await owner.fetch(
    `/api/schools/${schoolA}/students/${created.id}/subject-access`,
  )
  assert.equal(response.status, 200)
  const text = await response.text()
  // This copy is the student's own, so the student's own Aadhaar number is
  // whole. A guardian is a different person: their numbers stay masked.
  assert.equal(text.includes(AADHAAR), true)
  assert.equal(text.includes(GUARDIAN_AADHAAR), false)
  assert.equal(text.includes(PAN), false)
  const exported = JSON.parse(text) as {
    sensitive?: { aadhaar?: string; aadhaarLast4?: string }
    guardians: { officeAddress?: string; panLast4?: string; aadhaarLast4?: string }[]
  }
  assert.equal(exported.sensitive?.aadhaar, AADHAAR)
  assert.equal(exported.sensitive?.aadhaarLast4, undefined)
  const guardian = exported.guardians[0]
  assert.equal(guardian?.officeAddress, '44 Office Road, Pune')
  assert.equal(guardian?.panLast4, '234F')
  assert.equal(guardian?.aadhaarLast4, '3408')
})

test('anonymising a student clears the sealed Aadhaar number and the office fields', async () => {
  const created = await admit(
    { aadhaar: AADHAAR },
    { officeAddress: '44 Office Road, Pune', pan: PAN, aadhaar: GUARDIAN_AADHAAR },
  )
  const guardian = await guardianOf(created.id)
  const pool = adminPool()
  // Anonymisation is only offered once the person has left and the retention
  // period has run, so the row is aged here rather than waiting four years.
  await pool.query(
    `UPDATE students SET status = 'left', left_on = current_date - interval '4 years'
      WHERE school_id = $1 AND id = $2`,
    [schoolA, created.id],
  )
  const anonymised = await owner.fetch(
    `/api/schools/${schoolA}/students/${created.id}/anonymise`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: await studentVersion(created.id),
        reason: 'The retention period for this record has run.',
      }),
    },
  )
  assert.equal(anonymised.status, 200)

  const stored = await pool.query<{
    aadhaar_ciphertext: string | null
    aadhaar_last4: string | null
  }>('SELECT aadhaar_ciphertext, aadhaar_last4 FROM students WHERE school_id = $1 AND id = $2', [
    schoolA,
    created.id,
  ])
  assert.equal(stored.rows[0]?.aadhaar_ciphertext, null)
  assert.equal(stored.rows[0]?.aadhaar_last4, null)

  // This guardian belongs to nobody else, so their new fields go too.
  const orphan = await pool.query<{
    office_address: string | null
    pan_ciphertext: string | null
    pan_last4: string | null
    aadhaar_ciphertext: string | null
    aadhaar_last4: string | null
  }>(
    `SELECT office_address, pan_ciphertext, pan_last4, aadhaar_ciphertext, aadhaar_last4
       FROM guardians WHERE school_id = $1 AND id = $2`,
    [schoolA, guardian.id as string],
  )
  assert.deepEqual(orphan.rows[0], {
    office_address: null,
    pan_ciphertext: null,
    pan_last4: null,
    aadhaar_ciphertext: null,
    aadhaar_last4: null,
  })
})
