/**
 * Notices through the assistant, end to end (Task 24c): a scripted model
 * calls the real message tools in a turn, the proposal is saved, and the
 * person's Confirm sends the one write through the real message routes as
 * them. A new notice is sent, scheduled or kept as a draft; a draft is
 * changed; a sent notice is withdrawn with the reason typed on the card.
 * Each confirmed write leaves exactly one audit row, under the proposal's
 * operation id. A message someone changed between the proposal and the
 * Confirm makes it stale; delivery figures moving on a sent one do not. A
 * teacher cannot aim a notice at a section that is not theirs.
 *
 * The suite builds a school of its own.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { MessageDetail, ROLE_TEMPLATES, type AssistantProposal, type MessagePreview, type MessageWithdrawPreview } from '@erp/contracts'
import { loadConfig } from '../src/config.ts'
import { createPools } from '../src/db.ts'
import { createSandboxDelivery } from '../src/delivery/index.ts'
import { createAuth } from '../src/auth/better-auth.ts'
import { createMemoryDocumentStorage } from '../src/files/storage.ts'
import { buildApp } from '../src/app.ts'
import type { AnyProposeTool } from '../src/assistant/proposals/types.ts'
import { STALE_OUTCOME } from '../src/assistant/proposals/routes.ts'
import { proposeMessage, proposeMessageChange, proposeMessageWithdraw } from '../src/assistant/proposals/messages.ts'
import {
  adminPool,
  closeAdminPool,
  closeRateLimitPool,
  CookieJar,
  freePort,
  seedDatabaseFixtures,
  setFixturePassword,
  signInWithMfa,
  signInWithPassword,
  testEnv,
  type TestServer,
} from './harness.ts'
import { streamParts } from './assistant-support.ts'

const PASSWORD = 'Fixture-Pass!42'
const suffix = randomUUID().slice(0, 8)

const school = randomUUID()
const year = randomUUID()
const grade = randomUUID()
const nineA = randomUUID()
const nineB = randomUUID()
const teacherStaff = randomUUID()
const officeStaff = randomUUID()

type Server = TestServer & { model: MockLanguageModelV4 }
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let server: Server
let owner: Client
let teacher: Client

// ---------------------------------------------------------------------------
// A scripted model: "CALL <tool> {json}" calls that tool; anything else is words.

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
}

function words(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 't1' },
        { type: 'text-delta' as const, id: 't1', delta: text },
        { type: 'text-end' as const, id: 't1' },
        { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
      ],
    }),
  }
}

function messageModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'test',
    modelId: 'scripted',
    doStream: async (options) => {
      const last = options.prompt[options.prompt.length - 1]
      if (last?.role !== 'user') return words('Check the card and press Confirm.')
      const text = last.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
      const call = /^CALL (\S+) (.*)$/s.exec(text)
      if (!call) return words('Noted.')
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'tool-call' as const, toolCallId: `call-${randomUUID()}`, toolName: call[1]!, input: call[2]! },
            { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage },
          ],
        }),
      }
    },
  })
}

async function startServer(): Promise<Server> {
  const port = await freePort()
  const config = loadConfig(
    testEnv(port, {
      ASSISTANT_ENABLED: 'true',
      AI_GATEWAY_API_KEY: 'test-only-never-used',
      CRON_SECRET: 'assistant-messages-cron-secret-0123456789ab',
    }),
  )
  const pools = await createPools(config)
  const delivery = createSandboxDelivery(() => {})
  const auth = createAuth(config, pools.auth, delivery, pools.identity)
  const documents = createMemoryDocumentStorage()
  const model = messageModel()
  const assistant = {
    assistantModel: model,
    assistantTools: [],
    assistantProposeTools: [proposeMessage, proposeMessageChange, proposeMessageWithdraw].map((tool) => tool as unknown as AnyProposeTool),
  }
  const app = buildApp({ config, auth, delivery, pools, documents, assistant })
  await app.listen({ port: config.PORT, host: '127.0.0.1' })
  const origin = `http://127.0.0.1:${config.PORT}`
  const jar = new CookieJar()
  return {
    config,
    auth,
    delivery,
    pools,
    documents,
    origin,
    jar,
    model,
    async fetch(path, init = {}) {
      const headers = new Headers(init.headers)
      const cookie = jar.header()
      if (cookie && !headers.has('cookie')) headers.set('cookie', cookie)
      if (!headers.has('origin')) headers.set('origin', origin)
      const response = await fetch(`${origin}${path}`, { ...init, headers })
      jar.capture(response)
      return response
    },
    async close() {
      await app.close()
      await pools.close()
      await closeRateLimitPool()
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers.

const base = `/api/schools/${school}`

function send(method: string, value?: unknown): RequestInit {
  return value === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
}

async function ok<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text()
  assert.equal(response.status, status, text)
  return (text ? JSON.parse(text) : null) as T
}

async function member(roleKeys: readonly string[], options: { mfa?: boolean; staffId?: string } = {}): Promise<Client> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `ai-msg-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, 'Message Member', email])
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
  if (options.staffId !== undefined) {
    await pool.query('INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)', [
      school,
      membershipId,
      options.staffId,
    ])
  }
  await setFixturePassword(server, userId, PASSWORD)
  return options.mfa ? signInWithMfa(server, { userId, email, password: PASSWORD }) : signInWithPassword(server, email, PASSWORD)
}

interface ToolOutput {
  status: string
  proposal?: AssistantProposal
  problem?: string
  forModel?: unknown
}

/** Ask the scripted model to call one tool in a new conversation; returns the tool's output and the thread. */
async function call(client: Client, tool: string, input: Record<string, unknown>): Promise<ToolOutput & { threadId: string }> {
  const threadId = (await ok<{ id: string }>(await client.fetch(`${base}/assistant/threads`, send('POST')), 201)).id
  const response = await client.fetch(
    `${base}/assistant/threads/${threadId}/turns`,
    send('POST', { messageId: randomUUID(), text: `CALL ${tool} ${JSON.stringify(input)}` }),
  )
  assert.equal(response.status, 200)
  const output = streamParts(await response.text()).find((part) => part.type === 'tool-output-available')?.output as ToolOutput | undefined
  assert.ok(output, 'the tool answered')
  return { ...output, threadId }
}

async function proposed(client: Client, tool: string, input: Record<string, unknown>): Promise<AssistantProposal> {
  const output = await call(client, tool, input)
  assert.equal(output.status, 'ok', JSON.stringify(output))
  assert.ok(output.proposal)
  assert.equal(output.proposal.status, 'open')
  return output.proposal
}

function confirm(client: Client, proposalId: string, preview: unknown): Promise<Response> {
  return client.fetch(`${base}/assistant/proposals/${proposalId}/confirm`, send('POST', { preview }))
}

async function confirmed(client: Client, proposal: AssistantProposal, preview: unknown = proposal.preview): Promise<AssistantProposal> {
  return (await ok<{ proposal: AssistantProposal }>(await confirm(client, proposal.id, preview))).proposal
}

/** The one audit row the confirmed write left, under the proposal's operation id. */
async function writeAuditOf(proposalId: string): Promise<{ action: string; target_id: string; summary: string }> {
  const proposal = await adminPool().query<{ write_request_id: string | null }>('SELECT write_request_id FROM assistant_proposals WHERE id = $1', [
    proposalId,
  ])
  const requestId = proposal.rows[0]?.write_request_id
  assert.ok(requestId, 'the proposal kept its operation id')
  const rows = await adminPool().query<{ action: string; target_id: string; summary: string }>(
    `SELECT action, target_id, summary FROM audit_events WHERE school_id = $1 AND request_id = $2 AND result = 'allowed'`,
    [school, requestId],
  )
  assert.equal(rows.rows.length, 1, 'exactly one audit row')
  return rows.rows[0]!
}

async function messageRow(id: string): Promise<{ status: string; title: string; body: string; version: number; send_at: Date | null }> {
  const found = await adminPool().query<{ status: string; title: string; body: string; version: number; send_at: Date | null }>(
    'SELECT status, title, body, version, send_at FROM messages WHERE school_id = $1 AND id = $2',
    [school, id],
  )
  assert.ok(found.rows[0], 'the message exists')
  return found.rows[0]
}

async function messagesCalled(title: string): Promise<number> {
  const found = await adminPool().query<{ count: number }>('SELECT count(*)::int AS count FROM messages WHERE school_id = $1 AND title = $2', [
    school,
    title,
  ])
  return Number(found.rows[0]?.count)
}

/** A message written straight through the route, as a screen would. */
async function written(client: Client, body: Record<string, unknown>): Promise<MessageDetail> {
  return MessageDetail.parse(await ok(await client.fetch(`${base}/messages`, send('POST', body)), 201))
}

/** An hour or more from now on India's clock, which is this school's. */
function inIndia(ms: number): { date: string; time: string } {
  const local = new Date(ms + 330 * 60_000).toISOString()
  return { date: local.slice(0, 10), time: local.slice(11, 16) }
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,'AIG')`, [
    school,
    `ai-msg-${suffix}`,
    `Notice School ${suffix}`,
  ])
  for (const [key, template] of Object.entries(ROLE_TEMPLATES)) {
    const role = await pool.query<{ id: string }>(`INSERT INTO roles(school_id,key,name,is_system) VALUES ($1,$2,$3,true) RETURNING id`, [
      school,
      key,
      template.displayName,
    ])
    for (const grant of template.grants)
      await pool.query(`INSERT INTO role_permissions(school_id,role_id,permission,scope) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [
        school,
        role.rows[0]?.id,
        grant.permission,
        grant.scope,
      ])
  }
  await pool.query(`INSERT INTO assistant_settings(school_id,enabled) VALUES ($1,true)`, [school])
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,current_date - 100,current_date + 200,'current')`,
    [year, school, `AIG-${suffix}`],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [school, year])
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,'Class 9','9',9)`, [grade, school])
  for (const [id, code, first] of [
    [teacherStaff, 'T1', 'Meena'],
    [officeStaff, 'O1', 'Suresh'],
  ] as const) {
    await pool.query(
      `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status,joining_date)
       VALUES ($1,$2,$3,$4,'teaching','Teacher','active',current_date - 100)`,
      [id, school, `AIG-${suffix}-${code}`, first],
    )
  }
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id) VALUES ($1,$2,$3,$4,'A',$5)`,
    [nineA, school, year, grade, teacherStaff],
  )
  await pool.query(`INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,'B')`, [nineB, school, year, grade])
  for (const [index, [first, sectionId]] of ([
    ['Kabir', nineA],
    ['Asha', nineA],
    ['Other', nineB],
  ] as const).entries()) {
    const id = randomUUID()
    await pool.query(`INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,$4,'Pupil','active')`, [
      id,
      school,
      `AIG/${suffix}/${index + 1}`,
      first,
    ])
    await pool.query(
      `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,$5,current_date - 100)`,
      [school, id, year, sectionId, index + 1],
    )
  }

  server = await startServer()
  owner = await member(['owner'], { mfa: true, staffId: officeStaff })
  teacher = await member(['teacher'], { staffId: teacherStaff })
})

after(async () => {
  await server.close()
  await closeAdminPool()
})

// ---------------------------------------------------------------------------

test("a teacher's notice to their own class is proposed, then sent on Confirm with one audit row", async () => {
  const title = `Picnic ${suffix}`
  const proposal = await proposed(teacher, 'propose_message', {
    audience: '9A',
    recipients: 'both',
    title,
    body: 'The picnic is on Friday.',
    when: 'now',
  })
  assert.equal(proposal.kind, 'message')
  assert.equal(proposal.title, 'Send a notice to Class 9 A')
  // Nothing is written by proposing.
  assert.equal(await messagesCalled(title), 0)

  const done = await confirmed(teacher, proposal)
  assert.equal(done.status, 'done', JSON.stringify(done))
  assert.equal(done.outcome, 'Sent the notice to Class 9 A.')
  const audit = await writeAuditOf(proposal.id)
  assert.equal(audit.action, 'communication.send')
  assert.equal(audit.summary, 'Sent a message.')
  const row = await messageRow(audit.target_id)
  assert.equal(row.status, 'sent')
  assert.equal(row.title, title)
  assert.equal(await messagesCalled(title), 1)
})

test('a teacher cannot aim a notice at another section: nothing is proposed', async () => {
  const output = await call(teacher, 'propose_message', { audience: '9B', title: 'Not mine', body: 'Words.', when: 'now' })
  assert.equal(output.status, 'invalid')
  assert.equal(output.problem, 'You cannot send to 9B. You can send to Class 9 A, or to one pupil.')
  assert.equal(output.proposal, undefined)
  const kept = await adminPool().query('SELECT 1 FROM assistant_proposals WHERE thread_id = $1', [output.threadId])
  assert.equal(kept.rows.length, 0)
})

test('the office schedules a notice with the title edited on the card, and keeps another as a draft', async () => {
  const at = inIndia(Date.now() + 2 * 3_600_000)
  const proposal = await proposed(owner, 'propose_message', {
    audience: 'all staff',
    title: 'Staff meeting',
    body: 'In the hall after school.',
    when: 'at',
    date: at.date,
    time: at.time,
  })
  const preview = structuredClone(proposal.preview) as MessagePreview
  const edited: MessagePreview = { ...preview, proposed: { ...preview.proposed, title: `Staff meeting ${suffix}` } }
  const done = await confirmed(owner, proposal, edited)
  assert.equal(done.status, 'done', JSON.stringify(done))
  assert.match(done.outcome ?? '', /^Scheduled the notice for \d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} (am|pm)\.$/)
  const audit = await writeAuditOf(proposal.id)
  const row = await messageRow(audit.target_id)
  assert.equal(row.status, 'scheduled')
  assert.equal(row.title, `Staff meeting ${suffix}`)
  assert.equal(row.send_at?.toISOString(), new Date(Date.parse(`${at.date}T${at.time}:00+05:30`)).toISOString())

  const draft = await proposed(owner, 'propose_message', { audience: 'the whole school', title: `Sports day ${suffix}`, body: 'On Saturday.', when: 'draft' })
  const saved = await confirmed(owner, draft)
  assert.equal(saved.status, 'done')
  assert.equal(saved.outcome, 'Saved the notice as a draft.')
  assert.equal((await messageRow((await writeAuditOf(draft.id)).target_id)).status, 'draft')
})

test('a draft changed and sent through the assistant is one write; one changed by somebody else meanwhile is stale', async () => {
  const draft = await written(teacher, { audience: { kind: 'section', sectionId: nineA, recipients: 'both' }, title: `Kit list ${suffix}`, body: 'Bring your kit.' })
  const proposal = await proposed(teacher, 'propose_message_change', { message: `kit list ${suffix}`, body: 'Bring your kit and a bottle.', when: 'now' })
  assert.equal(proposal.title, `Change "Kit list ${suffix}"`)
  const done = await confirmed(teacher, proposal)
  assert.equal(done.status, 'done', JSON.stringify(done))
  assert.equal(done.outcome, 'Sent the message to Class 9 A.')
  assert.equal((await writeAuditOf(proposal.id)).summary, 'Changed and sent a message.')
  const row = await messageRow(draft.id)
  assert.equal(row.status, 'sent')
  assert.equal(row.body, 'Bring your kit and a bottle.')

  // Somebody (here the teacher, on the Messages screen) changes the draft after the proposal.
  const other = await written(teacher, { audience: { kind: 'section', sectionId: nineA, recipients: 'both' }, title: `Trip form ${suffix}`, body: 'Sign it.' })
  const stale = await proposed(teacher, 'propose_message_change', { message: `trip form ${suffix}`, body: 'Sign and return it.' })
  await ok(await teacher.fetch(`${base}/messages/${other.id}`, send('PATCH', { expectedVersion: other.version, body: 'Sign it by Monday.' })))
  const outcome = await confirmed(teacher, stale)
  assert.equal(outcome.status, 'stale')
  assert.equal(outcome.outcome, STALE_OUTCOME)
  const after = await messageRow(other.id)
  assert.equal(after.body, 'Sign it by Monday.')
  assert.equal(after.status, 'draft')
})

test('withdrawing needs the reason on the card; delivery figures moving meanwhile do not make it stale', async () => {
  const title = `Holiday ${suffix}`
  const sent = await written(owner, { audience: { kind: 'staff' }, title, body: 'School is shut on Monday.', send: { when: 'now' } })
  assert.equal(sent.status, 'sent')
  const proposal = await proposed(owner, 'propose_message_withdraw', { message: `holiday ${suffix}` })
  assert.equal(proposal.kind, 'message_withdraw')
  assert.equal(proposal.title, `Withdraw "${title}"`)

  // The teacher, one of the staff, reads it: the read count moves, nothing else.
  const inbox = await ok<{ items: { recipientId: string; messageId: string }[] }>(await teacher.fetch(`${base}/messages/inbox`))
  const mine = inbox.items.find((item) => item.messageId === sent.id)
  assert.ok(mine, 'the teacher received it')
  await ok(await teacher.fetch(`${base}/messages/inbox/${mine.recipientId}/read`, send('POST')))
  const counted = MessageDetail.parse(await ok(await owner.fetch(`${base}/messages/${sent.id}`)))
  assert.equal(counted.counts?.read, (sent.counts?.read ?? 0) + 1)

  // Without a reason the card is refused, and stays open.
  const refused = await confirm(owner, proposal.id, proposal.preview)
  assert.equal(refused.status, 400)
  assert.equal(((await refused.json()) as { error: { message: string } }).error.message, 'Add a reason for withdrawing the message.')
  assert.equal((await messageRow(sent.id)).status, 'sent')

  const withReason: MessageWithdrawPreview = { ...(proposal.preview as MessageWithdrawPreview), reason: 'Sent to the wrong people' }
  const done = await confirmed(owner, proposal, withReason)
  assert.equal(done.status, 'done', JSON.stringify(done))
  assert.equal(done.outcome, 'Withdrew the message.')
  const audit = await writeAuditOf(proposal.id)
  assert.equal(audit.summary, 'Withdrew a message.')
  assert.equal(audit.target_id, sent.id)
  assert.equal((await messageRow(sent.id)).status, 'withdrawn')
})
