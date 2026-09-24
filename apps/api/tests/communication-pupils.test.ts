/**
 * Messages to pupils (Task 23): `recipients` on every audience made of pupils,
 * the `grade_range` audience, and the pupil's own inbox.
 *
 * The suite builds a school of its own: Class 6, Class 9 (two sections),
 * Class 10 and Class 11. Three pupils have a login of their own (9 A, 9 B and
 * 10 A); two do not. One family has an account and agreed to messages. A
 * notice goes to families, pupils or both; a pupil reads only what was
 * addressed to them, and a guardian never reads a notice to the pupils only.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { ROLE_TEMPLATES } from '@erp/contracts'
import {
  adminPool,
  clientFor,
  closeAdminPool,
  resetRateLimits,
  seedDatabaseFixtures,
  setFixturePassword,
  signInWithMfa,
  signInWithPassword,
  startTestServer,
  type TestServer,
} from './harness.ts'

const PASSWORD = 'Fixture-Pass!42'
const PUPIL_PASSWORD = 'Pupil-Pass!2026'
const suffix = randomUUID().slice(0, 8)
const SCHOOL_CODE = `cp-${suffix}`

const school = randomUUID()
const year = randomUUID()
const grade6 = randomUUID()
const grade9 = randomUUID()
const grade10 = randomUUID()
const grade11 = randomUUID()
const section6 = randomUUID()
const section9a = randomUUID()
const section9b = randomUUID()
const section10 = randomUUID()
const section11 = randomUUID()

const pupil9a = randomUUID()
const pupil9aNoLogin = randomUUID()
const pupil9b = randomUUID()
const pupil10 = randomUUID()
const pupil11 = randomUUID()
const pupil6 = randomUUID()
const pupilMembership: Record<string, string> = {}

let server: TestServer
type Client = ReturnType<typeof clientFor>
let owner: Client
let teacher: Client
let parent: Client
const pupils: Record<string, Client> = {}

interface ErrorBody {
  error: { code: string; reason?: string }
}
interface Detail {
  id: string
  version: number
  status: string
  audience: { kind: string; label: string; recipients?: string; gradeId?: string; toGradeId?: string }
  counts?: Record<string, number>
}
interface RecipientRow {
  guardian_id: string | null
  student_id: string | null
  is_student: boolean
  membership_id: string | null
  outcome: string
  in_app: boolean
  email_status: string
}

const path = (rest: string) => `/api/schools/${school}/messages${rest}`

function send(method: string, value: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
}

async function ok<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text()
  assert.equal(response.status, status, text)
  return (text ? JSON.parse(text) : null) as T
}

async function draft(client: Client, audience: unknown, title = 'Science fair'): Promise<Detail> {
  return ok<Detail>(await client.fetch(path(''), send('POST', { audience, title, body: 'The science fair is on Friday.' })), 201)
}

async function sent(client: Client, audience: unknown, title?: string): Promise<Detail> {
  const message = await draft(client, audience, title)
  return ok<Detail>(await client.fetch(path(`/${message.id}/send`), send('POST', { expectedVersion: message.version })))
}

async function rows(messageId: string): Promise<RecipientRow[]> {
  const found = await adminPool().query<RecipientRow>(
    `SELECT guardian_id, student_id, is_student, membership_id, outcome, in_app, email_status
       FROM message_recipients WHERE school_id = $1 AND message_id = $2`,
    [school, messageId],
  )
  return found.rows
}

async function inbox(client: Client): Promise<string[]> {
  const body = await ok<{ items: { messageId: string }[] }>(await client.fetch(path('/inbox?pageSize=100')))
  return body.items.map((item) => item.messageId)
}

/** Whether the message shows in each reader's inbox, by name. */
async function seenBy(messageId: string): Promise<Record<string, boolean>> {
  const readers: Record<string, Client> = { parent, ...pupils }
  const seen: Record<string, boolean> = {}
  for (const [name, client] of Object.entries(readers)) seen[name] = (await inbox(client)).includes(messageId)
  return seen
}

async function member(roleKeys: readonly string[], options: { mfa?: boolean; staffId?: string } = {}) {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `cp-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, 'Pupil messages member', email])
  await pool.query(`INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')`, [
    membershipId,
    school,
    userId,
  ])
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = ANY($3::text[])`,
    [school, membershipId, [...roleKeys]],
  )
  if (options.staffId)
    await pool.query('INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)', [
      school,
      membershipId,
      options.staffId,
    ])
  await setFixturePassword(server, userId, PASSWORD)
  const client = options.mfa
    ? await signInWithMfa(server, { userId, email, password: PASSWORD })
    : await signInWithPassword(server, email, PASSWORD)
  return { client, membershipId }
}

/** A pupil's own login made as issuance makes it, signed in through the pupil's door. */
async function pupilLogin(studentId: string, admissionNumber: string): Promise<Client> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  await pool.query(`INSERT INTO auth_user(id,name,email) VALUES ($1::uuid,'Pupil',$1::text || '@student.invalid')`, [userId])
  await setFixturePassword(server, userId, PUPIL_PASSWORD)
  await pool.query(`INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'student','active')`, [
    membershipId,
    school,
    userId,
  ])
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id) SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = 'student'`,
    [school, membershipId],
  )
  await pool.query(`INSERT INTO membership_student_links(school_id,membership_id,student_id) VALUES ($1,$2,$3)`, [
    school,
    membershipId,
    studentId,
  ])
  pupilMembership[studentId] = membershipId
  await resetRateLimits()
  const client = clientFor(server)
  const response = await client.fetch(
    '/api/student-sign-in',
    send('POST', { schoolCode: SCHOOL_CODE, admissionNumber, password: PUPIL_PASSWORD }),
  )
  assert.equal(response.status, 200, await response.text())
  return client
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,'CPS')`, [
    school,
    SCHOOL_CODE,
    `Pupil Messages School ${suffix}`,
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
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,current_date - 100,current_date + 200,'current')`,
    [year, school, `CP-${suffix}`],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [school, year])
  await pool.query(
    `INSERT INTO grades(id,school_id,name,short_name,sort_order,level)
     VALUES ($1,$5,'Class 6','6',6,6),($2,$5,'Class 9','9',9,9),($3,$5,'Class 10','10',10,10),($4,$5,'Class 11','11',11,11)`,
    [grade6, grade9, grade10, grade11, school],
  )
  const classTeacherStaff = randomUUID()
  await pool.query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status)
     VALUES ($1,$2,$3,'Class','teaching','Teacher','active')`,
    [classTeacherStaff, school, `CP-${suffix}`],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id)
     VALUES ($1,$2,$3,$4,'A',NULL),($5,$2,$3,$6,'A',$7),($8,$2,$3,$6,'B',NULL),($9,$2,$3,$10,'A',NULL),($11,$2,$3,$12,'A',NULL)`,
    [section6, school, year, grade6, section9a, grade9, classTeacherStaff, section9b, section10, grade10, section11, grade11],
  )
  const admissions: Record<string, string> = {}
  for (const [index, [id, section]] of (
    [
      [pupil9a, section9a],
      [pupil9aNoLogin, section9a],
      [pupil9b, section9b],
      [pupil10, section10],
      [pupil11, section11],
      [pupil6, section6],
    ] as const
  ).entries()) {
    admissions[id] = `CP/${suffix}/${index}`
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,$4,'Pupil','active')`,
      [id, school, admissions[id], `Pupil${index}`],
    )
    await pool.query(
      `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,$5,current_date - 100)`,
      [school, id, year, section, index + 1],
    )
  }

  server = await startTestServer()
  const office = await member(['owner'], { mfa: true })
  owner = office.client
  teacher = (await member(['teacher'], { staffId: classTeacherStaff })).client

  // The family of the Class 9 A pupil: agreed to messages, with an account.
  const guardianId = randomUUID()
  await pool.query(`INSERT INTO guardians(id,school_id,first_name) VALUES ($1,$2,'Family')`, [guardianId, school])
  await pool.query(
    `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation,is_primary) VALUES ($1,$2,$3,'mother',true)`,
    [school, pupil9a, guardianId],
  )
  await pool.query(
    `INSERT INTO guardian_consents(school_id,student_id,guardian_id,purpose,status,method,recorded_by_membership_id,recorded_at)
     VALUES ($1,$2,$3,'communication','given','signed_form',$4,now() - interval '1 day')`,
    [school, pupil9a, guardianId, office.membershipId],
  )
  const family = await member(['parent'])
  parent = family.client
  await pool.query(`INSERT INTO membership_guardian_links(school_id,membership_id,guardian_id,verified_at) VALUES ($1,$2,$3,now())`, [
    school,
    family.membershipId,
    guardianId,
  ])
  await pool.query(
    `INSERT INTO guardian_student_access(school_id,guardian_id,student_id,status,areas,approved_by_membership_id,approved_at)
     VALUES ($1,$2,$3,'approved',ARRAY['basic'],$4,now())`,
    [school, guardianId, pupil9a, office.membershipId],
  )

  pupils.pupil9a = await pupilLogin(pupil9a, admissions[pupil9a] as string)
  pupils.pupil9b = await pupilLogin(pupil9b, admissions[pupil9b] as string)
  pupils.pupil10 = await pupilLogin(pupil10, admissions[pupil10] as string)
})

after(async () => {
  await server.close()
  await closeAdminPool()
})

test('a notice to families goes to guardians only, and no pupil reads it', async () => {
  const message = await sent(owner, { kind: 'school' })
  assert.equal(message.audience.recipients, 'families')
  const found = await rows(message.id)
  assert.ok(found.length > 0)
  assert.ok(found.every((row) => !row.is_student && row.guardian_id !== null))
  assert.equal(message.counts?.pupils, 0)
  assert.deepEqual(await seenBy(message.id), { parent: true, pupil9a: false, pupil9b: false, pupil10: false })
})

test('a notice to the pupils is one row per pupil, in the app for those with a login, and no guardian reads it', async () => {
  const message = await sent(owner, { kind: 'school', recipients: 'students' })
  assert.equal(message.audience.recipients, 'students')
  const found = await rows(message.id)
  assert.equal(found.length, 6)
  assert.ok(found.every((row) => row.is_student && row.guardian_id === null && row.email_status === 'none'))
  const byPupil = new Map(found.map((row) => [row.student_id, row]))
  for (const id of [pupil9a, pupil9b, pupil10]) {
    const row = byPupil.get(id)
    assert.equal(row?.outcome, 'delivered', id)
    assert.equal(row?.in_app, true)
    assert.equal(row?.membership_id, pupilMembership[id])
  }
  for (const id of [pupil9aNoLogin, pupil11, pupil6]) {
    const row = byPupil.get(id)
    assert.equal(row?.outcome, 'no_contact', id)
    assert.equal(row?.in_app, false)
    assert.equal(row?.membership_id, null)
  }
  assert.equal(message.counts?.pupils, 6)
  assert.deepEqual(await seenBy(message.id), { parent: false, pupil9a: true, pupil9b: true, pupil10: true })
})

test('a notice to both reaches the family and the pupils, and the preview says how many are pupils', async () => {
  const preview = await ok<Record<string, unknown>>(
    await owner.fetch(path('/audience-preview'), send('POST', { audience: { kind: 'school', recipients: 'both' } })),
  )
  assert.equal(preview.pupils, 6)
  assert.equal(preview.pupilsInApp, 3)
  const message = await sent(owner, { kind: 'school', recipients: 'both' })
  const found = await rows(message.id)
  assert.equal(found.filter((row) => row.is_student).length, 6)
  assert.equal(found.filter((row) => row.guardian_id !== null).length, 1)
  assert.equal(message.counts?.pupils, 6)
  assert.equal(message.counts?.recipients, 7)
  assert.deepEqual(await seenBy(message.id), { parent: true, pupil9a: true, pupil9b: true, pupil10: true })
})

test('a pupil reads a notice to their grade, their section and to them alone, and not one to another class', async () => {
  const grade = await sent(owner, { kind: 'grade', gradeId: grade9, recipients: 'students' })
  assert.deepEqual(await seenBy(grade.id), { parent: false, pupil9a: true, pupil9b: true, pupil10: false })
  const section = await sent(owner, { kind: 'section', sectionId: section9a, recipients: 'students' })
  assert.deepEqual(await seenBy(section.id), { parent: false, pupil9a: true, pupil9b: false, pupil10: false })
  const alone = await sent(owner, { kind: 'pupil', studentId: pupil9a, recipients: 'students' })
  assert.deepEqual(await seenBy(alone.id), { parent: false, pupil9a: true, pupil9b: false, pupil10: false })
  assert.equal((await rows(alone.id)).length, 1)
  const family = await sent(owner, { kind: 'pupil', studentId: pupil9a })
  assert.deepEqual(await seenBy(family.id), { parent: true, pupil9a: false, pupil9b: false, pupil10: false })
  // A pupil opening a notice to their family is told it does not exist.
  const opened = await pupils.pupil9a?.fetch(path(`/${family.id}`))
  assert.equal(opened?.status, 404)
})

test('a range of classes includes both ends in class order and refuses one given backwards', async () => {
  const preview = await ok<{ audience: { label: string }; pupils: number; pupilsInApp: number }>(
    await owner.fetch(
      path('/audience-preview'),
      send('POST', { audience: { kind: 'grade_range', fromGradeId: grade9, toGradeId: grade10, recipients: 'students' } }),
    ),
  )
  assert.equal(preview.audience.label, 'Class 9 to Class 10')
  assert.equal(preview.pupils, 4)
  assert.equal(preview.pupilsInApp, 3)
  const range = await sent(owner, { kind: 'grade_range', fromGradeId: grade9, toGradeId: grade10, recipients: 'students' })
  assert.equal(range.audience.kind, 'grade_range')
  assert.equal(range.audience.gradeId, grade9)
  assert.equal(range.audience.toGradeId, grade10)
  const reached = new Set((await rows(range.id)).map((row) => row.student_id))
  assert.deepEqual(reached, new Set([pupil9a, pupil9aNoLogin, pupil9b, pupil10]))
  assert.deepEqual(await seenBy(range.id), { parent: false, pupil9a: true, pupil9b: true, pupil10: true })
  const stored = await adminPool().query<{ grade_id: string; grade_to_id: string; recipients: string }>(
    'SELECT grade_id, grade_to_id, recipients FROM messages WHERE id = $1',
    [range.id],
  )
  assert.deepEqual(stored.rows[0], { grade_id: grade9, grade_to_id: grade10, recipients: 'students' })

  // One class on its own is a range too.
  const single = await sent(owner, { kind: 'grade_range', fromGradeId: grade11, toGradeId: grade11, recipients: 'both' })
  assert.deepEqual(new Set((await rows(single.id)).filter((row) => row.is_student).map((row) => row.student_id)), new Set([pupil11]))

  for (const audience of [
    { kind: 'grade_range', fromGradeId: grade10, toGradeId: grade9 },
    { kind: 'grade_range', fromGradeId: grade9, toGradeId: randomUUID() },
  ]) {
    const response = await owner.fetch(path(''), send('POST', { audience, title: 'Backwards', body: 'Backwards.' }))
    const text = await response.text()
    assert.ok(response.status === 400 || response.status === 404, text)
  }
  const backwards = await owner.fetch(
    path(''),
    send('POST', { audience: { kind: 'grade_range', fromGradeId: grade10, toGradeId: grade9 }, title: 'B', body: 'B.' }),
  )
  assert.equal(((await backwards.json()) as ErrorBody).error.code, 'INVALID_REQUEST')
  // A staff audience has no recipients.
  const staff = await owner.fetch(path(''), send('POST', { audience: { kind: 'staff', recipients: 'students' }, title: 'S', body: 'S.' }))
  assert.equal(staff.status, 400)
})

test('a teacher may send to the pupils of their own section only, and never to a range', async () => {
  const own = await sent(teacher, { kind: 'section', sectionId: section9a, recipients: 'students' })
  assert.deepEqual(await seenBy(own.id), { parent: false, pupil9a: true, pupil9b: false, pupil10: false })
  const onePupil = await sent(teacher, { kind: 'pupil', studentId: pupil9a, recipients: 'both' })
  assert.deepEqual(await seenBy(onePupil.id), { parent: true, pupil9a: true, pupil9b: false, pupil10: false })
  for (const audience of [
    { kind: 'section', sectionId: section9b, recipients: 'students' },
    { kind: 'pupil', studentId: pupil9b, recipients: 'students' },
    { kind: 'grade_range', fromGradeId: grade9, toGradeId: grade9, recipients: 'students' },
    { kind: 'grade', gradeId: grade9, recipients: 'students' },
  ]) {
    const response = await teacher.fetch(path(''), send('POST', { audience, title: 'Not mine', body: 'Not mine.' }))
    const text = await response.text()
    assert.ok(response.status === 403 || response.status === 404, `${JSON.stringify(audience)}: ${response.status} ${text}`)
  }
})

test('a pupil cannot write a message or read the delivery list', async () => {
  const pupil = pupils.pupil9a as Client
  const write = await pupil.fetch(path(''), send('POST', { audience: { kind: 'section', sectionId: section9a }, title: 'Hi', body: 'Hi.' }))
  assert.equal(write.status, 403)
  const message = await sent(owner, { kind: 'section', sectionId: section9a, recipients: 'students' })
  assert.ok((await inbox(pupil)).includes(message.id))
  const detail = await ok<Detail>(await pupil.fetch(path(`/${message.id}`)))
  assert.equal(detail.counts, undefined)
  const list = await pupil.fetch(path(`/${message.id}/recipients`))
  assert.ok(list.status === 403 || list.status === 404)
})
