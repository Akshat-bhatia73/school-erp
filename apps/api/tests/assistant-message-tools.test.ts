/**
 * The assistant's message tools (Task 24c): a new notice, a change to a draft
 * or scheduled one, and withdrawing a sent one.
 *
 * Each tool reads through the same GET routes as the person and builds an
 * editable preview; it never writes. These tests run each tool against the
 * real server through a test context whose `get` is an ordinary signed-in
 * request, then send the request `write` builds through the real message
 * routes as the same person and read the message back. The clock parts
 * (a time on the school's clock as a moment, the scheduling window) are
 * tested on their own with a fixed "now".
 *
 * The suite builds a school of its own, so nothing it writes is seen by
 * another file.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import {
  MessageDetail,
  MessagePreview,
  MessageWithdrawPreview,
  ROLE_TEMPLATES,
  type AssistantProposalPreview,
  type PermissionKey,
} from '@erp/contracts'
import { proposeToolNamed, proposeToolsFor } from '../src/assistant/proposals/registry.ts'
import {
  messageToolParts,
  parseTime,
  knownZone,
  schoolTimeLabel,
  schoolTimeToUtc,
} from '../src/assistant/proposals/messages.ts'
import type { AnyProposeTool, PrepareOutcome, ProposalDraft, WriteRequest } from '../src/assistant/proposals/types.ts'
import type { RouteAnswer, ToolCallContext } from '../src/assistant/tools/types.ts'
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
const class6 = randomUUID()
const class7 = randomUUID()
const class8 = randomUUID()
const class9 = randomUUID()
const nineA = randomUUID()
const nineB = randomUUID()

const kabir = randomUUID()
const riyaS = randomUUID()
const riyaP = randomUUID()
const outsider = randomUUID()

const teacherStaff = randomUUID()
const officeStaff = randomUUID()

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client
let teacher: Client
let today = ''

const json = (method: string, value: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
})

async function ok<T>(response: Response, status = 200): Promise<T> {
  assert.equal(response.status, status, await response.clone().text())
  return (await response.json()) as T
}

/** A tool context whose `get` is a real HTTP GET as the signed-in client. */
function contextFor(client: Client): ToolCallContext {
  return {
    schoolId: school,
    today,
    academicYearId: year,
    async get(path, query): Promise<RouteAnswer> {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined) search.set(key, String(value))
      }
      const suffixPart = search.size > 0 ? `?${search.toString()}` : ''
      const response = await client.fetch(`/api/schools/${school}${path}${suffixPart}`)
      const text = await response.text()
      const body: unknown = text === '' ? null : JSON.parse(text)
      if (response.ok) return { ok: true, status: response.status, body }
      const code = (body as { error?: { code?: string } } | null)?.error?.code ?? 'UNKNOWN'
      return { ok: false, status: response.status, code }
    },
  }
}

function tool(name: string): AnyProposeTool {
  const found = proposeToolNamed(name)
  assert.ok(found, `no tool named ${name}`)
  return found
}

async function prepare(client: Client, name: string, input: Record<string, unknown>): Promise<PrepareOutcome<AssistantProposalPreview>> {
  const definition = tool(name)
  const parsed = definition.input.parse(input)
  return (definition.prepare as (input: unknown, context: ToolCallContext) => Promise<PrepareOutcome<AssistantProposalPreview>>)(
    parsed,
    contextFor(client),
  )
}

function drafted<T extends AssistantProposalPreview>(
  outcome: PrepareOutcome<AssistantProposalPreview>,
  schema: { parse(value: unknown): T },
): ProposalDraft<T> & { preview: T } {
  assert.equal(outcome.status, 'ok', JSON.stringify(outcome))
  if (outcome.status !== 'ok') throw new Error('unreachable')
  const preview = schema.parse(outcome.draft.preview)
  JSON.stringify(outcome.draft.forModel)
  assert.ok(outcome.draft.title.length > 0 && outcome.draft.title.length <= 200)
  return { ...outcome.draft, preview }
}

function problemOf(outcome: PrepareOutcome<AssistantProposalPreview>): string {
  assert.equal(outcome.status, 'invalid', JSON.stringify(outcome))
  if (outcome.status !== 'invalid') throw new Error('unreachable')
  return outcome.problem
}

const sameTarget = (name: string, original: AssistantProposalPreview, edited: AssistantProposalPreview) =>
  (tool(name).sameTarget as (a: AssistantProposalPreview, b: AssistantProposalPreview) => boolean)(original, edited)

function writeOf(name: string, preview: AssistantProposalPreview): WriteRequest | { readonly problem: string } {
  return (tool(name).write as (preview: AssistantProposalPreview) => WriteRequest | { readonly problem: string })(preview)
}

function requestOf(name: string, preview: AssistantProposalPreview): WriteRequest {
  const request = writeOf(name, preview)
  assert.ok(!('problem' in request), JSON.stringify(request))
  return request as WriteRequest
}

const describeDone = (name: string, preview: AssistantProposalPreview) =>
  (tool(name).describeDone as (preview: AssistantProposalPreview) => string)(preview)

async function send(client: Client, request: WriteRequest): Promise<Response> {
  return client.fetch(`/api/schools/${school}${request.path}`, json(request.method, request.body))
}

async function detailOf(client: Client, id: string): Promise<MessageDetail> {
  return MessageDetail.parse(await ok(await client.fetch(`/api/schools/${school}/messages/${id}`)))
}

/** A message written straight through the route, as a screen would. */
async function written(client: Client, body: Record<string, unknown>): Promise<MessageDetail> {
  return MessageDetail.parse(await ok(await client.fetch(`/api/schools/${school}/messages`, json('POST', body)), 201))
}

const clone = <T>(value: T): T => structuredClone(value)

/** An hour from now, on the school's clock, as "YYYY-MM-DD" and "HH:MM" (India's, as the context gives no clock). */
function inIndia(ms: number): { date: string; time: string } {
  const local = new Date(ms + 330 * 60_000).toISOString()
  return { date: local.slice(0, 10), time: local.slice(11, 16) }
}

async function member(input: { roleKeys: readonly string[]; label: string; staffId?: string; withMfa?: boolean }): Promise<Client> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `ai-message-${input.label}-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, `Message ${input.label}`, email])
  await pool.query(`INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')`, [
    membershipId,
    school,
    userId,
  ])
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = ANY($3::text[])`,
    [school, membershipId, [...input.roleKeys]],
  )
  if (input.staffId !== undefined) {
    await pool.query('INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)', [
      school,
      membershipId,
      input.staffId,
    ])
  }
  await setFixturePassword(server, userId, PASSWORD)
  return input.withMfa ? signInWithMfa(server, { userId, email, password: PASSWORD }) : signInWithPassword(server, email, PASSWORD)
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,'AIM')`, [
    school,
    `ai-message-${suffix}`,
    `Message School ${suffix}`,
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
    [year, school, `AIM-${suffix}`],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [school, year])
  for (const [id, number] of [
    [class6, 6],
    [class7, 7],
    [class8, 8],
    [class9, 9],
  ] as const) {
    await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,$5)`, [
      id,
      school,
      `Class ${number}`,
      String(number),
      number,
    ])
  }
  for (const [id, code, first, last] of [
    [teacherStaff, 'T1', 'Meena', 'Iyer'],
    [officeStaff, 'O1', 'Suresh', 'Kumar'],
  ] as const) {
    await pool.query(
      `INSERT INTO staff(id,school_id,employee_code,first_name,last_name,staff_type,designation,status,joining_date)
       VALUES ($1,$2,$3,$4,$5,'teaching','Teacher','active',current_date - 100)`,
      [id, school, `AIM-${suffix}-${code}`, first, last],
    )
  }
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id) VALUES ($1,$2,$3,$4,'A',$5)`,
    [nineA, school, year, class9, teacherStaff],
  )
  await pool.query(`INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,'B')`, [nineB, school, year, class9])
  const pupils: [string, string, string, string][] = [
    [kabir, 'Kabir', 'Mehta', nineA],
    [riyaS, 'Riya', 'Sharma', nineA],
    [riyaP, 'Riya', 'Patel', nineA],
    [outsider, 'Other', 'Pupil', nineB],
  ]
  for (const [index, [id, first, last, sectionId]] of pupils.entries()) {
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,$4,$5,'active')`,
      [id, school, `AIM/${suffix}/${index + 1}`, first, last],
    )
    await pool.query(
      `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,$5,$6,current_date - 100)`,
      [randomUUID(), school, id, year, sectionId, index + 1],
    )
  }

  server = await startTestServer()
  owner = await member({ roleKeys: ['owner'], label: 'owner', staffId: officeStaff, withMfa: true })
  teacher = await member({ roleKeys: ['teacher'], label: 'teacher', staffId: teacherStaff })
  today = inIndia(Date.now()).date
})

after(async () => {
  await server.close()
  await closeAdminPool()
})

// ---------------------------------------------------------------------------
// The clock.

test("a time on the school's clock becomes the right moment, across midnight too", () => {
  // 2 am on the 28th in India is 8:30 pm on the 27th in UTC: the offset is 5:30.
  assert.equal(schoolTimeToUtc('2026-09-28', { hour: 2, minute: 0 }, 'Asia/Kolkata'), '2026-09-27T20:30:00.000Z')
  assert.equal(schoolTimeToUtc('2026-09-28', { hour: 8, minute: 0 }, 'Asia/Kolkata'), '2026-09-28T02:30:00.000Z')
  // A zone that moves its clocks uses the offset of the day asked for, not today's.
  assert.equal(schoolTimeToUtc('2026-11-02', { hour: 9, minute: 0 }, 'America/New_York'), '2026-11-02T14:00:00.000Z')
  assert.equal(schoolTimeToUtc('2026-10-30', { hour: 9, minute: 0 }, 'America/New_York'), '2026-10-30T13:00:00.000Z')
  assert.equal(schoolTimeLabel('2026-09-27T20:30:00.000Z', 'Asia/Kolkata'), '28 Sep, 2:00 am')
  assert.equal(schoolTimeLabel('2026-09-28T02:30:00.000Z', 'Asia/Kolkata'), '28 Sep, 8:00 am')
  assert.equal(schoolTimeLabel('2026-09-28T10:45:00.000Z', 'Asia/Kolkata'), '28 Sep, 4:15 pm')
  assert.equal(schoolTimeLabel('2026-09-28T02:30:00.000Z', 'Asia/Dubai'), '28 Sep, 6:30 am')
  // No zone, or one nobody knows: India's.
  assert.equal(knownZone(undefined), 'Asia/Kolkata')
  assert.equal(knownZone('Mars/Olympus'), 'Asia/Kolkata')

  assert.deepEqual(parseTime('08:00'), { hour: 8, minute: 0 })
  assert.deepEqual(parseTime('8'), { hour: 8, minute: 0 })
  assert.deepEqual(parseTime('4:30 pm'), { hour: 16, minute: 30 })
  assert.deepEqual(parseTime('12 am'), { hour: 0, minute: 0 })
  assert.deepEqual(parseTime('12:15 p.m.'), { hour: 12, minute: 15 })
  assert.equal(parseTime('25:00'), null)
  assert.equal(parseTime('13 pm'), null)
  assert.equal(parseTime('tomorrow'), null)
})

test('a time too soon, too far or not a time is refused with a plain problem', () => {
  const nowMs = Date.parse('2026-09-27T20:00:00Z')
  const context = { schoolId: school, today: '2026-09-28', now: '01:30', academicYearId: null, get: async () => ({ ok: false, status: 404, code: 'x' }) } as ToolCallContext
  const { sendChoice } = messageToolParts
  // 2 am the same night, half an hour away, goes at 20:30 UTC.
  assert.deepEqual(sendChoice({ when: 'at', time: '02:00' }, context, nowMs), {
    send: { when: 'at', sendAt: '2026-09-27T20:30:00.000Z' },
    label: 'at 28 Sep, 2:00 am (school time)',
  })
  assert.match((sendChoice({ when: 'at', time: '1:32' }, context, nowMs) as { problem: string }).problem, /less than 5 minutes away/)
  assert.match((sendChoice({ when: 'at', date: '2026-09-27', time: '23:00' }, context, nowMs) as { problem: string }).problem, /has passed/)
  assert.match((sendChoice({ when: 'at', date: '2026-12-31', time: '08:00' }, context, nowMs) as { problem: string }).problem, /at most 60 days ahead/)
  assert.match((sendChoice({ when: 'at', date: '2026-02-30', time: '08:00' }, context, nowMs) as { problem: string }).problem, /is not a date/)
  assert.match((sendChoice({ when: 'at', time: 'noonish' }, context, nowMs) as { problem: string }).problem, /is not a time/)
  assert.match((sendChoice({ when: 'at' }, context, nowMs) as { problem: string }).problem, /what time/)
  assert.deepEqual(sendChoice({ when: 'now' }, context, nowMs), { send: { when: 'now' }, label: 'now' })
  assert.deepEqual(sendChoice({ when: 'draft' }, context, nowMs), { send: { when: 'draft' }, label: 'as a draft' })
})

// ---------------------------------------------------------------------------
// The definitions.

test('the three message tools are offered to whoever may send, the teacher included', () => {
  const teacherKeys = new Set<PermissionKey>(ROLE_TEMPLATES.teacher.grants.map((grant) => grant.permission))
  const offered = proposeToolsFor(teacherKeys).map((definition) => definition.name)
  for (const name of ['propose_message', 'propose_message_change', 'propose_message_withdraw']) {
    assert.ok(offered.includes(name), name)
    assert.equal(tool(name).permission, 'communication.send')
  }
  const parentKeys = new Set<PermissionKey>(ROLE_TEMPLATES.parent.grants.map((grant) => grant.permission))
  assert.ok(!proposeToolsFor(parentKeys).some((definition) => definition.name.startsWith('propose_message')))
})

// ---------------------------------------------------------------------------
// A new notice.

const NOTICE = { title: 'Picnic on Friday', body: 'The class picnic is on Friday. Please send a packed lunch.' }

test('new notice: the audience is matched as people say it, among what the person may send to', async () => {
  const audienceOf = async (said: string) =>
    drafted(await prepare(owner, 'propose_message', { audience: said, ...NOTICE, when: 'draft' }), MessagePreview).preview

  const section = await audienceOf('9A')
  assert.deepEqual(section.audience, { kind: 'section', sectionId: nineA, recipients: 'families' })
  assert.equal(section.audienceLabel, 'Class 9 A')
  assert.equal(section.pupilAudience, true)
  assert.deepEqual((await audienceOf('the parents of class 9 b')).audience, { kind: 'section', sectionId: nineB, recipients: 'families' })
  assert.deepEqual((await audienceOf('Class 9')).audience, { kind: 'grade', gradeId: class9, recipients: 'families' })
  const range = await audienceOf('Classes 6 to 8')
  assert.deepEqual(range.audience, { kind: 'grade_range', fromGradeId: class6, toGradeId: class8, recipients: 'families' })
  assert.equal(range.audienceLabel, 'Class 6 to Class 8')
  assert.deepEqual((await audienceOf('class 8 to class 7')).audience, { kind: 'grade_range', fromGradeId: class7, toGradeId: class8, recipients: 'families' })
  const whole = await audienceOf('the whole school')
  assert.deepEqual(whole.audience, { kind: 'school', recipients: 'families' })
  assert.equal(whole.audienceLabel, 'The whole school')
  const staff = await audienceOf('all staff')
  assert.deepEqual(staff.audience, { kind: 'staff' })
  assert.equal(staff.pupilAudience, false)

  const pupil = drafted(await prepare(owner, 'propose_message', { pupil: 'Kabir', recipients: 'both', ...NOTICE, when: 'draft' }), MessagePreview)
  assert.deepEqual(pupil.preview.audience, { kind: 'pupil', studentId: kabir, recipients: 'both' })
  assert.equal(pupil.preview.audienceLabel, 'Kabir Mehta, Class 9 A')

  const twins = problemOf(await prepare(owner, 'propose_message', { pupil: 'Riya', ...NOTICE, when: 'draft' }))
  assert.match(twins, /^More than one pupil could be Riya: Riya (Sharma|Patel) \(AIM\/.*\) and Riya (Sharma|Patel) \(AIM\/.*\)\. Say which one\.$/)
  assert.match(twins, /Sharma/)
  assert.match(twins, /Patel/)
  assert.match(problemOf(await prepare(owner, 'propose_message', { audience: 'Class 12', ...NOTICE, when: 'draft' })), /^You cannot send to Class 12\. You can send to the whole school, all staff, Class 6/)
  assert.match(problemOf(await prepare(owner, 'propose_message', { ...NOTICE, when: 'draft' })), /Say who the notice is for/)
  assert.match(problemOf(await prepare(owner, 'propose_message', { audience: '9A', pupil: 'Kabir', ...NOTICE, when: 'draft' })), /Say who the notice is for/)
  assert.match(problemOf(await prepare(owner, 'propose_message', { audience: 'कक्षा 9', ...NOTICE, when: 'draft' })), /English letters/)
})

test('new notice: a teacher reaches only their own section and its pupils, and the route refuses the rest', async () => {
  const own = drafted(await prepare(teacher, 'propose_message', { audience: '9 A', ...NOTICE, when: 'draft' }), MessagePreview)
  assert.equal(own.preview.audienceLabel, 'Class 9 A')
  assert.equal(own.checkPath, '/messages/audiences')

  assert.equal(
    problemOf(await prepare(teacher, 'propose_message', { audience: '9B', ...NOTICE, when: 'now' })),
    'You cannot send to 9B. You can send to Class 9 A, or to one pupil.',
  )
  assert.match(problemOf(await prepare(teacher, 'propose_message', { audience: 'Class 9', ...NOTICE, when: 'now' })), /^You cannot send to Class 9\./)
  assert.match(problemOf(await prepare(teacher, 'propose_message', { audience: 'whole school', ...NOTICE, when: 'now' })), /^You cannot send to the whole school\./)
  assert.match(problemOf(await prepare(teacher, 'propose_message', { audience: 'all staff', ...NOTICE, when: 'now' })), /^You cannot send to all staff\./)
  assert.equal(
    problemOf(await prepare(teacher, 'propose_message', { pupil: 'Other Pupil', ...NOTICE, when: 'now' })),
    'No pupil you can send to is called Other Pupil.',
  )

  // A card edited to point elsewhere is refused before any write; were it sent, the route refuses it too.
  const moved = clone(own.preview)
  moved.audience = { kind: 'section', sectionId: nineB, recipients: 'families' }
  assert.equal(sameTarget('propose_message', own.preview, moved), false)
  const refused = await send(teacher, requestOf('propose_message', moved))
  assert.equal(refused.status, 404)
})

test('new notice: placeholders are only those the audience can fill', async () => {
  const toSection = problemOf(
    await prepare(owner, 'propose_message', { audience: '9A', title: 'Hello {pupil_first_name}', body: 'From {school} about {amount}.', when: 'draft' }),
  )
  assert.equal(
    toSection,
    'The words use {pupil_first_name} and {amount}, which a notice to this audience cannot fill. It may use only {school}, or write the words out in full.',
  )
  const toPupil = drafted(
    await prepare(owner, 'propose_message', { pupil: 'Kabir', title: 'About {pupil_first_name}', body: '{pupil_name} of {class} did well. {school}', when: 'draft' }),
    MessagePreview,
  )
  const saved = MessageDetail.parse(await ok(await send(owner, requestOf('propose_message', toPupil.preview)), 201))
  assert.equal(saved.title, 'About Kabir')
  assert.equal(saved.body, `Kabir Mehta of Class 9 A did well. Message School ${suffix}`)
  // A card edited to add one the audience cannot fill is refused before the route.
  const edited = clone(toPupil.preview)
  edited.proposed.body = 'Fees of {amount} are due.'
  assert.equal(sameTarget('propose_message', toPupil.preview, edited), true)
  assert.match((writeOf('propose_message', edited) as { problem: string }).problem, /\{amount\}/)
})

test('new notice: sent now in one write, with the card\'s edits to the words and to who of the pupils it goes to', async () => {
  const name = 'propose_message'
  const draft = drafted(await prepare(teacher, name, { audience: '9A', ...NOTICE, when: 'now' }), MessagePreview)
  assert.equal(draft.title, 'Send a notice to Class 9 A')
  assert.deepEqual(draft.forModel, {
    summary: 'Sending "Picnic on Friday" to Class 9 A now.',
    to: 'Class 9 A',
    recipients: 'their families',
    when: 'now',
  })
  const preview = draft.preview
  assert.equal(preview.messageId, null)
  assert.deepEqual(preview.proposed, { ...NOTICE, send: { when: 'now' } })

  const edited = clone(preview)
  edited.proposed.title = 'Picnic on Friday, 3 Oct'
  edited.audience = { kind: 'section', sectionId: nineA, recipients: 'both' }
  assert.equal(sameTarget(name, preview, edited), true)
  assert.equal(sameTarget(name, preview, { ...clone(preview), audienceLabel: 'Class 9 B' }), false)
  assert.equal(sameTarget(name, preview, { ...clone(preview), pupilAudience: false }), false)
  assert.equal(sameTarget(name, preview, { ...clone(preview), messageId: randomUUID(), version: 1 }), false)

  const request = requestOf(name, edited)
  assert.deepEqual(request, {
    method: 'POST',
    path: '/messages',
    body: {
      audience: { kind: 'section', sectionId: nineA, recipients: 'both' },
      title: 'Picnic on Friday, 3 Oct',
      body: NOTICE.body,
      send: { when: 'now' },
    },
  })
  const sent = MessageDetail.parse(await ok(await send(teacher, request), 201))
  assert.equal(sent.status, 'sent')
  assert.equal(sent.audience.recipients, 'both')
  assert.equal(describeDone(name, edited), 'Sent the notice to Class 9 A.')

  // The whole staff: nobody to choose among, and the card cannot add anybody.
  const staff = drafted(await prepare(owner, name, { audience: 'all staff', ...NOTICE, when: 'now' }), MessagePreview).preview
  assert.equal(sameTarget(name, staff, { ...clone(staff), audience: { kind: 'school', recipients: 'families' } }), false)
})

test('new notice: scheduled for a time on the school\'s clock, or kept as a draft', async () => {
  const name = 'propose_message'
  const at = inIndia(Date.now() + 2 * 3_600_000)
  const draft = drafted(await prepare(owner, name, { audience: 'Class 9', ...NOTICE, when: 'at', date: at.date, time: at.time }), MessagePreview)
  assert.equal(draft.title, 'Schedule a notice to Class 9')
  const choice = draft.preview.proposed.send
  assert.equal(choice.when, 'at')
  if (choice.when !== 'at') throw new Error('unreachable')
  assert.equal(choice.sendAt, new Date(Date.parse(`${at.date}T${at.time}:00+05:30`)).toISOString())
  const scheduled = MessageDetail.parse(await ok(await send(owner, requestOf(name, draft.preview)), 201))
  assert.equal(scheduled.status, 'scheduled')
  assert.equal(Date.parse(scheduled.sendAt!), Date.parse(choice.sendAt))
  assert.match(describeDone(name, draft.preview), /^Scheduled the notice for \d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} (am|pm)\.$/)

  const kept = drafted(await prepare(owner, name, { audience: '9B', ...NOTICE, when: 'draft' }), MessagePreview)
  assert.equal(kept.title, 'Draft a notice to Class 9 B')
  const saved = MessageDetail.parse(await ok(await send(owner, requestOf(name, kept.preview)), 201))
  assert.equal(saved.status, 'draft')
  assert.equal(describeDone(name, kept.preview), 'Saved the notice as a draft.')
})

// ---------------------------------------------------------------------------
// A change to a draft or a scheduled message.

test("change: one of the person's drafts is found by words of its title, and its change is one write", async () => {
  const name = 'propose_message_change'
  // No family is on file in this school, so the notices go to the pupils too, or there would be nobody to send to.
  const toNineA = { kind: 'section', sectionId: nineA, recipients: 'both' }
  const sports = await written(teacher, { audience: toNineA, title: 'Sports day kit', body: 'Bring your kit.' })
  await written(teacher, { audience: toNineA, title: 'Sports day timings', body: 'It starts at 9.' })

  const ambiguous = problemOf(await prepare(teacher, name, { message: 'sports day', body: 'New words.' }))
  assert.match(ambiguous, /^More than one draft or scheduled message could be "sports day": "Sports day timings" \(draft\) and "Sports day kit" \(draft\)\. Say which one\.$/)
  assert.match(problemOf(await prepare(teacher, name, { message: 'the kit notice' })), /Say what to change/)
  assert.match(problemOf(await prepare(teacher, name, { message: 'zebra', body: 'x y z' })), /^No draft or scheduled message of yours is called "zebra"\. The latest are /)
  assert.match(
    problemOf(await prepare(teacher, name, { message: 'the sports day kit notice', title: 'Sports day kit', when: 'draft' })),
    /already says that/,
  )
  // Somebody else's draft is never found, not even by its id.
  const ownersDraft = await written(owner, { audience: { kind: 'staff' }, title: 'Staff kit list', body: 'For the office.' })
  assert.deepEqual(await prepare(teacher, name, { message: ownersDraft.id, body: 'Mine now.' }), { status: 'not_available' })

  const at = inIndia(Date.now() + 3 * 3_600_000)
  const draft = drafted(
    await prepare(teacher, name, { message: 'sports day kit', body: 'Bring your kit and a water bottle.', when: 'at', date: at.date, time: at.time }),
    MessagePreview,
  )
  assert.equal(draft.title, 'Change "Sports day kit"')
  assert.equal(draft.checkPath, `/messages/${sports.id}`)
  assert.equal(draft.href, `/messages/${sports.id}`)
  const preview = draft.preview
  assert.equal(preview.messageId, sports.id)
  assert.equal(preview.version, sports.version)
  assert.equal(preview.currentStatus, 'draft')
  assert.deepEqual(preview.current, { title: 'Sports day kit', body: 'Bring your kit.', sendAt: null, recipients: 'both' })
  assert.equal(sameTarget(name, preview, { ...clone(preview), version: sports.version + 1 }), false)
  assert.equal(sameTarget(name, preview, { ...clone(preview), current: { ...preview.current!, body: 'Other' } }), false)

  const request = requestOf(name, preview)
  assert.equal(request.method, 'PATCH')
  assert.equal(request.path, `/messages/${sports.id}`)
  assert.deepEqual(request.body, {
    expectedVersion: sports.version,
    body: 'Bring your kit and a water bottle.',
    send: preview.proposed.send,
  })
  // The audience is sent only when the card changed who of the pupils it goes to.
  const toFamilies = requestOf(name, { ...clone(preview), audience: { kind: 'section', sectionId: nineA, recipients: 'families' } })
  assert.deepEqual((toFamilies.body as { audience?: unknown }).audience, { ...toNineA, recipients: 'families' })
  const unchanged = clone(preview)
  unchanged.proposed = { title: 'Sports day kit', body: 'Bring your kit.', send: { when: 'draft' } }
  assert.deepEqual(writeOf(name, unchanged), { problem: 'Nothing has changed.' })
  const changed = MessageDetail.parse(await ok(await send(teacher, request)))
  assert.equal(changed.status, 'scheduled')
  assert.equal(changed.body, 'Bring your kit and a water bottle.')
  assert.match(describeDone(name, preview), /^Scheduled the message for /)

  // Now scheduled: a new title keeps its time, and it goes back to a draft on asking.
  const retitled = drafted(await prepare(teacher, name, { message: 'sports day kit', title: 'Sports day: what to bring' }), MessagePreview)
  assert.equal(retitled.preview.currentStatus, 'scheduled')
  assert.deepEqual(retitled.preview.proposed.send, { when: 'at', sendAt: changed.sendAt })
  const retitleRequest = requestOf(name, retitled.preview)
  assert.equal((retitleRequest.body as { send?: unknown }).send, undefined, 'a scheduled message kept at its time sends no send')
  const renamed = MessageDetail.parse(await ok(await send(teacher, retitleRequest)))
  assert.equal(renamed.status, 'scheduled')
  assert.equal(renamed.title, 'Sports day: what to bring')
  assert.match(describeDone(name, retitled.preview), /^Saved the changes, still scheduled for /)

  const back = drafted(await prepare(teacher, name, { message: 'what to bring', when: 'draft' }), MessagePreview)
  const unscheduled = MessageDetail.parse(await ok(await send(teacher, requestOf(name, back.preview))))
  assert.equal(unscheduled.status, 'draft')
  assert.equal(unscheduled.sendAt, undefined)
  assert.equal(describeDone(name, back.preview), 'Took the message back to a draft.')

  // And then sent now.
  const now = drafted(await prepare(teacher, name, { message: 'what to bring', when: 'now' }), MessagePreview)
  assert.equal(MessageDetail.parse(await ok(await send(teacher, requestOf(name, now.preview)))).status, 'sent')
})

test('change: a staff notice edited back to how it was is "Nothing has changed."', async () => {
  const name = 'propose_message_change'
  const staff = await written(owner, { audience: { kind: 'staff' }, title: 'Staff meeting', body: 'At 3 pm in the hall.' })
  const draft = drafted(await prepare(owner, name, { message: 'staff meeting', body: 'At 4 pm in the hall.' }), MessagePreview)
  assert.equal(draft.preview.pupilAudience, false)
  assert.match(problemOf(await prepare(owner, name, { message: 'staff meeting', recipients: 'both' })), /no families or pupils to choose/)
  const reverted = clone(draft.preview)
  reverted.proposed.body = 'At 3 pm in the hall.'
  assert.deepEqual(writeOf(name, reverted), { problem: 'Nothing has changed.' })
  const request = requestOf(name, draft.preview)
  assert.deepEqual(request.body, { expectedVersion: staff.version, body: 'At 4 pm in the hall.' })
  assert.equal((await detailOf(owner, staff.id)).status, 'draft')
})

// ---------------------------------------------------------------------------
// Withdrawing a sent message.

test('withdraw: a sent notice is found by its title, and needs a reason on the card', async () => {
  const name = 'propose_message_withdraw'
  const sent = await written(owner, { audience: { kind: 'staff' }, title: 'Holiday on Monday', body: 'School is shut on Monday.', send: { when: 'now' } })
  assert.equal(sent.status, 'sent')
  assert.match(problemOf(await prepare(owner, name, { message: 'sports day kit' })), /^No sent message of yours is called/)
  // The teacher may not withdraw the office's notice: it is not theirs to act on.
  assert.match(problemOf(await prepare(teacher, name, { message: 'holiday on monday' })), /^No sent message of yours|^You have no sent message/)

  const draft = drafted(await prepare(owner, name, { message: 'holiday monday' }), MessageWithdrawPreview)
  assert.equal(draft.title, 'Withdraw "Holiday on Monday"')
  assert.equal(draft.checkPath, `/messages/${sent.id}`)
  const preview = draft.preview
  assert.equal(preview.messageId, sent.id)
  assert.equal(preview.version, sent.version)
  assert.equal(preview.audienceLabel, 'All staff')
  assert.equal(preview.recipients, sent.counts?.recipients ?? 0)
  assert.ok(preview.recipients >= 2, 'both staff members are recipients')
  assert.equal(preview.reason, undefined)
  assert.deepEqual((draft.forModel as { needsReason: boolean }).needsReason, true)

  assert.deepEqual(writeOf(name, preview), { problem: 'Add a reason for withdrawing the message.' })
  const edited = { ...clone(preview), reason: 'Sent by mistake' }
  assert.equal(sameTarget(name, preview, edited), true)
  assert.equal(sameTarget(name, preview, { ...clone(edited), title: 'Other' }), false)
  assert.equal(sameTarget(name, preview, { ...clone(edited), recipients: 0 }), false)
  const request = requestOf(name, edited)
  assert.deepEqual(request, { method: 'POST', path: `/messages/${sent.id}/withdraw`, body: { expectedVersion: sent.version, reason: 'Sent by mistake' } })
  const withdrawn = MessageDetail.parse(await ok(await send(owner, request)))
  assert.equal(withdrawn.status, 'withdrawn')
  assert.equal(describeDone(name, edited), 'Withdrew the message.')
  assert.match(problemOf(await prepare(owner, name, { message: 'holiday on monday' })), /^You have no sent message|^No sent message of yours/)
})

test("the check view is a message's version, status, words, time and audience, never its delivery figures", async () => {
  const sent = await written(owner, { audience: { kind: 'staff' }, title: 'Read me', body: 'Words.', send: { when: 'now' } })
  const { messageCheckView } = messageToolParts
  const moved = { ...sent, counts: { ...sent.counts!, read: sent.counts!.read + 1, delivered: sent.counts!.delivered + 1 } }
  assert.deepEqual(messageCheckView(moved), messageCheckView(sent))
  assert.notDeepEqual(messageCheckView({ ...sent, version: sent.version + 1 }), messageCheckView(sent))
  assert.notDeepEqual(messageCheckView({ ...sent, status: 'withdrawn' }), messageCheckView(sent))
  assert.notDeepEqual(messageCheckView({ ...sent, body: 'Other words.' }), messageCheckView(sent))
})
