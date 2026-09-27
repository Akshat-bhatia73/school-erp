/**
 * Saving and sending in one step (Task 24c): `send` on a new message and on a
 * change. The step runs exactly what the send and unschedule routes run, in
 * the same transaction as the save, so a refused send leaves nothing behind
 * and every request writes one audit row.
 *
 * The suite builds a school of its own: one class of two sections, a class
 * teacher of the first, and one pupil in each with a family that agreed to
 * messages (and has no account, so the pump has nothing to do for it).
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
} from './harness.ts'

const PASSWORD = 'Fixture-Pass!42'
const suffix = randomUUID().slice(0, 8)

const school = randomUUID()
const year = randomUUID()
const grade = randomUUID()
const section = randomUUID()
const otherSection = randomUUID()
const pupil = randomUUID()
const otherPupil = randomUUID()

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client
let classTeacher: Client
let ownerMembership = ''

interface ErrorBody {
  error: { code: string; reason?: string }
}
interface Detail {
  id: string
  status: string
  title: string
  body: string
  version: number
  sendAt?: string
}

const path = (rest: string) => `/api/schools/${school}/messages${rest}`
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

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

async function create(client: Client, value: Record<string, unknown>, status = 201): Promise<Response> {
  const response = await client.fetch(path(''), send('POST', { title: 'Sports day', body: 'Sports day is on Friday.', ...value }))
  if (status === 201) assert.equal(response.status, 201)
  return response
}

async function messageCount(): Promise<number> {
  const found = await adminPool().query<{ count: number }>(
    'SELECT count(*)::int AS count FROM messages WHERE school_id = $1',
    [school],
  )
  return found.rows[0]?.count ?? 0
}

async function recipientCount(messageId: string): Promise<number> {
  const found = await adminPool().query<{ count: number }>(
    'SELECT count(*)::int AS count FROM message_recipients WHERE school_id = $1 AND message_id = $2',
    [school, messageId],
  )
  return found.rows[0]?.count ?? 0
}

/** Every audit row about one message, oldest first. */
async function auditRows(messageId: string): Promise<{ action: string; summary: string; safe_changes: Record<string, unknown> }[]> {
  const found = await adminPool().query<{ action: string; summary: string; safe_changes: Record<string, unknown> }>(
    `SELECT action, summary, safe_changes FROM audit_events
      WHERE school_id = $1 AND target_id = $2 ORDER BY created_at, id`,
    [school, messageId],
  )
  return found.rows
}

async function member(roleKeys: readonly string[], options: { mfa?: boolean; staffId?: string } = {}): Promise<{ client: Client; membershipId: string }> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `step-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, 'Send step member', email])
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

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,'STP')`, [
    school,
    `step-${suffix}`,
    `Send Step School ${suffix}`,
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
    [year, school, `STP-${suffix}`],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [school, year])
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,'Class 7','C7',7)`, [
    grade,
    school,
  ])
  const teacherStaff = randomUUID()
  await pool.query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status)
     VALUES ($1,$2,$3,'Teacher','teaching','Teacher','active')`,
    [teacherStaff, school, `STP-${suffix}`],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id)
     VALUES ($1,$2,$3,$4,'A',$5),($6,$2,$3,$4,'B',NULL)`,
    [section, school, year, grade, teacherStaff, otherSection],
  )
  for (const [index, [id, sectionId]] of [
    [pupil, section],
    [otherPupil, otherSection],
  ].entries()) {
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,$4,'Pupil','active')`,
      [id, school, `STP/${suffix}/${index}`, `Pupil${index}`],
    )
    await pool.query(
      `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,1,current_date - 100)`,
      [school, id, year, sectionId],
    )
  }

  server = await startTestServer()
  const office = await member(['owner'], { mfa: true })
  owner = office.client
  ownerMembership = office.membershipId
  classTeacher = (await member(['teacher'], { staffId: teacherStaff })).client

  for (const id of [pupil, otherPupil]) {
    const guardianId = randomUUID()
    await pool.query('INSERT INTO guardians(id,school_id,first_name) VALUES ($1,$2,$3)', [guardianId, school, 'Guardian'])
    await pool.query(
      `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation,receives_notifications)
       VALUES ($1,$2,$3,'mother',true)`,
      [school, id, guardianId],
    )
    await pool.query(
      `INSERT INTO guardian_consents(school_id,student_id,guardian_id,purpose,status,method,recorded_by_membership_id,recorded_at)
       VALUES ($1,$2,$3,'communication','given','signed_form',$4,now() - interval '1 day')`,
      [school, id, guardianId, ownerMembership],
    )
  }
})

after(async () => {
  await server?.close()
  await closeAdminPool()
})

test('a new message sent now: recipients recorded, one audit row that says it was sent', async () => {
  const sent = await ok<Detail>(
    await create(owner, { audience: { kind: 'section', sectionId: section }, send: { when: 'now' } }),
    201,
  )
  assert.equal(sent.status, 'sent')
  assert.equal(await recipientCount(sent.id), 1)
  const rows = await auditRows(sent.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.action, 'communication.send')
  assert.equal(rows[0]?.summary, 'Sent a message.')
  assert.equal(rows[0]?.safe_changes.status, 'sent')
  assert.equal(rows[0]?.safe_changes.recipients, 1)
  assert.equal(rows[0]?.safe_changes.scheduled, false)
  // Never the words.
  assert.ok(!JSON.stringify(rows[0]).includes('Friday'))
})

test('a new message kept as a draft, with or without saying so', async () => {
  for (const extra of [{}, { send: { when: 'draft' } }]) {
    const draft = await ok<Detail>(await create(owner, { audience: { kind: 'school' }, ...extra }), 201)
    assert.equal(draft.status, 'draft')
    assert.equal(draft.version, 1)
    assert.equal(await recipientCount(draft.id), 0)
    const rows = await auditRows(draft.id)
    assert.deepEqual(rows.map((row) => row.summary), ['Wrote a message draft.'])
  }
})

test('a new message scheduled inside the window; outside it nothing is left behind', async () => {
  const before = await messageCount()
  await refused(
    await create(owner, { audience: { kind: 'school' }, send: { when: 'at', sendAt: at(1) } }, 400),
    400,
    'message_schedule_in_past',
  )
  await refused(
    await create(owner, { audience: { kind: 'school' }, send: { when: 'at', sendAt: at(61 * 24 * 60) } }, 400),
    400,
    'message_schedule_too_far',
  )
  assert.equal(await messageCount(), before, 'no draft left behind by a refused schedule')

  const sendAt = at(30)
  const scheduled = await ok<Detail>(
    await create(owner, { audience: { kind: 'school' }, send: { when: 'at', sendAt } }),
    201,
  )
  assert.equal(scheduled.status, 'scheduled')
  assert.equal(new Date(scheduled.sendAt ?? '').getTime(), new Date(sendAt).getTime())
  assert.equal(await recipientCount(scheduled.id), 0)
  const rows = await auditRows(scheduled.id)
  assert.deepEqual(rows.map((row) => row.summary), ['Scheduled a message.'])
  assert.equal(rows[0]?.safe_changes.scheduled, true)
  assert.equal(rows[0]?.safe_changes.rescheduled, false)
})

test('a teacher refused for a section they do not teach leaves no row, whatever the send', async () => {
  const before = await messageCount()
  for (const choice of [{ when: 'now' }, { when: 'at', sendAt: at(30) }, { when: 'draft' }]) {
    await refused(
      await create(classTeacher, { audience: { kind: 'section', sectionId: otherSection }, send: choice }, 404),
      404,
    )
  }
  // Their own section goes.
  const own = await ok<Detail>(
    await create(classTeacher, { audience: { kind: 'section', sectionId: section }, send: { when: 'now' } }),
    201,
  )
  assert.equal(own.status, 'sent')
  assert.equal(await messageCount(), before + 1)
})

test('a change to the words and a send in one step', async () => {
  const draft = await ok<Detail>(await create(owner, { audience: { kind: 'section', sectionId: section } }), 201)
  const sent = await ok<Detail>(
    await owner.fetch(
      path(`/${draft.id}`),
      send('PATCH', { expectedVersion: draft.version, title: 'Sports day moved', send: { when: 'now' } }),
    ),
  )
  assert.equal(sent.status, 'sent')
  assert.equal(sent.title, 'Sports day moved')
  assert.ok(sent.version > draft.version)
  assert.equal(await recipientCount(draft.id), 1)
  const rows = await auditRows(draft.id)
  assert.deepEqual(rows.map((row) => row.summary), ['Wrote a message draft.', 'Changed and sent a message.'])
  assert.deepEqual(rows[1]?.safe_changes.changed, ['title', 'body'])
  assert.equal(rows[1]?.safe_changes.status, 'sent')

  // A sent message cannot be changed or sent again this way.
  await refused(
    await owner.fetch(path(`/${draft.id}`), send('PATCH', { expectedVersion: sent.version, send: { when: 'now' } })),
    400,
    'message_not_editable',
  )
})

test('a stale version refuses the change and the send together', async () => {
  const draft = await ok<Detail>(await create(owner, { audience: { kind: 'section', sectionId: section } }), 201)
  await refused(
    await owner.fetch(
      path(`/${draft.id}`),
      send('PATCH', { expectedVersion: draft.version + 3, title: 'Stale', send: { when: 'now' } }),
    ),
    409,
  )
  const stored = await ok<Detail>(await owner.fetch(path(`/${draft.id}`)))
  assert.equal(stored.status, 'draft')
  assert.equal(stored.title, 'Sports day')
  assert.equal(await recipientCount(draft.id), 0)
  assert.equal((await auditRows(draft.id)).length, 1)
})

test('a scheduled message: its time moved, then sent now, with nothing but the send', async () => {
  const scheduled = await ok<Detail>(
    await create(owner, { audience: { kind: 'school' }, send: { when: 'at', sendAt: at(30) } }),
    201,
  )
  // Outside the window the time stays as it was.
  await refused(
    await owner.fetch(
      path(`/${scheduled.id}`),
      send('PATCH', { expectedVersion: scheduled.version, send: { when: 'at', sendAt: at(2) } }),
    ),
    400,
    'message_schedule_in_past',
  )
  const later = at(120)
  const moved = await ok<Detail>(
    await owner.fetch(
      path(`/${scheduled.id}`),
      send('PATCH', { expectedVersion: scheduled.version, send: { when: 'at', sendAt: later } }),
    ),
  )
  assert.equal(moved.status, 'scheduled')
  assert.equal(new Date(moved.sendAt ?? '').getTime(), new Date(later).getTime())
  assert.equal(moved.version, scheduled.version + 1, 'nothing changed, so one bump')

  const sent = await ok<Detail>(
    await owner.fetch(path(`/${scheduled.id}`), send('PATCH', { expectedVersion: moved.version, send: { when: 'now' } })),
  )
  assert.equal(sent.status, 'sent')
  assert.equal(await recipientCount(scheduled.id), 2)
  const rows = await auditRows(scheduled.id)
  assert.deepEqual(rows.map((row) => row.summary), ['Scheduled a message.', 'Scheduled a message.', 'Sent a message.'])
  assert.equal(rows[1]?.safe_changes.rescheduled, true)
})

test('back to a draft: the author keeps it; a manager is answered once and then it is gone from them', async () => {
  // The author's own scheduled message, changed and taken back in one step.
  const own = await ok<Detail>(
    await create(owner, { audience: { kind: 'school' }, send: { when: 'at', sendAt: at(30) } }),
    201,
  )
  const back = await ok<Detail>(
    await owner.fetch(
      path(`/${own.id}`),
      send('PATCH', { expectedVersion: own.version, body: 'New words.', send: { when: 'draft' } }),
    ),
  )
  assert.equal(back.status, 'draft')
  assert.equal(back.body, 'New words.')
  assert.equal(back.sendAt, undefined)
  const rows = await auditRows(own.id)
  assert.deepEqual(rows.map((row) => row.summary), ['Scheduled a message.', 'Changed a message and took it back to a draft.'])

  // `draft` on a draft changes nothing more than the words.
  const still = await ok<Detail>(
    await owner.fetch(path(`/${own.id}`), send('PATCH', { expectedVersion: back.version, send: { when: 'draft' } })),
  )
  assert.equal(still.status, 'draft')
  assert.equal((await auditRows(own.id)).at(-1)?.summary, 'Changed a message.')

  // The teacher's scheduled message, taken back by the office.
  const theirs = await ok<Detail>(
    await create(classTeacher, {
      audience: { kind: 'section', sectionId: section },
      send: { when: 'at', sendAt: at(30) },
    }),
    201,
  )
  const taken = await ok<Detail>(
    await owner.fetch(path(`/${theirs.id}`), send('PATCH', { expectedVersion: theirs.version, send: { when: 'draft' } })),
  )
  assert.equal(taken.status, 'draft')
  const taking = (await auditRows(theirs.id)).at(-1)
  assert.equal(taking?.action, 'communication.manage')
  assert.equal(taking?.summary, 'Took a scheduled message back to a draft.')
  // From now on the draft is its author's alone.
  await refused(await owner.fetch(path(`/${theirs.id}`)), 404)
  assert.equal((await ok<Detail>(await classTeacher.fetch(path(`/${theirs.id}`)))).status, 'draft')
})

test('the send route still works on its own', async () => {
  const draft = await ok<Detail>(await create(owner, { audience: { kind: 'pupil', studentId: pupil } }), 201)
  const sent = await ok<Detail>(
    await owner.fetch(path(`/${draft.id}/send`), send('POST', { expectedVersion: draft.version })),
  )
  assert.equal(sent.status, 'sent')
  assert.equal(await recipientCount(draft.id), 1)
  assert.deepEqual((await auditRows(draft.id)).map((row) => row.summary), ['Wrote a message draft.', 'Sent a message.'])
})
