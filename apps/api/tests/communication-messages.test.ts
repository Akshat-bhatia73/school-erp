/**
 * The communication module (Task 22): writing, sending and reading messages,
 * the files a notice carries, templates and the automatic message settings.
 *
 * The suite builds a school of its own, so the people a message reaches are
 * exactly the families and staff made here and no other suite's pupils can
 * change a count. One class holds a pupil for every way a guardian can come
 * out of a send: agreed to messages with an account, withdrew the agreement,
 * agreed but the office switched notifications off, never answered, agreed
 * with no account and no address that can receive mail, and agreed with an
 * address that can.
 *
 * A send now starts the message pump in the background (at most once a minute
 * per school). The tests that need the pump call it themselves, waiting for
 * the school's lock, and set any email they look at back to a known state.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { ROLE_TEMPLATES } from '@erp/contracts'
import type { DispatchDependencies } from '../src/modules/communication/common.ts'
import { runMessagePump } from '../src/modules/communication/pump.ts'
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
const suffix = randomUUID().slice(0, 8)

const school = randomUUID()
const year = randomUUID()
const grade = randomUUID()
const section = randomUUID()
const otherSection = randomUUID()
const subject = randomUUID()

// One pupil per way a family can come out of a send.
const pupilConsent = randomUUID()
const pupilOff = randomUUID()
const pupilNone = randomUUID()
const pupilNoContact = randomUUID()
const pupilEmail = randomUUID()

let server: TestServer
let deps: DispatchDependencies
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client
let classTeacher: Client
let subjectTeacher: Client
let parent: Client
let withdrawnParent: Client
let ownerMembership = ''
let subjectTeacherStaff = ''
let subjectTeacherMembership = ''
const guardians: Record<string, string> = {}

interface ErrorBody {
  error: { code: string; reason?: string }
}
interface Detail {
  id: string
  status: string
  title: string
  body: string
  version: number
  attachments: { id: string; fileName: string; contentType: string }[]
  counts?: Record<string, number>
  cancelReason?: string
  myReceipt?: { recipientId: string; readAt?: string }
}
interface Inbox {
  items: { recipientId: string; messageId: string; title: string; readAt?: string }[]
  unread: number
  total: number
}
interface Template {
  id: string
  kind: string
  archived: boolean
  version: number
}
interface Settings {
  version: number
  absenceDelayMinutes: number
  wording: { kind: string; title: string; templateId?: string }[]
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

async function refused(response: Response, status: number, reason?: string): Promise<ErrorBody> {
  const text = await response.text()
  assert.equal(response.status, status, text)
  const body = JSON.parse(text) as ErrorBody
  if (reason !== undefined) assert.equal(body.error.reason, reason, text)
  return body
}

/** The pump once, waiting for a background runner that holds the school's lock. */
async function pump(): Promise<Record<string, number>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const counts = await runMessagePump(deps, school, `messages-test-${randomUUID()}`)
    if (counts.skipped === undefined) return counts
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('the pump never got the school lock')
}

async function draft(client: Client, audience: unknown, title = 'Sports day', body = 'Sports day is on Friday.'): Promise<Detail> {
  return ok<Detail>(await client.fetch(path(''), send('POST', { audience, title, body })), 201)
}

async function sendNow(client: Client, message: Detail): Promise<Detail> {
  return ok<Detail>(await client.fetch(path(`/${message.id}/send`), send('POST', { expectedVersion: message.version })))
}

async function recipientsOf(messageId: string): Promise<Map<string, { id: string; outcome: string; in_app: boolean; email_status: string; membership_id: string | null }>> {
  const found = await adminPool().query<{
    id: string
    guardian_id: string | null
    staff_id: string | null
    outcome: string
    in_app: boolean
    email_status: string
    membership_id: string | null
  }>(
    `SELECT id, guardian_id, staff_id, outcome, in_app, email_status, membership_id
       FROM message_recipients WHERE school_id = $1 AND message_id = $2`,
    [school, messageId],
  )
  return new Map(found.rows.map((row) => [row.guardian_id ?? row.staff_id ?? '', row]))
}

async function auditCount(action: string, targetId: string): Promise<number> {
  const found = await adminPool().query<{ count: number }>(
    `SELECT count(*)::int AS count FROM audit_events WHERE school_id = $1 AND action = $2 AND target_id = $3`,
    [school, action, targetId],
  )
  return found.rows[0]?.count ?? 0
}

/** A new member of the suite's school, signed in (with the second factor for an office role). */
async function member(roleKeys: readonly string[], options: { mfa?: boolean; staffId?: string } = {}): Promise<{ client: Client; membershipId: string }> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `comm-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, 'Communication member', email])
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')`,
    [membershipId, school, userId],
  )
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

/**
 * A guardian of one pupil. `consent` is the newest communication consent row
 * (none at all when null); `account` links a parent membership with portal
 * access to the pupil.
 */
async function guardian(input: {
  label: string
  studentId: string
  consent: 'given' | 'withdrawn' | null
  receives?: boolean
  email?: string
  account?: boolean
}): Promise<Client | null> {
  const pool = adminPool()
  const guardianId = randomUUID()
  guardians[input.label] = guardianId
  await pool.query('INSERT INTO guardians(id,school_id,first_name,email) VALUES ($1,$2,$3,$4)', [
    guardianId,
    school,
    `Guardian ${input.label}`,
    input.email ?? null,
  ])
  await pool.query(
    `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation,receives_notifications)
     VALUES ($1,$2,$3,'mother',$4)`,
    [school, input.studentId, guardianId, input.receives ?? true],
  )
  if (input.consent !== null) {
    await pool.query(
      `INSERT INTO guardian_consents(school_id,student_id,guardian_id,purpose,status,method,recorded_by_membership_id,recorded_at)
       VALUES ($1,$2,$3,'communication','given','signed_form',$4,now() - interval '1 day')`,
      [school, input.studentId, guardianId, ownerMembership],
    )
    if (input.consent === 'withdrawn')
      await pool.query(
        `INSERT INTO guardian_consents(school_id,student_id,guardian_id,purpose,status,method,recorded_by_membership_id)
         VALUES ($1,$2,$3,'communication','withdrawn','portal',$4)`,
        [school, input.studentId, guardianId, ownerMembership],
      )
  }
  if (!input.account) return null
  const { client, membershipId } = await member(['parent'])
  await pool.query(
    `INSERT INTO membership_guardian_links(school_id,membership_id,guardian_id,verified_at) VALUES ($1,$2,$3,now())`,
    [school, membershipId, guardianId],
  )
  await pool.query(
    `INSERT INTO guardian_student_access(school_id,guardian_id,student_id,status,areas,approved_by_membership_id,approved_at)
     VALUES ($1,$2,$3,'approved',ARRAY['basic'],$4,now())`,
    [school, guardianId, input.studentId, ownerMembership],
  )
  return client
}

async function staffRow(label: string): Promise<string> {
  const id = randomUUID()
  await adminPool().query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status)
     VALUES ($1,$2,$3,$4,'teaching','Teacher','active')`,
    [id, school, `COM-${suffix}-${label}`, `Teacher ${label}`],
  )
  return id
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,'COM')`, [
    school,
    `comm-${suffix}`,
    `Communication School ${suffix}`,
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
    [year, school, `COM-${suffix}`],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [school, year])
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,'Class 6','C6',6)`, [
    grade,
    school,
  ])
  await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,'English',$3,'scholastic')`, [
    subject,
    school,
    `COM${suffix}`,
  ])
  const classTeacherStaff = await staffRow('class')
  subjectTeacherStaff = await staffRow('subject')
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id)
     VALUES ($1,$2,$3,$4,'A',$5),($6,$2,$3,$4,'B',NULL)`,
    [section, school, year, grade, classTeacherStaff, otherSection],
  )
  await pool.query(
    `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from)
     VALUES ($1,$2,$3,$4,$5,current_date - 100)`,
    [school, subjectTeacherStaff, year, section, subject],
  )
  for (const [index, id] of [pupilConsent, pupilOff, pupilNone, pupilNoContact, pupilEmail].entries()) {
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,$4,'Pupil','active')`,
      [id, school, `COM/${suffix}/${index}`, `Pupil${index}`],
    )
    await pool.query(
      `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,$5,current_date - 100)`,
      [school, id, year, section, index + 1],
    )
  }

  server = await startTestServer()
  deps = { pools: server.pools, delivery: server.delivery, documents: server.documents, config: server.config }
  const office = await member(['owner'], { mfa: true })
  owner = office.client
  ownerMembership = office.membershipId
  classTeacher = (await member(['teacher'], { staffId: classTeacherStaff })).client
  const subjectOne = await member(['teacher'], { staffId: subjectTeacherStaff })
  subjectTeacher = subjectOne.client
  subjectTeacherMembership = subjectOne.membershipId

  parent = (await guardian({ label: 'consent', studentId: pupilConsent, consent: 'given', account: true })) as Client
  // The other guardian of the same pupil withdrew the agreement.
  withdrawnParent = (await guardian({
    label: 'withdrawn',
    studentId: pupilConsent,
    consent: 'withdrawn',
    account: true,
  })) as Client
  await guardian({ label: 'off', studentId: pupilOff, consent: 'given', receives: false, account: true })
  await guardian({ label: 'none', studentId: pupilNone, consent: null, account: true })
  await guardian({ label: 'nocontact', studentId: pupilNoContact, consent: 'given', email: `family-${suffix}@school.test` })
  await guardian({ label: 'email', studentId: pupilEmail, consent: 'given', email: `family.${suffix}@gmail.com` })
})

after(async () => {
  await server?.close()
  await closeAdminPool()
})

test('settings: the defaults as version 1, the first save inserts the row, a stale version conflicts', async () => {
  const first = await ok<Settings & Record<string, unknown>>(await owner.fetch(path('/settings')))
  assert.equal(first.version, 1)
  assert.equal(first.absenceDelayMinutes, 30)
  const { version: _version, wording: _wording, allowedActions: _actions, ...values } = first
  const saved = await ok<Settings>(
    await owner.fetch(path('/settings'), send('PUT', { ...values, absenceDelayMinutes: 45, expectedVersion: 1 })),
  )
  assert.equal(saved.version, 2)
  assert.equal(saved.absenceDelayMinutes, 45)
  const row = await adminPool().query('SELECT absence_delay_minutes FROM communication_settings WHERE school_id = $1', [school])
  assert.equal(row.rows[0]?.absence_delay_minutes, 45)
  await refused(
    await owner.fetch(path('/settings'), send('PUT', { ...values, expectedVersion: 1 })),
    409,
  )
  // The teacher does not manage the settings.
  await refused(await classTeacher.fetch(path('/settings')), 403)
})

test('templates: an automatic kind replaces the live one, archiving puts the built-in words back', async () => {
  const notice = await ok<Template>(
    await owner.fetch(path('/templates'), send('POST', { kind: 'notice', name: 'Holiday', title: 'Holiday', body: 'The school is closed. {school}' })),
    201,
  )
  assert.equal(notice.archived, false)
  await refused(
    await owner.fetch(
      path('/templates'),
      send('POST', { kind: 'birthday_staff', name: 'Wrong', title: 'Hi {pupil_first_name}', body: 'Hello' }),
    ),
    400,
    'message_placeholder_unknown',
  )
  const one = await ok<Template>(
    await owner.fetch(path('/templates'), send('POST', { kind: 'absence', name: 'Absence one', title: '{pupil_first_name} absent', body: 'Absent on {date}.' })),
    201,
  )
  const two = await ok<Template>(
    await owner.fetch(path('/templates'), send('POST', { kind: 'absence', name: 'Absence two', title: '{pupil_first_name} is away', body: 'Away on {date}.' })),
    201,
  )
  const all = await ok<{ items: Template[] }>(await owner.fetch(path('/templates?show=all&kind=absence')))
  assert.equal(all.items.find((item) => item.id === one.id)?.archived, true)
  assert.equal(all.items.find((item) => item.id === two.id)?.archived, false)
  let settings = await ok<Settings>(await owner.fetch(path('/settings')))
  assert.equal(settings.wording.find((row) => row.kind === 'absence')?.templateId, two.id)

  await ok<Template>(await owner.fetch(path(`/templates/${two.id}/archive`), send('POST', { expectedVersion: two.version })))
  settings = await ok<Settings>(await owner.fetch(path('/settings')))
  const absence = settings.wording.find((row) => row.kind === 'absence')
  assert.equal(absence?.templateId, undefined)
  assert.equal(absence?.title, '{pupil_first_name} is absent today')
  // An archived template cannot start a notice.
  await ok(await owner.fetch(path(`/templates/${notice.id}/archive`), send('POST', { expectedVersion: notice.version })))
  await refused(
    await owner.fetch(
      path(''),
      send('POST', { audience: { kind: 'school' }, title: 'Closed', body: 'Closed', templateId: notice.id }),
    ),
    400,
    'message_template_archived',
  )
})

let sectionMessage: Detail

test('a draft is written, changed, carries files, and goes out to the right people', async () => {
  // A section notice goes to many families and may name only the school.
  await refused(
    await owner.fetch(path(''), send('POST', { audience: { kind: 'section', sectionId: section }, title: 'Hi {pupil_first_name}', body: 'x' })),
    400,
    'message_placeholder_unknown',
  )
  let message = await draft(owner, { kind: 'section', sectionId: section }, 'Sports day', 'Sports day at {school} is on Friday.')
  assert.equal(message.status, 'draft')
  assert.equal(message.body, `Sports day at Communication School ${suffix} is on Friday.`)
  message = await ok<Detail>(
    await owner.fetch(path(`/${message.id}`), send('PATCH', { expectedVersion: message.version, title: 'Sports day on Friday' })),
  )
  assert.equal(message.title, 'Sports day on Friday')
  await refused(
    await owner.fetch(path(`/${message.id}`), send('PATCH', { expectedVersion: 1, title: 'Stale' })),
    409,
  )

  const upload = (bytes: Uint8Array<ArrayBuffer>, name: string, version: number) =>
    owner.fetch(path(`/${message.id}/attachments?expectedVersion=${version}&fileName=${encodeURIComponent(name)}`), {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: bytes,
    })
  const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n')
  message = await ok<Detail>(await upload(pdf, 'circular.pdf', message.version))
  assert.equal(message.attachments.length, 1)
  assert.equal(message.attachments[0]?.contentType, 'application/pdf')

  const tooLarge = new Uint8Array(3 * 1024 * 1024)
  tooLarge.set(pdf)
  const large = await upload(tooLarge, 'large.pdf', message.version)
  assert.equal(large.status, 413)
  await refused(await upload(new TextEncoder().encode('just some words'), 'notes.pdf', message.version), 400, 'message_attachment_type')

  message = await ok<Detail>(await upload(pdf, 'two.pdf', message.version))
  message = await ok<Detail>(await upload(pdf, 'three.pdf', message.version))
  assert.equal(message.attachments.length, 3)
  await refused(await upload(pdf, 'four.pdf', message.version), 400, 'message_too_many_attachments')

  // The file reads back through the permission-checked route.
  const file = await owner.fetch(path(`/${message.id}/attachments/${message.attachments[0]?.id}`))
  assert.equal(file.status, 200)
  assert.match(file.headers.get('cache-control') ?? '', /no-store/)
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff')
  assert.ok(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString('latin1') === '%PDF-')

  const sent = await sendNow(owner, message)
  assert.equal(sent.status, 'sent')
  sectionMessage = sent

  const rows = await recipientsOf(sent.id)
  assert.equal(rows.size, 6)
  const expect = (label: string, outcome: string, inApp: boolean, email: string) => {
    const row = rows.get(guardians[label] ?? '')
    assert.ok(row, `a row for ${label}`)
    assert.equal(row.outcome, outcome, label)
    assert.equal(row.in_app, inApp, label)
    if (email !== 'any') assert.equal(row.email_status, email, label)
  }
  expect('consent', 'delivered', true, 'none')
  expect('withdrawn', 'no_consent', false, 'none')
  expect('off', 'not_receiving', false, 'none')
  expect('none', 'no_consent', false, 'none')
  expect('nocontact', 'no_contact', false, 'none')
  expect('email', 'delivered', false, 'any')
})

test('the inbox shows the message to the family that agreed, and a read is recorded once', async () => {
  const inbox = await ok<Inbox>(await parent.fetch(path('/inbox')))
  const item = inbox.items.find((row) => row.messageId === sectionMessage.id)
  assert.ok(item, 'the parent with consent has it')
  assert.equal(inbox.unread, 1)
  const withdrawn = await ok<Inbox>(await withdrawnParent.fetch(path('/inbox')))
  assert.equal(withdrawn.items.length, 0)
  await refused(await withdrawnParent.fetch(path(`/${sectionMessage.id}`)), 404)

  const detail = await ok<Detail>(await parent.fetch(path(`/${sectionMessage.id}`)))
  assert.equal(detail.myReceipt?.recipientId, item.recipientId)
  assert.equal(detail.counts, undefined, 'a recipient sees no delivery counts')

  const first = await ok<{ readAt: string }>(await parent.fetch(path(`/inbox/${item.recipientId}/read`), send('POST', {})))
  const again = await ok<{ readAt: string }>(await parent.fetch(path(`/inbox/${item.recipientId}/read`), send('POST', {})))
  assert.equal(again.readAt, first.readAt)
  assert.equal(await auditCount('communication.read', item.recipientId), 1)
  // Another person's row is not theirs to mark.
  await refused(await withdrawnParent.fetch(path(`/inbox/${item.recipientId}/read`), send('POST', {})), 404)

  const unread = await ok<{ unread: number }>(await parent.fetch(path('/inbox/unread')))
  assert.equal(unread.unread, 0)

  const counted = await ok<Detail>(await owner.fetch(path(`/${sectionMessage.id}`)))
  assert.deepEqual(
    {
      recipients: counted.counts?.recipients,
      delivered: counted.counts?.delivered,
      noConsent: counted.counts?.noConsent,
      notReceiving: counted.counts?.notReceiving,
      noContact: counted.counts?.noContact,
      inApp: counted.counts?.inApp,
      read: counted.counts?.read,
    },
    { recipients: 6, delivered: 2, noConsent: 2, notReceiving: 1, noContact: 1, inApp: 1, read: 1 },
  )
})

test('a schedule in the past or too far ahead is refused; a scheduled message goes when the pump runs', async () => {
  const message = await draft(owner, { kind: 'pupil', studentId: pupilConsent }, 'Meeting', 'Please meet the class teacher.')
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()
  await refused(
    await owner.fetch(path(`/${message.id}/send`), send('POST', { expectedVersion: message.version, sendAt: at(1) })),
    400,
    'message_schedule_in_past',
  )
  await refused(
    await owner.fetch(path(`/${message.id}/send`), send('POST', { expectedVersion: message.version, sendAt: at(61 * 24 * 60) })),
    400,
    'message_schedule_too_far',
  )
  const scheduled = await ok<Detail>(
    await owner.fetch(path(`/${message.id}/send`), send('POST', { expectedVersion: message.version, sendAt: at(10) })),
  )
  assert.equal(scheduled.status, 'scheduled')
  await pump()
  assert.equal((await ok<Detail>(await owner.fetch(path(`/${message.id}`)))).status, 'scheduled', 'not before its time')

  await adminPool().query(`UPDATE messages SET send_at = now() - interval '1 minute' WHERE id = $1`, [message.id])
  const counts = await pump()
  assert.equal(counts.scheduled_sent, 1, JSON.stringify(counts))
  const sent = await ok<Detail>(await owner.fetch(path(`/${message.id}`)))
  assert.equal(sent.status, 'sent')
  const inbox = await ok<Inbox>(await parent.fetch(path('/inbox')))
  assert.ok(inbox.items.some((row) => row.messageId === message.id))
})

test('a teacher whose assignment ended before the pump ran sends nothing', async () => {
  const message = await draft(subjectTeacher, { kind: 'section', sectionId: section }, 'Homework', 'Read chapter four.')
  const scheduled = await ok<Detail>(
    await subjectTeacher.fetch(
      path(`/${message.id}/send`),
      send('POST', { expectedVersion: message.version, sendAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
    ),
  )
  assert.equal(scheduled.status, 'scheduled')
  const pool = adminPool()
  await pool.query(
    `UPDATE teaching_assignments SET effective_to = current_date - 1 WHERE school_id = $1 AND staff_id = $2`,
    [school, subjectTeacherStaff],
  )
  await pool.query(
    'UPDATE school_memberships SET access_version = access_version + 1, version = version + 1 WHERE id = $1',
    [subjectTeacherMembership],
  )
  await pool.query(`UPDATE messages SET send_at = now() - interval '1 minute' WHERE id = $1`, [message.id])
  const counts = await pump()
  assert.equal(counts.scheduled_cancelled, 1)
  const row = await pool.query<{ status: string; cancel_reason: string }>(
    'SELECT status, cancel_reason FROM messages WHERE id = $1',
    [message.id],
  )
  assert.deepEqual(row.rows[0], { status: 'cancelled', cancel_reason: 'author_lost_access' })
  assert.equal((await recipientsOf(message.id)).size, 0)
  // And the section is no longer theirs to write to. They reach no section
  // at all now, so the route refuses before it looks at the section.
  await refused(
    await subjectTeacher.fetch(path(''), send('POST', { audience: { kind: 'section', sectionId: section }, title: 'x', body: 'y' })),
    403,
  )
})

test('the class teacher writes to their own section and to nothing wider', async () => {
  const message = await draft(classTeacher, { kind: 'section', sectionId: section }, 'Picnic', 'Picnic on Monday.')
  assert.equal(message.status, 'draft')
  // The school and the staff exist, so the refusal says so; a section they
  // do not teach reads as missing.
  await refused(
    await classTeacher.fetch(path(''), send('POST', { audience: { kind: 'school' }, title: 'x', body: 'y' })),
    403,
  )
  await refused(
    await classTeacher.fetch(path(''), send('POST', { audience: { kind: 'section', sectionId: otherSection }, title: 'x', body: 'y' })),
    404,
  )
  // Nobody else sees the draft, the office included.
  await refused(await owner.fetch(path(`/${message.id}`)), 404)
  await ok(await classTeacher.fetch(path(`/${message.id}?expectedVersion=${message.version}`), { method: 'DELETE' }), 204)
})

test('withdrawing hides a message from every inbox and cancels the emails still waiting', async () => {
  const message = await sendNow(owner, await draft(owner, { kind: 'section', sectionId: section }, 'Trip', 'The trip is on.'))
  const pool = adminPool()
  // Whatever the background pump did, the email is waiting again.
  await pump()
  await pool.query(
    `UPDATE message_recipients SET email_status = 'pending', email_sent_at = NULL, email_next_attempt_at = now() + interval '1 hour'
      WHERE school_id = $1 AND message_id = $2 AND guardian_id = $3`,
    [school, message.id, guardians.email],
  )
  assert.ok((await ok<Inbox>(await parent.fetch(path('/inbox')))).items.some((row) => row.messageId === message.id))

  await refused(
    await owner.fetch(path(`/${message.id}/withdraw`), send('POST', { expectedVersion: message.version + 5, reason: 'Sent by mistake.' })),
    409,
  )
  const withdrawn = await ok<Detail>(
    await owner.fetch(path(`/${message.id}/withdraw`), send('POST', { expectedVersion: message.version, reason: 'Sent by mistake.' })),
  )
  assert.equal(withdrawn.status, 'withdrawn')
  assert.ok(!(await ok<Inbox>(await parent.fetch(path('/inbox')))).items.some((row) => row.messageId === message.id))
  await refused(await parent.fetch(path(`/${message.id}`)), 404)
  const email = (await recipientsOf(message.id)).get(guardians.email ?? '')
  assert.equal(email?.email_status, 'cancelled')

  const note = await pool.query<{ note: string }>(
    `SELECT n.note FROM audit_events e JOIN audit_event_notes n ON n.school_id = e.school_id AND n.audit_event_id = e.id
      WHERE e.school_id = $1 AND e.target_id = $2`,
    [school, message.id],
  )
  assert.deepEqual(note.rows.map((row) => row.note), ['Sent by mistake.'])
  // A withdrawn message cannot be withdrawn again.
  await refused(
    await owner.fetch(path(`/${message.id}/withdraw`), send('POST', { expectedVersion: withdrawn.version, reason: 'Again.' })),
    400,
    'message_not_sent',
  )
})
