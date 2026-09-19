import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
  signInWithMfa,
  startTestServer,
  type TestServer,
} from './harness.ts'

const PASSWORD = 'Fixture-Pass!42'
const OWNER_EMAIL = `lifecycle-owner-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const ownerUserId = fixtureIds.ownerAUser as string

// Every row below belongs to this file, so nothing here depends on what
// another module test left in the shared database.
const leaver = randomUUID()
const sibling = randomUUID()
const orphanGuardian = randomUUID()
const sharedGuardian = randomUUID()
const leaverDocument = randomUUID()
const STORAGE_KEY = `lifecycle/${randomUUID()}.pdf`

const unlinkStudent = randomUUID()
const unlinkGuardian1 = randomUUID()
const unlinkGuardian2 = randomUUID()

const retiree = randomUUID()

const soleUser = randomUUID()
const soleMembership = randomUUID()
const dualUser = randomUUID()
const dualMembershipA = randomUUID()
const dualMembershipB = randomUUID()

let server: TestServer
let owner: Awaited<ReturnType<typeof signInWithMfa>>

interface ErrorBody {
  error: { code: string }
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as ErrorBody).error.code
}

async function versionOf(table: 'students' | 'staff', id: string): Promise<number> {
  const rows = await adminPool().query<{ version: number }>(
    `SELECT version FROM ${table} WHERE id = $1`,
    [id],
  )
  return Number(rows.rows[0]?.version)
}

function post(payload: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])

  await pool.query(
    `INSERT INTO students(id,school_id,admission_number,first_name,last_name,status,
        date_of_birth,gender,blood_group,category,religion,mother_tongue,nationality,
        aadhaar_last4,apaar_last4,apaar_ciphertext,previous_school,medical_notes,house,
        admission_date,admission_type,left_on,left_reason,address)
     VALUES ($1,$2,$3,'Leaver','Record','left','2010-05-05','male','O+','general','none','Hindi',
        'Indian','1234','9876','v1.x.y.z','Old School','Peanut allergy','Blue','2020-04-01',
        'regular',current_date - interval '1 year','Family moved',to_jsonb('7 Old Road'::text)),
        ($4,$2,$5,'Sibling','Record','active',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
        NULL,NULL,NULL,'2020-04-01','regular',NULL,NULL,NULL)`,
    [leaver, schoolA, `A/LC/${randomUUID().slice(0, 8)}`, sibling, `A/LC/${randomUUID().slice(0, 8)}`],
  )
  await pool.query(
    `INSERT INTO guardians(id,school_id,first_name,last_name,phone,email,occupation,address)
     VALUES ($1,$2,'Orphan','Guardian','+919812345601','orphan@test','Clerk',to_jsonb('7 Old Road'::text)),
            ($3,$2,'Shared','Guardian','+919812345602','shared@test','Clerk',to_jsonb('7 Old Road'::text))`,
    [orphanGuardian, schoolA, sharedGuardian],
  )
  await pool.query(
    `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation)
     VALUES ($1,$2,$3,'guardian'),($1,$2,$4,'guardian'),($1,$5,$4,'guardian')`,
    [schoolA, leaver, orphanGuardian, sharedGuardian, sibling],
  )
  await pool.query(
    `INSERT INTO student_documents(id,school_id,student_id,document_type,file_name,storage_key,size_bytes)
     VALUES ($1,$2,$3,'birth_certificate','birth.pdf',$4,3)`,
    [leaverDocument, schoolA, leaver, STORAGE_KEY],
  )
  server.documents.put(STORAGE_KEY, new Uint8Array([1, 2, 3]))

  // A student who is still here, for the unlink rules.
  await pool.query(
    `INSERT INTO students(id,school_id,admission_number,first_name,status)
     VALUES ($1,$2,$3,'Unlink','active')`,
    [unlinkStudent, schoolA, `A/LC/${randomUUID().slice(0, 8)}`],
  )
  await pool.query(
    `INSERT INTO guardians(id,school_id,first_name,phone) VALUES ($1,$2,'First','+919812345603'),($3,$2,'Second','+919812345604')`,
    [unlinkGuardian1, schoolA, unlinkGuardian2],
  )
  await pool.query(
    `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation)
     VALUES ($1,$2,$3,'father'),($1,$2,$4,'mother')`,
    [schoolA, unlinkStudent, unlinkGuardian1, unlinkGuardian2],
  )

  await pool.query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,last_name,staff_type,designation,
        department,employment_type,joining_date,leaving_date,status,phone,email,address,
        date_of_birth,gender,blood_group,monthly_salary,bank_account_last4,pan_last4,qualification)
     VALUES ($1,$2,$3,'Retired','Teacher','teaching','Teacher','Science','permanent','2001-04-01',
        current_date - interval '1 year','retired','+919812345605','retired@test',
        to_jsonb('9 Staff Lane'::text),'1960-01-01','female','B+',42000,'4321','ZZZZ','MSc')`,
    [retiree, schoolA, `A-LC-${randomUUID().slice(0, 6)}`],
  )

  // One member of this school only, and one who also belongs to school B.
  await pool.query(
    `INSERT INTO auth_user(id,name,email) VALUES ($1,'Sole School',$2),($3,'Two Schools',$4)`,
    [soleUser, `lifecycle-sole-${randomUUID()}@example.test`, dualUser, `lifecycle-dual-${randomUUID()}@example.test`],
  )
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status)
     VALUES ($1,$2,$3,'adult','active'),($4,$2,$5,'adult','active'),($6,$7,$5,'adult','active')`,
    [soleMembership, schoolA, soleUser, dualMembershipA, dualUser, dualMembershipB, schoolB],
  )
  for (const [membership, school] of [
    [soleMembership, schoolA],
    [dualMembershipA, schoolA],
    [dualMembershipB, schoolB],
  ]) {
    await pool.query(
      `INSERT INTO membership_roles(school_id,membership_id,role_id)
       SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = 'teacher'`,
      [school, membership],
    )
  }
  await pool.query(
    `INSERT INTO auth_session(user_id,token,expires_at) VALUES ($1,$2,now() + interval '1 day'),($3,$4,now() + interval '1 day')`,
    [soleUser, randomUUID(), dualUser, randomUUID()],
  )

  owner = await signInWithMfa(server, {
    userId: ownerUserId,
    email: OWNER_EMAIL,
    password: PASSWORD,
  })
})

after(async () => {
  // Every row this file inserted goes again, so a file that runs after it in
  // the same database sees only what it seeded itself.
  const pool = adminPool()
  await pool.query('DELETE FROM student_documents WHERE id = $1', [leaverDocument])
  await pool.query('DELETE FROM student_guardians WHERE student_id = ANY($1::uuid[])', [
    [leaver, sibling, unlinkStudent],
  ])
  await pool.query('DELETE FROM guardians WHERE id = ANY($1::uuid[])', [
    [orphanGuardian, sharedGuardian, unlinkGuardian1, unlinkGuardian2],
  ])
  await pool.query('DELETE FROM students WHERE id = ANY($1::uuid[])', [[leaver, sibling, unlinkStudent]])
  await pool.query('DELETE FROM staff WHERE id = $1', [retiree])
  await pool.query('DELETE FROM membership_roles WHERE membership_id = ANY($1::uuid[])', [
    [soleMembership, dualMembershipA, dualMembershipB],
  ])
  await pool.query('DELETE FROM school_memberships WHERE id = ANY($1::uuid[])', [
    [soleMembership, dualMembershipA, dualMembershipB],
  ])
  await pool.query('DELETE FROM auth_session WHERE user_id = ANY($1::uuid[])', [[soleUser, dualUser]])
  await pool.query('DELETE FROM auth_user WHERE id = ANY($1::uuid[])', [[soleUser, dualUser]])
  await server.close()
  await closeAdminPool()
})

test('a student who is still enrolled cannot be anonymised', async () => {
  await adminPool().query(`UPDATE students SET status = 'active' WHERE id = $1`, [leaver])
  const response = await owner.fetch(
    `/api/schools/${schoolA}/students/${leaver}/anonymise`,
    post({ expectedVersion: await versionOf('students', leaver), reason: 'Too early' }),
  )
  assert.equal(await codeOf(response), 'NOT_ALLOWED_YET')
  await adminPool().query(`UPDATE students SET status = 'left' WHERE id = $1`, [leaver])
})

test('a student who left last year is still inside the retention period', async () => {
  const response = await owner.fetch(
    `/api/schools/${schoolA}/students/${leaver}/anonymise`,
    post({ expectedVersion: await versionOf('students', leaver), reason: 'Too early' }),
  )
  assert.equal(await codeOf(response), 'NOT_ALLOWED_YET')
  const stored = await adminPool().query('SELECT date_of_birth FROM students WHERE id = $1', [leaver])
  assert.notEqual(stored.rows[0].date_of_birth, null)
})

test('after the retention period the record keeps its register fields and nothing else', async () => {
  await adminPool().query(
    `UPDATE students SET left_on = current_date - interval '4 years' WHERE id = $1`,
    [leaver],
  )
  const response = await owner.fetch(
    `/api/schools/${schoolA}/students/${leaver}/anonymise`,
    post({ expectedVersion: await versionOf('students', leaver), reason: 'Retention period has run' }),
  )
  assert.equal(response.status, 200)
  const detail = (await response.json()) as { student: { anonymised: boolean; admissionNumber: string } }
  assert.equal(detail.student.anonymised, true)

  const row = (
    await adminPool().query(
      `SELECT first_name, admission_number, status, admission_date, admission_type, date_of_birth,
              gender, blood_group, category, religion, mother_tongue, nationality, aadhaar_last4,
              apaar_last4, apaar_ciphertext, address, previous_school, left_reason, medical_notes,
              house, anonymised_at
         FROM students WHERE id = $1`,
      [leaver],
    )
  ).rows[0]
  assert.equal(row.first_name, 'Leaver')
  assert.equal(row.admission_number, detail.student.admissionNumber)
  assert.equal(row.status, 'left')
  assert.notEqual(row.admission_date, null)
  assert.equal(row.admission_type, 'regular')
  assert.notEqual(row.anonymised_at, null)
  for (const column of [
    'date_of_birth', 'gender', 'blood_group', 'category', 'religion', 'mother_tongue',
    'nationality', 'aadhaar_last4', 'apaar_last4', 'apaar_ciphertext', 'address',
    'previous_school', 'left_reason', 'medical_notes', 'house',
  ]) {
    assert.equal(row[column], null, `${column} should have been cleared`)
  }

  const document = (
    await adminPool().query('SELECT file_name, storage_key FROM student_documents WHERE id = $1', [
      leaverDocument,
    ])
  ).rows[0]
  assert.equal(document.file_name, '')
  assert.equal(document.storage_key, '')
  assert.equal(await server.documents.read(STORAGE_KEY), null)

  const guardians = await adminPool().query<{ id: string; first_name: string; phone: string | null; anonymised_at: string | null }>(
    'SELECT id, first_name, phone, anonymised_at FROM guardians WHERE id = ANY($1::uuid[])',
    [[orphanGuardian, sharedGuardian]],
  )
  const orphan = guardians.rows.find((g) => g.id === orphanGuardian)
  const shared = guardians.rows.find((g) => g.id === sharedGuardian)
  assert.equal(orphan?.first_name, 'Former guardian')
  assert.equal(orphan?.phone, null)
  assert.notEqual(orphan?.anonymised_at, null)
  assert.equal(shared?.first_name, 'Shared')
  assert.equal(shared?.phone, '+919812345602')
  assert.equal(shared?.anonymised_at, null)

  const audit = await adminPool().query<{ safe_changes: Record<string, unknown>; note: string | null }>(
    `SELECT e.safe_changes, n.note FROM audit_events e
       LEFT JOIN audit_event_notes n ON n.school_id = e.school_id AND n.audit_event_id = e.id
      WHERE e.school_id = $1 AND e.action = 'students.anonymise' AND e.target_id = $2`,
    [schoolA, leaver],
  )
  assert.equal(audit.rowCount, 1)
  assert.equal(audit.rows[0]?.note, 'Retention period has run')
  assert.equal('reason' in (audit.rows[0]?.safe_changes ?? {}), false)
})

test('unlinking a guardian anonymises them and the last one cannot be removed', async () => {
  const first = await owner.fetch(
    `/api/schools/${schoolA}/students/${unlinkStudent}/guardians/${unlinkGuardian1}/unlink`,
    post({ expectedVersion: await versionOf('students', unlinkStudent), reason: 'No longer a guardian' }),
  )
  assert.equal(first.status, 200)
  const gone = await adminPool().query('SELECT first_name, phone, anonymised_at FROM guardians WHERE id = $1', [
    unlinkGuardian1,
  ])
  assert.equal(gone.rows[0].first_name, 'Former guardian')
  assert.equal(gone.rows[0].phone, null)
  assert.notEqual(gone.rows[0].anonymised_at, null)

  const last = await owner.fetch(
    `/api/schools/${schoolA}/students/${unlinkStudent}/guardians/${unlinkGuardian2}/unlink`,
    post({ expectedVersion: await versionOf('students', unlinkStudent), reason: 'Leaves nobody to call' }),
  )
  assert.equal(await codeOf(last), 'NOT_ALLOWED_YET')
  const kept = await adminPool().query(
    'SELECT count(*)::int AS links FROM student_guardians WHERE student_id = $1',
    [unlinkStudent],
  )
  assert.equal(kept.rows[0].links, 1)
})

test('a staff record is anonymised only eight years after they left', async () => {
  const early = await owner.fetch(
    `/api/schools/${schoolA}/staff/${retiree}/anonymise`,
    post({ expectedVersion: await versionOf('staff', retiree), reason: 'Too early' }),
  )
  assert.equal(await codeOf(early), 'NOT_ALLOWED_YET')

  await adminPool().query(
    `UPDATE staff SET leaving_date = current_date - interval '9 years' WHERE id = $1`,
    [retiree],
  )
  const response = await owner.fetch(
    `/api/schools/${schoolA}/staff/${retiree}/anonymise`,
    post({ expectedVersion: await versionOf('staff', retiree), reason: 'Retention period has run' }),
  )
  assert.equal(response.status, 200)
  const detail = (await response.json()) as {
    staff: { anonymised: boolean; displayName: string }
    employment?: unknown
    private?: unknown
    pay?: unknown
  }
  assert.equal(detail.staff.anonymised, true)
  assert.equal(detail.staff.displayName, 'Retired Teacher')
  assert.ok(detail.employment)
  assert.equal(detail.private, undefined)
  assert.equal(detail.pay, undefined)

  const row = (
    await adminPool().query(
      `SELECT employee_code, designation, department, joining_date, status, phone, email, address,
              date_of_birth, gender, blood_group, monthly_salary, bank_account_last4, pan_last4,
              qualification, anonymised_at
         FROM staff WHERE id = $1`,
      [retiree],
    )
  ).rows[0]
  assert.equal(row.designation, 'Teacher')
  assert.equal(row.department, 'Science')
  assert.equal(row.status, 'retired')
  assert.notEqual(row.joining_date, null)
  assert.notEqual(row.anonymised_at, null)
  for (const column of [
    'phone', 'email', 'address', 'date_of_birth', 'gender', 'blood_group',
    'monthly_salary', 'bank_account_last4', 'pan_last4', 'qualification',
  ]) {
    assert.equal(row[column], null, `${column} should have been cleared`)
  }
})

test('removing the only membership a person has ends their sessions', async () => {
  const version = (
    await adminPool().query<{ version: number }>('SELECT version FROM school_memberships WHERE id = $1', [
      soleMembership,
    ])
  ).rows[0]?.version
  const response = await owner.fetch(
    `/api/schools/${schoolA}/members/${soleMembership}/remove`,
    post({ expectedVersion: Number(version), reason: 'Left the school' }),
  )
  assert.equal(response.status, 200)
  const sessions = await adminPool().query<{ count: number }>(
    'SELECT count(*)::int AS count FROM auth_session WHERE user_id = $1',
    [soleUser],
  )
  assert.equal(sessions.rows[0]?.count, 0)
})

test('a member who still belongs to another school keeps their sessions', async () => {
  const version = (
    await adminPool().query<{ version: number }>('SELECT version FROM school_memberships WHERE id = $1', [
      dualMembershipA,
    ])
  ).rows[0]?.version
  const response = await owner.fetch(
    `/api/schools/${schoolA}/members/${dualMembershipA}/remove`,
    post({ expectedVersion: Number(version), reason: 'Moved to the other school full time' }),
  )
  assert.equal(response.status, 200)
  const sessions = await adminPool().query<{ count: number }>(
    'SELECT count(*)::int AS count FROM auth_session WHERE user_id = $1',
    [dualUser],
  )
  assert.equal(sessions.rows[0]?.count, 1)
})
