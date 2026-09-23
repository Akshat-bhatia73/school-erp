import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import { SubjectAccessExport } from '@erp/contracts'
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
const OWNER_EMAIL = `subject-owner-${randomUUID()}@example.test`
const PARENT_EMAIL = `subject-parent-${randomUUID()}@example.test`
const TEACHER_EMAIL = `subject-teacher-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const studentA = fixtureIds.studentA as string
const studentA2 = fixtureIds.studentA2 as string
const guardianA2 = fixtureIds.guardianA2 as string
const ownerUserId = fixtureIds.ownerAUser as string
const parentUserId = fixtureIds.parentA2User as string

// Rows this file owns.
const teacherUser = '10000000-0000-4000-8000-0000000009d1'
const teacherMembership = '10000000-0000-4000-8000-0000000009d2'
const feeHead = randomUUID()
const childReceipt = randomUUID()
const otherReceipt = randomUUID()
// A year of exams of the suite's own, so no other suite's exams share it.
const examYear = randomUUID()
const examSection = randomUUID()
const examSubject = randomUUID()
const examPt1 = randomUUID()
const examHalf = randomUUID()

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let parent: Client
let teacher: Client

function exportOf(client: Client, studentId: string): Promise<Response> {
  return client.fetch(`/api/schools/${schoolA}/students/${studentId}/subject-access`)
}

async function parsedExport(client: Client, studentId: string) {
  const response = await exportOf(client, studentId)
  const text = await response.text()
  assert.equal(response.status, 200, text)
  // The contract is strict, so parsing here is the assertion that nothing
  // unexpected left the server.
  return SubjectAccessExport.parse(JSON.parse(text))
}

async function auditRowsFor(studentId: string, action: string): Promise<number> {
  const result = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events
      WHERE school_id = $1 AND target_id = $2 AND action = $3`,
    [schoolA, studentId, action],
  )
  return Number(result.rows[0]?.count ?? '0')
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [parentUserId, PARENT_EMAIL])
  // A teacher of this school holds no export permission at all.
  await pool.query(
    `INSERT INTO auth_user(id,name,email) VALUES ($1,'Subject Teacher',$2)
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
  // A guardian with no telephone number on file: the export must still name
  // her, because a missing field is not a missing person.
  await pool.query(`UPDATE guardians SET phone = NULL WHERE id = $1`, [guardianA2])
  // A consent to export, recorded straight into the table so this file does
  // not depend on the consent routes.
  await pool.query(
    `INSERT INTO guardian_consents
       (school_id, student_id, guardian_id, purpose, status, method,
        recorded_by_membership_id)
     VALUES ($1, $2, $3, 'photographs', 'given', 'signed_form', $4)`,
    [schoolA, studentA2, guardianA2, fixtureIds.ownerA as string],
  )
  // Money, for both children. An export is the whole record, and the accounts
  // have to stand for eight years, so the fee statements belong in it.
  await pool.query(
    `INSERT INTO fee_heads(id,school_id,name,category,applies_to,frequency)
     VALUES ($1,$2,$3,'tuition','class','yearly')`,
    [feeHead, schoolA, `Subject access tuition ${randomUUID().slice(0, 8)}`],
  )
  for (const [receiptId, studentId, number] of [
    [childReceipt, studentA2, `A/SAR/${randomUUID().slice(0, 8)}/R0001`],
    [otherReceipt, studentA, `A/SAR/${randomUUID().slice(0, 8)}/R0002`],
  ] as const) {
    await pool.query(
      `INSERT INTO fee_receipts(id,school_id,student_id,academic_year_id,kind,receipt_number,
                                amount_paise,mode,received_on,payer_name,recorded_by_membership_id)
       VALUES ($1,$2,$3,$4,'payment',$5,450000,'cash','2026-04-10','Subject Payer',$6)`,
      [receiptId, schoolA, studentId, fixtureIds.yearA as string, number, fixtureIds.ownerA as string],
    )
    await pool.query(
      `INSERT INTO fee_receipt_lines(school_id,receipt_id,fee_head_id,amount_paise)
       VALUES ($1,$2,$3,450000)`,
      [schoolA, receiptId, feeHead],
    )
  }

  // Attendance, for both children. An export is the whole record, so the
  // marks belong in it, one block per academic year the pupil was enrolled.
  for (const studentId of [studentA2, studentA]) {
    await pool.query(
      `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,joined_on)
       VALUES ($1,$2,$3,$4,'2026-04-01') ON CONFLICT DO NOTHING`,
      [schoolA, studentId, fixtureIds.yearA as string, fixtureIds.sectionA as string],
    )
    for (const [date, mark] of [
      ['2026-04-06', 'present'],
      ['2026-04-07', 'absent'],
    ] as const) {
      await pool.query(
        `INSERT INTO attendance_entries(school_id,student_id,section_id,academic_year_id,date,mark,
                                        revision,kind,recorded_by_membership_id)
         VALUES ($1,$2,$3,$4,$5::date,$6,1,'marking',$7)`,
        [
          schoolA,
          studentId,
          fixtureIds.sectionA as string,
          fixtureIds.yearA as string,
          date,
          mark,
          fixtureIds.ownerA as string,
        ],
      )
    }
  }

  // Marks, for the parent's child: periodic test 1 is published, the
  // half-yearly exam is not. The export is the results screen's answer, so a
  // parent's copy carries the published exam alone.
  const suffix = randomUUID().slice(0, 8)
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,'2025-04-01','2026-03-31','closed')`,
    [examYear, schoolA, `SAR-${suffix}`],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,$5)`,
    [examSection, schoolA, examYear, fixtureIds.gradeA as string, `SAR-${suffix.slice(0, 4)}`],
  )
  await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,$3,$4,'scholastic')`, [
    examSubject,
    schoolA,
    `Subject access maths ${suffix}`,
    `SAR${suffix}`,
  ])
  await pool.query(
    `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,joined_on)
     VALUES ($1,$2,$3,$4,'2025-04-01')`,
    [schoolA, studentA2, examYear, examSection],
  )
  await pool.query(
    `INSERT INTO exams(id,school_id,academic_year_id,kind,starts_on,ends_on,recheck_deadline) VALUES
       ($1,$3,$4,'periodic_test_1','2025-05-05','2025-05-06','2025-05-10'),
       ($2,$3,$4,'half_yearly','2025-09-01','2025-09-10','2025-09-15')`,
    [examPt1, examHalf, schoolA, examYear],
  )
  for (const [examId, component, tenths] of [
    [examPt1, 'periodic_test', 70],
    [examHalf, 'written', 500],
  ] as const) {
    const paperId = randomUUID()
    await pool.query(
      `INSERT INTO exam_papers(id,school_id,exam_id,academic_year_id,section_id,subject_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [paperId, schoolA, examId, examYear, examSection, examSubject],
    )
    await pool.query(
      `INSERT INTO exam_marks (school_id, paper_id, exam_id, academic_year_id, section_id, subject_id, student_id,
                               component, status, marks_tenths, revision, kind, recorded_by_membership_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'marked',$9,1,'entry',$10)`,
      [schoolA, paperId, examId, examYear, examSection, examSubject, studentA2, component, tenths, fixtureIds.ownerA as string],
    )
  }
  await pool.query(
    `INSERT INTO exam_publications (school_id, exam_id, academic_year_id, section_id, published_by_membership_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [schoolA, examPt1, examYear, examSection, fixtureIds.ownerA as string],
  )

  await setFixturePassword(server, parentUserId, PASSWORD)
  await setFixturePassword(server, teacherUser, PASSWORD)
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })
  parent = await signInWithMfa(server, { userId: parentUserId, email: PARENT_EMAIL, password: PASSWORD })
  teacher = await signInWithPassword(server, TEACHER_EMAIL, PASSWORD)
})

after(async () => {
  const pool = adminPool()
  for (const userId of [ownerUserId, parentUserId]) {
    await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [userId])
    await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [userId])
  }
  await server.close()
  await closeAdminPool()
})

test('a parent exports her own child and receives no audit history', async () => {
  const result = await parsedExport(parent, studentA2)
  assert.equal(result.schoolId, schoolA)
  assert.equal(result.student.id, studentA2)
  assert.ok(result.student.admissionNumber.length > 0)
  // The parent may not read the audit trail, so the block is absent, not empty.
  assert.equal(result.accessHistory, undefined)
  // This guardian has no telephone number on file. An export is the whole
  // record, so she is named with the field left out, not left out herself.
  const guardian = result.guardians.find((row) => row.id === guardianA2)
  assert.ok(guardian, 'the linked guardian belongs in the export')
  assert.equal(guardian.phone, undefined)
  assert.ok(result.consents.some((consent) => consent.purpose === 'photographs'))
})

test('the export carries the fee statements of that child alone', async () => {
  const result = await parsedExport(parent, studentA2)
  assert.ok(result.fees !== undefined, 'a parent may read their own child\'s fees')
  assert.ok(result.fees.length > 0)
  const numbers = result.fees.flatMap((statement) =>
    statement.receipts.map((receipt) => receipt.id),
  )
  assert.ok(numbers.includes(childReceipt), 'the child\'s own receipt belongs in the export')
  assert.equal(numbers.includes(otherReceipt), false, 'another child\'s receipt never appears')
  // Every statement names the pupil the export is about.
  for (const statement of result.fees) assert.equal(statement.student.id, studentA2)
})

test('the export carries the attendance of that child alone', async () => {
  const result = await parsedExport(parent, studentA2)
  assert.ok(result.attendance !== undefined, 'a parent may read their own child\'s attendance')
  const year = result.attendance.find((record) => record.academicYear.id === (fixtureIds.yearA as string))
  assert.ok(year, 'the year the child was enrolled in is in the export')
  const marks = new Map(year.marks.map((mark) => [mark.date, mark.mark]))
  assert.equal(marks.get('2026-04-06'), 'present')
  assert.equal(marks.get('2026-04-07'), 'absent')
  // The summary follows the one percentage rule, over that year's school days.
  assert.ok(year.summary.schoolDays >= 2)
  assert.equal(year.summary.present, 1)
  assert.equal(year.summary.absent, 1)
  assert.equal(typeof year.summary.percentage, 'number')
})

test("a parent's export carries published marks only", async () => {
  const result = await parsedExport(parent, studentA2)
  assert.ok(result.exams !== undefined, "a parent may read their own child's results")
  const year = result.exams.find((answer) => answer.academicYear.id === examYear)
  assert.ok(year, 'the year the child has a published mark in is in the export')
  assert.equal(year.view, 'family')
  assert.deepEqual(
    year.exams.map((exam) => exam.exam.kind),
    ['periodic_test_1'],
    'the unpublished half-yearly exam is not in a parent\'s copy',
  )
  // No card is published, so the block is there and empty.
  assert.deepEqual(result.reportCards, [])
})

test("the owner's export carries the live marks of every exam", async () => {
  const result = await parsedExport(owner, studentA2)
  const year = result.exams?.find((answer) => answer.academicYear.id === examYear)
  assert.ok(year)
  assert.equal(year.view, 'staff')
  assert.deepEqual(
    year.exams.map((exam) => exam.exam.kind).sort(),
    ['half_yearly', 'periodic_test_1'],
  )
})

test('a parent is refused another family\'s child', async () => {
  const response = await exportOf(parent, studentA)
  assert.equal(response.status, 404)
})

test('the owner exports the whole record with the audit history', async () => {
  // The first export leaves the audit row the second one reports.
  await parsedExport(owner, studentA)
  const result = await parsedExport(owner, studentA)
  assert.equal(result.student.id, studentA)
  assert.ok(result.accessHistory !== undefined)
  assert.ok(result.accessHistory.length > 0)
  // The mask never appears in an export: a subject access answer is the value.
  assert.equal('apaarMasked' in (result.sensitive ?? {}), false)
  if (result.sensitive?.apaarId !== undefined) {
    assert.ok(!result.sensitive.apaarId.includes('*'))
  }
})

test('a teacher is refused at the gate', async () => {
  const response = await exportOf(teacher, studentA2)
  assert.equal(response.status, 403)
})

test("a refused teacher shows up in the child's own access history", async () => {
  const refused = await exportOf(teacher, studentA2)
  assert.equal(refused.status, 403)

  const result = await parsedExport(owner, studentA2)
  assert.ok(result.accessHistory !== undefined)
  assert.ok(
    result.accessHistory.some(
      (event) => event.outcome === 'denied' && event.action === 'students.export_subject',
    ),
    'the denied attempt names the student it was about',
  )
})

test('one export writes exactly one audit row', async () => {
  const before = await auditRowsFor(studentA2, 'students.export_subject')
  await parsedExport(parent, studentA2)
  assert.equal(await auditRowsFor(studentA2, 'students.export_subject'), before + 1)
})

test('an anonymised student exports the register fields only', async () => {
  // Anonymisation itself is tested by the lifecycle suite; this file only
  // needs a record in that state, so the flag is set directly.
  await adminPool().query(
    `UPDATE students SET anonymised_at = now(), version = version + 1 WHERE id = $1`,
    [studentA],
  )
  const result = await parsedExport(owner, studentA)
  assert.equal(result.student.anonymised, true)
  assert.ok(result.student.admissionNumber.length > 0)
  assert.equal(result.sensitive, undefined)
  assert.equal(result.medical, undefined)
  assert.deepEqual(result.guardians, [])
  assert.deepEqual(result.documents, [])
  assert.deepEqual(result.consents, [])
  // The money stays: the accounts outlive the personal record, so the
  // statements are still there once everything else has been cleared.
  assert.ok(result.fees !== undefined, 'an anonymised pupil still exports their fees')
  assert.ok(
    result.fees.some((statement) =>
      statement.receipts.some((receipt) => receipt.id === otherReceipt),
    ),
    'the ledger row of the anonymised pupil is still exported',
  )

  // The fixture is shared and this database is reused, so the record goes back
  // to being an ordinary student.
  await adminPool().query(
    `UPDATE students SET anonymised_at = NULL, version = version + 1 WHERE id = $1`,
    [studentA],
  )
})
