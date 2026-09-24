/**
 * Matrix rows: communication.
 *
 * The adversarial half of Task 22. The module's own suite proves a message
 * reaches the right families; this file asks who else can see it. A teacher
 * writes to their own classes and nothing wider, a teaching post that ended
 * takes its class away with it, a parent reads only what was addressed to
 * them (one guardian's agreement never opens a message to the other), the
 * accountant reads their own inbox and no school message, a draft is its
 * author's alone, and an id from the school next door reads exactly like an
 * id that was never real. Last, the words of a message are searched for in
 * the audit log after a full flow: only the withdrawal reason may be there,
 * and only as a note.
 *
 * The suite builds two schools of its own, so no other suite's pupils or
 * messages change what a list holds.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { ROLE_TEMPLATES } from '@erp/contracts'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
  setFixturePassword,
  signInWithMfa,
  signInWithPassword,
  startTestServer,
  type TestServer,
} from '../../apps/api/tests/harness.ts'

const PASSWORD = 'Fixture-Pass!42'
const suffix = randomUUID().slice(0, 8)
const BODY = `Unmistakable body ${suffix}`
const TITLE = `Unmistakable title ${suffix}`
const REASON = `Withdrawn for reason ${suffix}`

type Client = Awaited<ReturnType<typeof signInWithPassword>>

interface ErrorBody {
  error: { code: string; reason?: string }
}
interface Detail {
  id: string
  status: string
  body: string
  version: number
  attachments: { id: string }[]
  counts?: Record<string, number>
  myReceipt?: { recipientId: string }
}
interface List {
  items: { id: string }[]
  total: number
}
interface Inbox {
  items: { recipientId: string; messageId: string }[]
}

/** One school built for this file: its year, a grade and three sections. */
interface School {
  id: string
  year: string
  grade: string
  sectionA: string
  sectionB: string
  sectionC: string
}

function newSchool(): School {
  return {
    id: randomUUID(),
    year: randomUUID(),
    grade: randomUUID(),
    sectionA: randomUUID(),
    sectionB: randomUUID(),
    sectionC: randomUUID(),
  }
}

const s = newSchool()
const t = newSchool()

// School S's pupils: one in A with two guardians who answered differently,
// one in C of another family, and one who is promoted at the end.
const kidA = randomUUID()
const kidC = randomUUID()
const kidPromoted = randomUUID()

let server: TestServer
let owner: Client
let principal: Client
let classTeacher: Client
let subjectTeacher: Client
let endedTeacher: Client
let accountant: Client
let parentConsent: Client
let parentWithdrawn: Client
let parentOther: Client
let parentPromoted: Client
let ownerMembership = ''

// School T's rows, reached only through school S's paths.
let ownerT: Client
let messageT = ''
let recipientT = ''
let attachmentT = ''
let templateT = ''
const kidT = randomUUID()

const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n')

const path = (schoolId: string, rest: string) => `/api/schools/${schoolId}/messages${rest}`

function send(method: string, value: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
}

async function ok<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text()
  assert.equal(response.status, status, text)
  return (text ? JSON.parse(text) : null) as T
}

async function refused(response: Response, status: number, code?: string): Promise<ErrorBody> {
  const text = await response.text()
  assert.equal(response.status, status, text)
  const parsed = JSON.parse(text) as ErrorBody
  if (code !== undefined) assert.equal(parsed.error.code, code, text)
  return parsed
}

/** The status, code and reason of an answer: what a wrong-person answer must share with a missing id. */
async function shape(response: Response): Promise<string> {
  const text = await response.text()
  const parsed = text ? (JSON.parse(text) as Partial<ErrorBody>) : {}
  return `${response.status} ${parsed.error?.code ?? ''} ${parsed.error?.reason ?? ''}`
}

async function draft(client: Client, schoolId: string, audience: unknown, title = 'Notice', body = 'A notice.'): Promise<Detail> {
  return ok<Detail>(await client.fetch(path(schoolId, ''), send('POST', { audience, title, body })), 201)
}

async function sendNow(client: Client, schoolId: string, message: Detail): Promise<Detail> {
  return ok<Detail>(
    await client.fetch(path(schoolId, `/${message.id}/send`), send('POST', { expectedVersion: message.version })),
  )
}

async function attach(client: Client, schoolId: string, message: Detail): Promise<Detail> {
  return ok<Detail>(
    await client.fetch(
      path(schoolId, `/${message.id}/attachments?expectedVersion=${message.version}&fileName=notice.pdf`),
      { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: PDF },
    ),
  )
}

async function inboxIds(client: Client, schoolId = s.id): Promise<Set<string>> {
  const inbox = await ok<Inbox>(await client.fetch(path(schoolId, '/inbox?pageSize=100')))
  return new Set(inbox.items.map((row) => row.messageId))
}

async function listIds(client: Client, schoolId = s.id): Promise<Set<string>> {
  const list = await ok<List>(await client.fetch(path(schoolId, '?pageSize=100')))
  return new Set(list.items.map((row) => row.id))
}

async function createSchool(school: School, code: string): Promise<void> {
  const pool = adminPool()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,$4)`, [
    school.id,
    `${code.toLowerCase()}-${suffix}`,
    `${code} School ${suffix}`,
    code,
  ])
  for (const [key, template] of Object.entries(ROLE_TEMPLATES)) {
    const role = await pool.query<{ id: string }>(
      `INSERT INTO roles(school_id,key,name,is_system) VALUES ($1,$2,$3,true) RETURNING id`,
      [school.id, key, template.displayName],
    )
    for (const grant of template.grants)
      await pool.query(
        `INSERT INTO role_permissions(school_id,role_id,permission,scope) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [school.id, role.rows[0]?.id, grant.permission, grant.scope],
      )
  }
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,current_date - 100,current_date + 200,'current')`,
    [school.year, school.id, `${code}-${suffix}`],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [school.id, school.year])
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,'Class 7','C7',7)`, [
    school.grade,
    school.id,
  ])
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name)
     VALUES ($1,$4,$5,$6,'A'),($2,$4,$5,$6,'B'),($3,$4,$5,$6,'C')`,
    [school.sectionA, school.sectionB, school.sectionC, school.id, school.year, school.grade],
  )
}

async function pupil(schoolId: string, yearId: string, sectionId: string, id: string, index: number): Promise<void> {
  const pool = adminPool()
  await pool.query(
    `INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,$4,'Pupil','active')`,
    [id, schoolId, `SEC/${suffix}/${index}`, `Kid${index}`],
  )
  await pool.query(
    `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
     VALUES ($1,$2,$3,$4,$5,current_date - 100)`,
    [schoolId, id, yearId, sectionId, index],
  )
}

async function staffRow(schoolId: string, label: string): Promise<string> {
  const id = randomUUID()
  await adminPool().query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status)
     VALUES ($1,$2,$3,$4,'teaching','Teacher','active')`,
    [id, schoolId, `SEC-${suffix}-${label}`, `Staff ${label}`],
  )
  return id
}

/** A signed-in member of one school (with the second factor for an office role). */
async function member(
  schoolId: string,
  roleKeys: readonly string[],
  options: { mfa?: boolean; staffId?: string } = {},
): Promise<{ client: Client; membershipId: string }> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `sec-comm-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, 'Security member', email])
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')`,
    [membershipId, schoolId, userId],
  )
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = ANY($3::text[])`,
    [schoolId, membershipId, [...roleKeys]],
  )
  if (options.staffId)
    await pool.query('INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)', [
      schoolId,
      membershipId,
      options.staffId,
    ])
  await setFixturePassword(server, userId, PASSWORD)
  const client = options.mfa
    ? await signInWithMfa(server, { userId, email, password: PASSWORD })
    : await signInWithPassword(server, email, PASSWORD)
  return { client, membershipId }
}

/** A guardian of one pupil with a parent account; `consent` is the newest communication consent row. */
async function guardian(
  schoolId: string,
  studentId: string,
  consent: 'given' | 'withdrawn',
  recordedBy: string,
): Promise<Client> {
  const pool = adminPool()
  const guardianId = randomUUID()
  await pool.query('INSERT INTO guardians(id,school_id,first_name) VALUES ($1,$2,$3)', [guardianId, schoolId, 'Guardian'])
  await pool.query(
    `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation,receives_notifications)
     VALUES ($1,$2,$3,'mother',true)`,
    [schoolId, studentId, guardianId],
  )
  await pool.query(
    `INSERT INTO guardian_consents(school_id,student_id,guardian_id,purpose,status,method,recorded_by_membership_id,recorded_at)
     VALUES ($1,$2,$3,'communication','given','signed_form',$4,now() - interval '1 day')`,
    [schoolId, studentId, guardianId, recordedBy],
  )
  if (consent === 'withdrawn')
    await pool.query(
      `INSERT INTO guardian_consents(school_id,student_id,guardian_id,purpose,status,method,recorded_by_membership_id)
       VALUES ($1,$2,$3,'communication','withdrawn','portal',$4)`,
      [schoolId, studentId, guardianId, recordedBy],
    )
  const { client, membershipId } = await member(schoolId, ['parent'])
  await pool.query(
    `INSERT INTO membership_guardian_links(school_id,membership_id,guardian_id,verified_at) VALUES ($1,$2,$3,now())`,
    [schoolId, membershipId, guardianId],
  )
  await pool.query(
    `INSERT INTO guardian_student_access(school_id,guardian_id,student_id,status,areas,approved_by_membership_id,approved_at)
     VALUES ($1,$2,$3,'approved',ARRAY['basic'],$4,now())`,
    [schoolId, guardianId, studentId, recordedBy],
  )
  return client
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await createSchool(s, 'SCA')
  await createSchool(t, 'SCB')
  server = await startTestServer()

  // School S: a class teacher of A, a subject teacher of B, a teacher whose
  // post in C ended last month but who still teaches B, the accountant.
  const subject = randomUUID()
  await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,'Maths',$3,'scholastic')`, [
    subject,
    s.id,
    `SEC${suffix}`,
  ])
  const classStaff = await staffRow(s.id, 'class')
  const subjectStaff = await staffRow(s.id, 'subject')
  const endedStaff = await staffRow(s.id, 'ended')
  const accountantStaff = await staffRow(s.id, 'accounts')
  await pool.query('UPDATE sections SET class_teacher_staff_id = $2 WHERE id = $1', [s.sectionA, classStaff])
  await pool.query(
    `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from,effective_to)
     VALUES ($1,$2,$3,$4,$5,current_date - 100,NULL),
            ($1,$6,$3,$4,$5,current_date - 100,NULL),
            ($1,$6,$3,$7,$5,current_date - 100,(date_trunc('month', current_date) - interval '1 day')::date)`,
    [s.id, subjectStaff, s.year, s.sectionB, subject, endedStaff, s.sectionC],
  )

  const office = await member(s.id, ['owner'], { mfa: true })
  owner = office.client
  ownerMembership = office.membershipId
  principal = (await member(s.id, ['principal'], { mfa: true })).client
  classTeacher = (await member(s.id, ['teacher'], { staffId: classStaff })).client
  subjectTeacher = (await member(s.id, ['teacher'], { staffId: subjectStaff })).client
  endedTeacher = (await member(s.id, ['teacher'], { staffId: endedStaff })).client
  accountant = (await member(s.id, ['accountant'], { mfa: true, staffId: accountantStaff })).client

  await pupil(s.id, s.year, s.sectionA, kidA, 1)
  await pupil(s.id, s.year, s.sectionC, kidC, 2)
  await pupil(s.id, s.year, s.sectionA, kidPromoted, 3)
  parentConsent = await guardian(s.id, kidA, 'given', ownerMembership)
  parentWithdrawn = await guardian(s.id, kidA, 'withdrawn', ownerMembership)
  parentOther = await guardian(s.id, kidC, 'given', ownerMembership)
  parentPromoted = await guardian(s.id, kidPromoted, 'given', ownerMembership)

  // School T: one sent section message with a file, its one recipient, a template.
  const officeT = await member(t.id, ['owner'], { mfa: true })
  ownerT = officeT.client
  await pupil(t.id, t.year, t.sectionA, kidT, 1)
  await guardian(t.id, kidT, 'given', officeT.membershipId)
  let other = await draft(ownerT, t.id, { kind: 'section', sectionId: t.sectionA }, 'Other school', 'Other school body.')
  other = await attach(ownerT, t.id, other)
  attachmentT = other.attachments[0]?.id ?? ''
  messageT = (await sendNow(ownerT, t.id, other)).id
  const row = await pool.query<{ id: string }>('SELECT id FROM message_recipients WHERE school_id = $1 AND message_id = $2', [
    t.id,
    messageT,
  ])
  recipientT = row.rows[0]?.id ?? ''
  const template = await ok<{ id: string }>(
    await ownerT.fetch(path(t.id, '/templates'), send('POST', { kind: 'notice', name: 'T', title: 'T', body: 'T' })),
    201,
  )
  templateT = template.id
  assert.ok(attachmentT && recipientT && templateT)
})

after(async () => {
  await server?.close()
  await closeAdminPool()
})

test("another school's ids answer exactly like ids that were never real", async () => {
  let own = await draft(owner, s.id, { kind: 'section', sectionId: s.sectionA }, 'Own', 'Own body.')
  own = await attach(owner, s.id, own)
  const missing = randomUUID()
  const version = 'expectedVersion=1'
  const pairs: [string, RequestInit | undefined, string][] = [
    [`/${messageT}`, undefined, `/${missing}`],
    [`/${messageT}/recipients`, undefined, `/${missing}/recipients`],
    [`/${messageT}/attachments/${attachmentT}`, undefined, `/${missing}/attachments/${missing}`],
    [`/${own.id}/attachments/${attachmentT}`, undefined, `/${own.id}/attachments/${missing}`],
    [
      `/${own.id}/attachments/${attachmentT}?expectedVersion=${own.version}`,
      { method: 'DELETE' },
      `/${own.id}/attachments/${missing}?expectedVersion=${own.version}`,
    ],
    [`/${messageT}`, send('PATCH', { expectedVersion: 1, title: 'x' }), `/${missing}`],
    [`/${messageT}?${version}`, { method: 'DELETE' }, `/${missing}?${version}`],
    [`/${messageT}/send`, send('POST', { expectedVersion: 1 }), `/${missing}/send`],
    [`/${messageT}/unschedule`, send('POST', { expectedVersion: 1 }), `/${missing}/unschedule`],
    [`/${messageT}/withdraw`, send('POST', { expectedVersion: 2, reason: 'Sent to the wrong class.' }), `/${missing}/withdraw`],
    [`/${messageT}/export`, send('POST', {}), `/${missing}/export`],
    [`/inbox/${recipientT}/read`, send('POST', {}), `/inbox/${missing}/read`],
    [`/templates/${templateT}`, send('PATCH', { expectedVersion: 1, name: 'x' }), `/templates/${missing}`],
    [`/templates/${templateT}/archive`, send('POST', { expectedVersion: 1 }), `/templates/${missing}/archive`],
  ]
  for (const [foreign, init, absent] of pairs) {
    const a = await shape(await owner.fetch(path(s.id, foreign), init))
    const b = await shape(await owner.fetch(path(s.id, absent), init))
    assert.equal(a, b, `${init?.method ?? 'GET'} ${foreign}`)
    assert.match(a, /^404 RESOURCE_NOT_FOUND/, foreign)
  }
  // A section, a grade and a pupil of school T as the audience of a message
  // in school S, in a draft, a change and a preview.
  for (const [foreign, absent] of [
    [{ kind: 'section', sectionId: t.sectionA }, { kind: 'section', sectionId: missing }],
    [{ kind: 'grade', gradeId: t.grade }, { kind: 'grade', gradeId: missing }],
    [{ kind: 'pupil', studentId: kidT }, { kind: 'pupil', studentId: missing }],
  ]) {
    for (const [route, method, extra] of [
      ['', 'POST', { title: 'x', body: 'y' }],
      ['/audience-preview', 'POST', {}],
      [`/${own.id}`, 'PATCH', { expectedVersion: own.version }],
    ] as const) {
      const a = await shape(await owner.fetch(path(s.id, route), send(method, { ...extra, audience: foreign })))
      const b = await shape(await owner.fetch(path(s.id, route), send(method, { ...extra, audience: absent })))
      assert.equal(a, b, `${method} ${route} ${JSON.stringify(foreign)}`)
      assert.match(a, /^404 RESOURCE_NOT_FOUND/)
    }
  }
  // Nothing in school T moved.
  const still = await adminPool().query<{ status: string; read_at: Date | null }>(
    `SELECT m.status, r.read_at FROM messages m JOIN message_recipients r ON r.message_id = m.id WHERE m.id = $1`,
    [messageT],
  )
  assert.deepEqual(still.rows[0], { status: 'sent', read_at: null })
  // And school T's own owner still reads it.
  await ok(await ownerT.fetch(path(t.id, `/${messageT}`)))
})

test('a teacher writes only to their own sections', async () => {
  // The class teacher of A, and a subject teacher of B, each reach their own.
  await draft(classTeacher, s.id, { kind: 'section', sectionId: s.sectionA })
  await draft(classTeacher, s.id, { kind: 'pupil', studentId: kidA })
  await draft(subjectTeacher, s.id, { kind: 'section', sectionId: s.sectionB })
  // Another section, and a pupil of it, read as missing.
  await refused(
    await classTeacher.fetch(path(s.id, ''), send('POST', { audience: { kind: 'section', sectionId: s.sectionB }, title: 'x', body: 'y' })),
    404,
    'RESOURCE_NOT_FOUND',
  )
  await refused(
    await subjectTeacher.fetch(path(s.id, ''), send('POST', { audience: { kind: 'section', sectionId: s.sectionA }, title: 'x', body: 'y' })),
    404,
    'RESOURCE_NOT_FOUND',
  )
  await refused(
    await classTeacher.fetch(path(s.id, ''), send('POST', { audience: { kind: 'pupil', studentId: kidC }, title: 'x', body: 'y' })),
    404,
    'RESOURCE_NOT_FOUND',
  )
  await refused(
    await classTeacher.fetch(path(s.id, '/audience-preview'), send('POST', { audience: { kind: 'section', sectionId: s.sectionC } })),
    404,
  )
  // The school and the staff exist, so the refusal says so; a grade is a
  // record like a section and reads as missing. Only the school scope reaches them.
  await refused(
    await classTeacher.fetch(path(s.id, ''), send('POST', { audience: { kind: 'grade', gradeId: s.grade }, title: 'x', body: 'y' })),
    404,
    'RESOURCE_NOT_FOUND',
  )
  for (const audience of [{ kind: 'school' }, { kind: 'staff' }])
    await refused(
      await classTeacher.fetch(path(s.id, ''), send('POST', { audience, title: 'x', body: 'y' })),
      403,
      'ACCESS_DENIED',
    )
  // A draft of their own cannot be moved to a wider audience.
  const own = await draft(classTeacher, s.id, { kind: 'section', sectionId: s.sectionA })
  await refused(
    await classTeacher.fetch(path(s.id, `/${own.id}`), send('PATCH', { expectedVersion: own.version, audience: { kind: 'school' } })),
    403,
  )
  const kept = await adminPool().query<{ audience: string }>('SELECT audience FROM messages WHERE id = $1', [own.id])
  assert.equal(kept.rows[0]?.audience, 'section')
  const options = await ok<{ school: boolean; staff: boolean; grades: unknown[]; sections: { id: string }[] }>(
    await classTeacher.fetch(path(s.id, '/audiences')),
  )
  assert.equal(options.school, false)
  assert.equal(options.staff, false)
  assert.deepEqual(options.grades, [])
  assert.deepEqual(
    options.sections.map((row) => row.id),
    [s.sectionA],
  )
})

test('a teacher whose assignment ended last month cannot send to that section', async () => {
  await draft(endedTeacher, s.id, { kind: 'section', sectionId: s.sectionB })
  await refused(
    await endedTeacher.fetch(path(s.id, ''), send('POST', { audience: { kind: 'section', sectionId: s.sectionC }, title: 'x', body: 'y' })),
    404,
    'RESOURCE_NOT_FOUND',
  )
  await refused(
    await endedTeacher.fetch(path(s.id, ''), send('POST', { audience: { kind: 'pupil', studentId: kidC }, title: 'x', body: 'y' })),
    404,
    'RESOURCE_NOT_FOUND',
  )
  const options = await ok<{ sections: { id: string }[] }>(await endedTeacher.fetch(path(s.id, '/audiences')))
  assert.deepEqual(
    options.sections.map((row) => row.id),
    [s.sectionB],
  )
})

let sectionMessage: Detail
let pupilMessage: Detail
let staffMessage: Detail

test('a parent reads only what was addressed to them', async () => {
  let message = await draft(owner, s.id, { kind: 'section', sectionId: s.sectionA }, TITLE, BODY)
  message = await attach(owner, s.id, message)
  sectionMessage = await sendNow(owner, s.id, message)
  pupilMessage = await sendNow(owner, s.id, await draft(owner, s.id, { kind: 'pupil', studentId: kidA }, 'About Kid1', 'Kid1 did well.'))
  const attachment = `/${sectionMessage.id}/attachments/${sectionMessage.attachments[0]?.id}`

  // The guardian who agreed reads it, with its file and a receipt of their own.
  assert.ok((await inboxIds(parentConsent)).has(sectionMessage.id))
  const seen = await ok<Detail>(await parentConsent.fetch(path(s.id, `/${sectionMessage.id}`)))
  assert.equal(seen.body, BODY)
  assert.ok(seen.myReceipt)
  assert.equal(seen.counts, undefined)
  assert.equal((await parentConsent.fetch(path(s.id, attachment))).status, 200)

  // The other guardian of the same child withdrew: not in the inbox, and
  // the message, its file and the other guardian's receipt read as missing.
  for (const other of [parentWithdrawn, parentOther]) {
    const inbox = await inboxIds(other)
    assert.ok(!inbox.has(sectionMessage.id))
    assert.ok(!inbox.has(pupilMessage.id))
    await refused(await other.fetch(path(s.id, `/${sectionMessage.id}`)), 404, 'RESOURCE_NOT_FOUND')
    await refused(await other.fetch(path(s.id, `/${pupilMessage.id}`)), 404, 'RESOURCE_NOT_FOUND')
    await refused(await other.fetch(path(s.id, attachment)), 404, 'RESOURCE_NOT_FOUND')
    await refused(
      await other.fetch(path(s.id, `/inbox/${seen.myReceipt?.recipientId}/read`), send('POST', {})),
      404,
      'RESOURCE_NOT_FOUND',
    )
  }
  const receipt = await adminPool().query<{ read_at: Date | null }>('SELECT read_at FROM message_recipients WHERE id = $1', [
    seen.myReceipt?.recipientId,
  ])
  assert.equal(receipt.rows[0]?.read_at, null)
  // A parent is not a sender, and the school's list is not theirs.
  assert.equal((await listIds(parentConsent)).size, 0)
  await refused(
    await parentConsent.fetch(path(s.id, ''), send('POST', { audience: { kind: 'pupil', studentId: kidA }, title: 'x', body: 'y' })),
    403,
  )
})

test('the recipients list and the counts are refused to a mere recipient', async () => {
  await refused(await parentConsent.fetch(path(s.id, `/${sectionMessage.id}/recipients`)), 404, 'RESOURCE_NOT_FOUND')
  // The class teacher reaches the section's messages whoever sent them.
  const rows = await ok<List>(await classTeacher.fetch(path(s.id, `/${sectionMessage.id}/recipients`)))
  // Two guardians of one pupil and one of the other pupil in A.
  assert.equal(rows.total, 3)
  const detail = await ok<Detail>(await classTeacher.fetch(path(s.id, `/${sectionMessage.id}`)))
  assert.ok(detail.counts)
  // Another section's teacher does not.
  await refused(await subjectTeacher.fetch(path(s.id, `/${sectionMessage.id}`)), 404)
  await refused(await subjectTeacher.fetch(path(s.id, `/${sectionMessage.id}/recipients`)), 404)
})

test('the accountant reads only their own inbox', async () => {
  staffMessage = await sendNow(owner, s.id, await draft(owner, s.id, { kind: 'staff' }, 'Staff meeting', 'Meeting at four.'))
  const inbox = await inboxIds(accountant)
  assert.ok(inbox.has(staffMessage.id))
  assert.ok(!inbox.has(sectionMessage.id))
  const list = await ok<List>(await accountant.fetch(path(s.id, '')))
  assert.equal(list.total, 0)
  assert.deepEqual(list.items, [])
  await ok(await accountant.fetch(path(s.id, `/${staffMessage.id}`)))
  await refused(await accountant.fetch(path(s.id, `/${staffMessage.id}/recipients`)), 404)
  await refused(await accountant.fetch(path(s.id, `/${sectionMessage.id}`)), 404)
  await refused(await accountant.fetch(path(s.id, `/${pupilMessage.id}`)), 404)
})

test('nobody but its author sees a draft, the office included', async () => {
  const teacherDraft = await attach(classTeacher, s.id, await draft(classTeacher, s.id, { kind: 'section', sectionId: s.sectionA }))
  const ownerDraft = await draft(owner, s.id, { kind: 'school' }, 'Owner draft', 'Owner draft body.')
  const file = `/${teacherDraft.id}/attachments/${teacherDraft.attachments[0]?.id}`
  for (const [author, message, others] of [
    [classTeacher, teacherDraft, [owner, principal, subjectTeacher, parentConsent]],
    [owner, ownerDraft, [principal, classTeacher, accountant, parentConsent]],
  ] as const) {
    await ok(await author.fetch(path(s.id, `/${message.id}`)))
    for (const other of others) {
      assert.ok(!(await listIds(other)).has(message.id))
      await refused(await other.fetch(path(s.id, `/${message.id}`)), 404, 'RESOURCE_NOT_FOUND')
      await refused(await other.fetch(path(s.id, `/${message.id}/recipients`)), 404)
      await refused(
        await other.fetch(path(s.id, `/${message.id}/send`), send('POST', { expectedVersion: message.version })),
        other === parentConsent || other === accountant ? 403 : 404,
      )
    }
  }
  for (const other of [owner, principal]) await refused(await other.fetch(path(s.id, file)), 404)
  const still = await adminPool().query<{ status: string }>('SELECT status FROM messages WHERE id = ANY($1::uuid[])', [
    [teacherDraft.id, ownerDraft.id],
  ])
  assert.deepEqual(still.rows.map((row) => row.status), ['draft', 'draft'])
})

test('a list and its detail agree for every caller', async () => {
  const all = await adminPool().query<{ id: string }>('SELECT id FROM messages WHERE school_id = $1', [s.id])
  for (const [label, client] of [
    ['owner', owner],
    ['principal', principal],
    ['class teacher', classTeacher],
    ['subject teacher', subjectTeacher],
    ['ended teacher', endedTeacher],
    ['accountant', accountant],
    ['parent', parentConsent],
    ['withdrawn parent', parentWithdrawn],
  ] as const) {
    const listed = await listIds(client)
    const inbox = await inboxIds(client)
    for (const row of all.rows) {
      const status = (await client.fetch(path(s.id, `/${row.id}`))).status
      const expected = listed.has(row.id) || inbox.has(row.id) ? 200 : 404
      assert.equal(status, expected, `${label} ${row.id}`)
    }
  }
})

test('message words never reach the audit log; only the withdrawal reason, as a note', async () => {
  const detail = await ok<Detail>(await parentConsent.fetch(path(s.id, `/${sectionMessage.id}`)))
  await ok(await parentConsent.fetch(path(s.id, `/inbox/${detail.myReceipt?.recipientId}/read`), send('POST', {})))
  await ok(
    await owner.fetch(path(s.id, `/${sectionMessage.id}/withdraw`), send('POST', { expectedVersion: sectionMessage.version, reason: REASON })),
  )
  await ok(
    await owner.fetch(path(s.id, '/templates'), send('POST', { kind: 'notice', name: 'Words', title: TITLE, body: BODY })),
    201,
  )
  const pool = adminPool()
  const events = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM audit_events
      WHERE school_id = $1 AND (safe_changes::text LIKE $2 OR safe_changes::text LIKE $3 OR safe_changes::text LIKE $4
                                OR safe_changes::text LIKE '%notice.pdf%')`,
    [s.id, `%${suffix}%`, `%${BODY}%`, `%${TITLE}%`],
  )
  assert.equal(events.rows[0]?.count, 0)
  const notes = await pool.query<{ note: string }>(
    `SELECT note FROM audit_event_notes WHERE school_id = $1 AND note LIKE $2`,
    [s.id, `%${suffix}%`],
  )
  assert.deepEqual(notes.rows.map((row) => row.note), [REASON])
  // The rows were written: the flow is audited, just not with the words.
  const written = await pool.query<{ action: string }>(
    `SELECT DISTINCT action FROM audit_events WHERE school_id = $1 AND target_id = ANY($2::uuid[])`,
    [s.id, [sectionMessage.id, detail.myReceipt?.recipientId]],
  )
  const actions = written.rows.map((row) => row.action)
  assert.ok(actions.includes('communication.send'), actions.join())
  assert.ok(actions.includes('communication.read'), actions.join())
  // The outbox holds no words either.
  const outbox = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM delivery_outbox WHERE payload::text LIKE $1`,
    [`%${suffix}%`],
  )
  assert.equal(outbox.rows[0]?.count, 0)
})

test("a message about last year's pupil still reads for the parent who received it", async () => {
  const message = await sendNow(
    owner,
    s.id,
    await draft(owner, s.id, { kind: 'pupil', studentId: kidPromoted }, 'Last year', 'About last year.'),
  )
  assert.ok((await inboxIds(parentPromoted)).has(message.id))
  // The school moves on a year: this year closes and the child sits in a
  // section of the next one.
  const pool = adminPool()
  const nextYear = randomUUID()
  const nextSection = randomUUID()
  await pool.query(`UPDATE academic_years SET status = 'closed' WHERE id = $1`, [s.year])
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,current_date + 201,current_date + 560,'current')`,
    [nextYear, s.id, `SCA-next-${suffix}`],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [s.id, nextYear])
  await pool.query(`INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,'A')`, [
    nextSection,
    s.id,
    nextYear,
    s.grade,
  ])
  await pool.query(
    `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
     VALUES ($1,$2,$3,$4,1,current_date + 201)`,
    [s.id, kidPromoted, nextYear, nextSection],
  )
  assert.ok((await inboxIds(parentPromoted)).has(message.id))
  const detail = await ok<Detail>(await parentPromoted.fetch(path(s.id, `/${message.id}`)))
  assert.equal(detail.body, 'About last year.')
  // Still nobody else's.
  await refused(await parentOther.fetch(path(s.id, `/${message.id}`)), 404)
})
