/**
 * Matrix rows: a pupil's own login (Task 23).
 *
 * A pupil in Class 9 to 12 reads their own learning record and nothing else.
 * This file signs a pupil in exactly as a pupil does (the office issues the
 * login, the password arrives by text, the pupil replaces it) and then asks
 * every route in "What a pupil reads" about three other pupils: a classmate
 * in the same section, a pupil of another section, and a pupil of the school
 * next door. Each one answers exactly like an id that was never real. The
 * routes a pupil holds no key for (fees, guardians, consents, documents,
 * staff, audit, exports and every write) never answer. An unpublished mark
 * stays hidden, and a login the office switched off takes the live session
 * with it.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { ROLE_TEMPLATES } from '@erp/contracts'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  clientFor,
  closeAdminPool,
  resetRateLimits,
  seedDatabaseFixtures,
  startTestServer,
  type TestServer,
} from '../../apps/api/tests/harness.ts'
import { body, createMember, postBody, putBody, signInOffice, type Client } from './support.ts'

const suffix = randomUUID().slice(0, 8)
const SCHOOL_CODE = `sec-sl-${suffix}`
const NEW_PASSWORD = 'Pupil-Chosen!2026'

const school = randomUUID()
const year = randomUUID()
const grade = randomUUID()
const sectionA = randomUUID()
const sectionB = randomUUID()
const maths = randomUUID()
const me = randomUUID()
const classmate = randomUUID()
const otherSection = randomUUID()
const studentB = fixtureIds.studentB as string
const schoolB = fixtureIds.schoolB as string

const publishedExam = randomUUID()
const unpublishedExam = randomUUID()
const paperPublished = randomUUID()
const paperUnpublished = randomUUID()
const myCard = randomUUID()
const classmateCard = randomUUID()
const guardianPhone = '+919876512345'

let server: TestServer
let office: Client
let officeMembership = ''
let pupil: Client
let myAdmission = ''
let today = ''

interface ErrorBody {
  error: { code: string; requestId?: string }
}

/** The error body with the per-request id taken out, so two refusals can be compared. */
async function refusal(response: Response): Promise<{ status: number; body: unknown }> {
  const text = await response.text()
  let parsed: unknown = text
  try {
    const json = JSON.parse(text) as ErrorBody
    delete json.error.requestId
    parsed = json
  } catch {
    // Not JSON: compare the text itself.
  }
  return { status: response.status, body: parsed }
}

async function mark(paperId: string, examId: string, sectionId: string, studentId: string, tenths: number): Promise<void> {
  await adminPool().query(
    `INSERT INTO exam_marks(school_id,paper_id,exam_id,academic_year_id,section_id,subject_id,student_id,
                            component,status,marks_tenths,revision,kind,recorded_by_membership_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'periodic_test','marked',$8,1,'entry',$9)`,
    [school, paperId, examId, year, sectionId, maths, studentId, tenths, officeMembership],
  )
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,'SSL')`, [
    school,
    SCHOOL_CODE,
    `Security Login School ${suffix}`,
  ])
  for (const [key, template] of Object.entries(ROLE_TEMPLATES)) {
    const role = await pool.query<{ id: string }>(
      `INSERT INTO roles(school_id,key,name,is_system) VALUES ($1,$2,$3,true) RETURNING id`,
      [school, key, template.displayName],
    )
    for (const grant of template.grants)
      await pool.query(
        `INSERT INTO role_permissions(school_id,role_id,permission,scope) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [school, role.rows[0]?.id, grant.permission, grant.scope],
      )
  }
  const found = await pool.query<{ today: string }>(`SELECT to_char(current_date, 'YYYY-MM-DD') AS today`)
  today = found.rows[0]?.today ?? ''
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,current_date - 150,current_date + 200,'current')`,
    [year, school, `SSL-${suffix}`],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [school, year])
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order,level) VALUES ($1,$2,'Class 9','9',9,9)`, [
    grade,
    school,
  ])
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,'A'),($5,$2,$3,$4,'B')`,
    [sectionA, school, year, grade, sectionB],
  )
  await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,'Maths',$3,'scholastic')`, [
    maths,
    school,
    `SSL${suffix}`,
  ])
  await pool.query(`INSERT INTO grade_subjects(school_id,grade_id,academic_year_id,subject_id) VALUES ($1,$2,$3,$4)`, [
    school,
    grade,
    year,
    maths,
  ])
  myAdmission = `SSL/${suffix}/1`
  for (const [index, [id, section]] of (
    [
      [me, sectionA],
      [classmate, sectionA],
      [otherSection, sectionB],
    ] as const
  ).entries()) {
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,$4,'Pupil','active')`,
      [id, school, `SSL/${suffix}/${index + 1}`, `Pupil${index}`],
    )
    await pool.query(
      `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,roll_number,joined_on) VALUES ($1,$2,$3,$4,$5,current_date - 150)`,
      [school, id, year, section, index + 1],
    )
    const guardian = randomUUID()
    await pool.query(`INSERT INTO guardians(id,school_id,first_name,phone) VALUES ($1,$2,'Guardian',$3)`, [
      guardian,
      school,
      index === 0 ? guardianPhone : `+91987650000${index}`,
    ])
    await pool.query(
      `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation,is_primary) VALUES ($1,$2,$3,'father',true)`,
      [school, id, guardian],
    )
  }

  const owner = await createMember(school, ['owner'], 'Security login owner')
  officeMembership = owner.membershipId
  office = await signInOffice(server, owner)

  // One exam published for section A, one with marks nobody has published.
  for (const [examId, kind, offset] of [
    [publishedExam, 'periodic_test_1', -60],
    [unpublishedExam, 'half_yearly', -20],
  ] as const) {
    await pool.query(
      `INSERT INTO exams(id,school_id,academic_year_id,kind,starts_on,ends_on,recheck_deadline)
       VALUES ($1,$2,$3,$4,current_date + $5::int,current_date + $5::int + 2,current_date + $5::int + 10)`,
      [examId, school, year, kind, offset],
    )
  }
  for (const [paperId, examId] of [
    [paperPublished, publishedExam],
    [paperUnpublished, unpublishedExam],
  ] as const)
    await pool.query(
      `INSERT INTO exam_papers(id,school_id,exam_id,academic_year_id,section_id,subject_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [paperId, school, examId, year, sectionA, maths],
    )
  await mark(paperPublished, publishedExam, sectionA, me, 80)
  await mark(paperPublished, publishedExam, sectionA, classmate, 60)
  await pool.query(
    `INSERT INTO exam_publications(school_id,exam_id,academic_year_id,section_id,published_by_membership_id) VALUES ($1,$2,$3,$4,$5)`,
    [school, publishedExam, year, sectionA, officeMembership],
  )
  // Written after the publication, so these marks are not published.
  await new Promise((resolve) => setTimeout(resolve, 20))
  await pool.query(
    `INSERT INTO exam_marks(school_id,paper_id,exam_id,academic_year_id,section_id,subject_id,student_id,
                            component,status,marks_tenths,revision,kind,recorded_by_membership_id)
     SELECT $1,$2,$3,$4,$5,$6,$7,c,'marked',t,1,'entry',$8
       FROM unnest(ARRAY['notebook','subject_enrichment','written'], ARRAY[43,37,777]) AS m(c,t)`,
    [school, paperUnpublished, unpublishedExam, year, sectionA, maths, me, officeMembership],
  )
  for (const [id, studentId] of [
    [myCard, me],
    [classmateCard, classmate],
  ] as const)
    await pool.query(
      `INSERT INTO report_card_versions(id,school_id,student_id,academic_year_id,section_id,card,version_number,
                                        content,content_hash,published_by_membership_id)
       VALUES ($1,$2,$3,$4,$5,'term_1',1,'{}'::jsonb,$6,$7)`,
      [id, school, studentId, year, sectionA, `sec-login-${suffix}-${id.slice(0, 8)}-0123456789`, officeMembership],
    )

  // The office issues the login; the password arrives by text; the pupil replaces it.
  const issued = await office.fetch(`/api/schools/${school}/students/${me}/login`, postBody({}))
  assert.equal(issued.status, 201, await issued.text())
  const text = server.delivery.outbox.filter((message) => message.to === guardianPhone && message.purpose === 'student_password').at(-1)
  assert.ok(text)
  await resetRateLimits()
  pupil = clientFor(server)
  const signed = await pupil.fetch(
    '/api/student-sign-in',
    postBody({ schoolCode: SCHOOL_CODE, admissionNumber: myAdmission, password: text.secret }),
  )
  assert.equal(signed.status, 200, await signed.text())
  const changed = await pupil.fetch(
    '/api/auth/change-password',
    postBody({ currentPassword: text.secret, newPassword: NEW_PASSWORD }),
  )
  assert.equal(changed.status, 200, await changed.text())
})

after(async () => {
  await server.close()
  await closeAdminPool()
})

const s = (rest: string, schoolId: string = school) => `/api/schools/${schoolId}${rest}`
const month = () => today.slice(0, 7)

/** Every read in "What a pupil reads" that names one pupil. */
const pupilReads = (studentId: string, schoolId: string = school): string[] => [
  s(`/students/${studentId}`, schoolId),
  s(`/students/${studentId}/enrollments`, schoolId),
  s(`/attendance/students/${studentId}/months/${month()}`, schoolId),
  s(`/exams/students/${studentId}/results?academicYearId=${year}`, schoolId),
  s(`/report-cards/students/${studentId}?academicYearId=${year}`, schoolId),
]

test('[student login] a pupil reads their own record, class, timetable, attendance, results and cards', async () => {
  for (const path of [
    ...pupilReads(me),
    s(`/sections/${sectionA}`),
    s(`/timetable/sections/${sectionA}?academicYearId=${year}`),
    s('/dashboard'),
    s('/holidays'),
    s('/messages/inbox'),
  ]) {
    const response = await pupil.fetch(path)
    assert.equal(response.status, 200, `${path}: ${await response.text()}`)
  }
  // Lists hold the pupil and the pupil's class only.
  const students = await body<{ items: { id: string }[] }>(await pupil.fetch(s('/students')))
  assert.deepEqual(students.items.map((row) => row.id), [me])
  const sections = await body<{ items?: { id: string }[] } | { id: string }[]>(await pupil.fetch(s('/sections')))
  const sectionIds = (Array.isArray(sections) ? sections : (sections.items ?? [])).map((row) => row.id)
  assert.deepEqual(sectionIds, [sectionA])
  // The pupil's cards list their own published card and nobody else's.
  // (The card's content here is a placeholder, so it is not opened.)
  const cards = JSON.stringify(await body(await pupil.fetch(s(`/report-cards/students/${me}?academicYearId=${year}`))))
  assert.ok(cards.includes(myCard))
  assert.ok(!cards.includes(classmateCard))
  // The command-menu search finds the pupil and no classmate.
  const search = await body<{ students: { id: string }[]; staff: unknown[] }>(await pupil.fetch(s('/search?q=Pupil')))
  assert.deepEqual(search.students.map((row) => row.id), [me])
  assert.deepEqual(search.staff, [])
})

test('[student login] another pupil, in the same section, another section or another school, reads like an id that was never real', async () => {
  const unknown = randomUUID()
  for (const [index, path] of pupilReads(unknown).entries()) {
    const missing = await refusal(await pupil.fetch(path))
    assert.equal(missing.status, 404, path)
    for (const other of [classmate, otherSection, studentB]) {
      const otherPath = pupilReads(other)[index] as string
      assert.deepEqual(await refusal(await pupil.fetch(otherPath)), missing, otherPath)
    }
  }
  const missingSection = await refusal(await pupil.fetch(s(`/sections/${randomUUID()}`)))
  assert.equal(missingSection.status, 404)
  assert.deepEqual(await refusal(await pupil.fetch(s(`/sections/${sectionB}`))), missingSection)
  const missingTimetable = await refusal(await pupil.fetch(s(`/timetable/sections/${randomUUID()}?academicYearId=${year}`)))
  assert.deepEqual(await refusal(await pupil.fetch(s(`/timetable/sections/${sectionB}?academicYearId=${year}`))), missingTimetable)
  const missingCard = await refusal(await pupil.fetch(s(`/report-cards/versions/${randomUUID()}`)))
  assert.equal(missingCard.status, 404)
  assert.deepEqual(await refusal(await pupil.fetch(s(`/report-cards/versions/${classmateCard}`))), missingCard)
  // The school next door is not the pupil's school at all.
  for (const path of pupilReads(studentB, schoolB)) {
    const response = await pupil.fetch(path)
    assert.equal(response.status, 403, path)
    assert.equal((await body<ErrorBody>(response)).error.code, 'SCHOOL_ACCESS_UNAVAILABLE')
  }
})

test('[student login] a pupil sees published results only, never an unpublished mark', async () => {
  const results = await body<{ exams: { exam: { id: string } }[] }>(await pupil.fetch(s(`/exams/students/${me}/results?academicYearId=${year}`)))
  const examIds = results.exams.map((entry) => entry.exam.id)
  assert.ok(examIds.includes(publishedExam))
  assert.ok(!examIds.includes(unpublishedExam))
  assert.ok(!JSON.stringify(results).includes('77.7'), 'an unpublished figure must not appear')
  for (const path of [
    s(`/exams/papers/${paperUnpublished}`),
    s(`/exams/papers/${paperPublished}`),
    s(`/exams/papers/${paperUnpublished}/students/${me}/history?component=written`),
  ]) {
    const response = await pupil.fetch(path)
    assert.ok(response.status === 403 || response.status === 404, `${path}: ${response.status}`)
  }
})

test('[student login] no fee, guardian, consent, document, staff, audit, export or write route answers a pupil', async () => {
  const routes: [string, string, RequestInit?][] = [
    ['fees statement', s(`/fees/students/${me}/statement`)],
    ['fee dues', s('/fees/dues')],
    ['fee receipts', s('/fees/receipts')],
    ['guardians', s(`/students/${me}/guardians`)],
    ['siblings', s(`/students/${me}/siblings`)],
    ['consents', s(`/students/${me}/consents`)],
    ['documents', s(`/students/${me}/documents`)],
    ['aadhaar', s(`/students/${me}/aadhaar`)],
    ['subject access', s(`/students/${me}/subject-access`)],
    ['staff', s('/staff')],
    ['audit', s('/audit-events')],
    ['own login', s(`/students/${me}/login`)],
    ['export students', s('/students/export'), postBody({ studentIds: [me] })],
    ['export report card', s(`/report-cards/versions/${myCard}/export`), postBody({})],
    ['edit own record', s(`/students/${me}`), putBody({ expectedVersion: 1, firstName: 'Changed' })],
    ['write a message', s('/messages'), postBody({ audience: { kind: 'section', sectionId: sectionA }, title: 'Hi', body: 'Hi.' })],
    ['issue logins', s('/students/logins/issue'), postBody({})],
    ['mark attendance', s(`/attendance/sections/${sectionA}/days/${today}`), putBody({ expectedVersion: 0, marks: [] })],
    ['add a holiday', s('/holidays'), postBody({ name: 'Mine', date: today })],
  ]
  for (const [label, path, init] of routes) {
    const response = await pupil.fetch(path, init)
    const text = await response.text()
    assert.ok(response.status === 403 || response.status === 404, `${label}: ${response.status} ${text}`)
  }
  const record = await adminPool().query<{ first_name: string }>('SELECT first_name FROM students WHERE id = $1', [me])
  assert.equal(record.rows[0]?.first_name, 'Pupil0')
})

test('[student login] a pupil whose login is switched off loses the live session at the next request', async () => {
  const view = await body<{ version: number }>(await office.fetch(s(`/students/${me}/login`)))
  const off = await office.fetch(s(`/students/${me}/login/switch-off`), postBody({ expectedVersion: view.version }))
  assert.equal(off.status, 200, await off.text())
  const refused = await pupil.fetch(s(`/students/${me}`))
  assert.ok(refused.status === 401 || refused.status === 403, `answered ${refused.status}`)
  const me2 = await pupil.fetch('/api/me')
  assert.equal(me2.status, 401)
  await resetRateLimits()
  const again = await clientFor(server).fetch(
    '/api/student-sign-in',
    postBody({ schoolCode: SCHOOL_CODE, admissionNumber: myAdmission, password: NEW_PASSWORD }),
  )
  assert.equal(again.status, 401)
})
