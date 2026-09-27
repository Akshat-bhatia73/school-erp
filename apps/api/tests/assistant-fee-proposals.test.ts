/**
 * Fees through the assistant, end to end (Task 24d): a scripted model calls
 * the real fee tools in a turn, the proposal is saved, and the person's
 * Confirm sends the one write through the real fee routes as them. A payment
 * is split oldest due first, again on the server with the amount as the card
 * left it, and the done card links to the receipt it made; a payment recorded
 * on the Fees screen meanwhile makes the proposal stale. A concession and an
 * optional fee are each one row and one audit row, and the concession's reason
 * never reaches the audit row's safe changes. The office counter is offered
 * the payment tool only; a teacher and a parent none of them.
 *
 * The suite builds a school of its own.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { ROLE_TEMPLATES, type AssistantProposal, type FeeConcessionPreview, type FeePaymentPreview } from '@erp/contracts'
import { loadConfig } from '../src/config.ts'
import { createPools } from '../src/db.ts'
import { createSandboxDelivery } from '../src/delivery/index.ts'
import { createAuth } from '../src/auth/better-auth.ts'
import { createMemoryDocumentStorage } from '../src/files/storage.ts'
import { buildApp } from '../src/app.ts'
import { PROPOSE_TOOLS } from '../src/assistant/proposals/registry.ts'
import { STALE_OUTCOME } from '../src/assistant/proposals/routes.ts'
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
const teacherStaff = randomUUID()

const tuition = randomUUID()
const lab = randomUUID()
const transport = randomUUID()
const TUITION = 100_000
const LAB = 90_000
const TRANSPORT = 180_000

const aarav = randomUUID()
const kabir = randomUUID()
const meera = randomUUID()

type Server = TestServer & { model: MockLanguageModelV4 }
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let server: Server
let accountant: Client
let office: Client
let teacher: Client
let parent: Client
let today = ''

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

function feeModel(): MockLanguageModelV4 {
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
  const config = loadConfig(testEnv(port, { ASSISTANT_ENABLED: 'true', AI_GATEWAY_API_KEY: 'test-only-never-used' }))
  const pools = await createPools(config)
  const delivery = createSandboxDelivery(() => {})
  const auth = createAuth(config, pools.auth, delivery, pools.identity)
  const documents = createMemoryDocumentStorage()
  const model = feeModel()
  // The registry's own tools, so what each person is offered is what production offers.
  const assistant = { assistantModel: model, assistantTools: [], assistantProposeTools: [...PROPOSE_TOOLS] }
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
  const email = `ai-fee-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, 'Fee Member', email])
  await pool.query(`INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')`, [membershipId, school, userId])
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = ANY($3::text[])`,
    [school, membershipId, [...roleKeys]],
  )
  if (options.staffId !== undefined) {
    await pool.query('INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)', [school, membershipId, options.staffId])
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

async function newThread(client: Client): Promise<string> {
  return (await ok<{ id: string }>(await client.fetch(`${base}/assistant/threads`, send('POST')), 201)).id
}

/** Ask the scripted model one thing in a new conversation; returns the tool's output, if any, and the thread. */
async function ask(client: Client, text: string): Promise<{ output: ToolOutput | undefined; threadId: string }> {
  const threadId = await newThread(client)
  const response = await client.fetch(`${base}/assistant/threads/${threadId}/turns`, send('POST', { messageId: randomUUID(), text }))
  assert.equal(response.status, 200)
  const output = streamParts(await response.text()).find((part) => part.type === 'tool-output-available')?.output as ToolOutput | undefined
  return { output, threadId }
}

async function proposed(client: Client, tool: string, input: Record<string, unknown>): Promise<AssistantProposal & { threadId: string }> {
  const { output, threadId } = await ask(client, `CALL ${tool} ${JSON.stringify(input)}`)
  assert.equal(output?.status, 'ok', JSON.stringify(output))
  assert.ok(output?.proposal)
  assert.equal(output.proposal.status, 'open')
  return { ...output.proposal, threadId }
}

function confirm(client: Client, proposalId: string, preview: unknown): Promise<Response> {
  return client.fetch(`${base}/assistant/proposals/${proposalId}/confirm`, send('POST', { preview }))
}

async function confirmed(client: Client, proposal: AssistantProposal, preview: unknown = proposal.preview): Promise<AssistantProposal> {
  return (await ok<{ proposal: AssistantProposal }>(await confirm(client, proposal.id, preview))).proposal
}

interface AuditRow {
  action: string
  target_id: string
  summary: string
  safe_changes: Record<string, unknown>
}

/** The one audit row the confirmed write left, under the proposal's operation id. */
async function writeAuditOf(proposalId: string): Promise<AuditRow> {
  const proposal = await adminPool().query<{ write_request_id: string | null }>('SELECT write_request_id FROM assistant_proposals WHERE id = $1', [proposalId])
  const requestId = proposal.rows[0]?.write_request_id
  assert.ok(requestId, 'the proposal kept its operation id')
  const rows = await adminPool().query<AuditRow>(
    `SELECT action, target_id, summary, safe_changes FROM audit_events WHERE school_id = $1 AND request_id = $2 AND result = 'allowed'`,
    [school, requestId],
  )
  assert.equal(rows.rows.length, 1, 'exactly one audit row')
  return rows.rows[0]!
}

async function receiptLines(receiptId: string): Promise<{ fee_head_id: string; amount_paise: number }[]> {
  const found = await adminPool().query<{ fee_head_id: string; amount_paise: string }>(
    `SELECT l.fee_head_id, l.amount_paise::text AS amount_paise
       FROM fee_receipt_lines l JOIN fee_heads h ON h.school_id = l.school_id AND h.id = l.fee_head_id
      WHERE l.school_id = $1 AND l.receipt_id = $2 ORDER BY l.amount_paise DESC`,
    [school, receiptId],
  )
  return found.rows.map((row) => ({ fee_head_id: row.fee_head_id, amount_paise: Number(row.amount_paise) }))
}

async function receiptsOf(studentId: string): Promise<number> {
  const found = await adminPool().query<{ count: number }>(`SELECT count(*)::int AS count FROM fee_receipts WHERE school_id = $1 AND student_id = $2`, [school, studentId])
  return Number(found.rows[0]?.count)
}

/** A payment taken on the Fees screen, straight through the route. */
async function collectOnScreen(client: Client, studentId: string, feeHeadId: string, amountPaise: number): Promise<void> {
  await ok(
    await client.fetch(
      `${base}/fees/students/${studentId}/collect`,
      send('POST', { academicYearId: year, lines: [{ feeHeadId, amountPaise }], mode: 'cash', receivedOn: today }),
    ),
    201,
  )
}

/** The change tools the model was offered in the person's last turn. */
function offeredChangeTools(): string[] {
  const call = server.model.doStreamCalls.at(-1)
  return (call?.tools ?? []).map((entry) => entry.name).filter((name) => name.startsWith('propose_')).sort()
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,'AIF')`, [school, `ai-fee-${suffix}`, `Fee School ${suffix}`])
  for (const [key, template] of Object.entries(ROLE_TEMPLATES)) {
    const role = await pool.query<{ id: string }>(`INSERT INTO roles(school_id,key,name,is_system) VALUES ($1,$2,$3,true) RETURNING id`, [school, key, template.displayName])
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
    [year, school, `AIF-${suffix}`],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [school, year])
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,'Class 9','9',9)`, [grade, school])
  await pool.query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status,joining_date)
     VALUES ($1,$2,$3,'Meena','teaching','Teacher','active',current_date - 100)`,
    [teacherStaff, school, `AIF-${suffix}-T1`],
  )
  await pool.query(`INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id) VALUES ($1,$2,$3,$4,'A',$5)`, [
    nineA,
    school,
    year,
    grade,
    teacherStaff,
  ])
  for (const [index, [id, first, last]] of ([
    [aarav, 'Aarav', 'Shah'],
    [kabir, 'Kabir', 'Rao'],
    [meera, 'Meera', 'Iyer'],
  ] as const).entries()) {
    await pool.query(`INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,$4,$5,'active')`, [
      id,
      school,
      `AIF/${suffix}/${index + 1}`,
      first,
      last,
    ])
    await pool.query(
      `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,$5,current_date - 100)`,
      [school, id, year, nineA, index + 1],
    )
  }
  // Tuition is monthly and the lab quarterly, both charged to the class; transport is taken by choice.
  for (const [id, name, category, appliesTo, frequency] of [
    [tuition, 'Tuition', 'tuition', 'class', 'monthly'],
    [lab, 'Lab', 'lab', 'class', 'quarterly'],
    [transport, 'Transport', 'transport', 'opt_in', 'monthly'],
  ] as const) {
    await pool.query(`INSERT INTO fee_heads(id,school_id,name,category,applies_to,frequency) VALUES ($1,$2,$3,$4,$5,$6)`, [id, school, name, category, appliesTo, frequency])
  }
  for (const [headId, gradeId, amount] of [
    [tuition, grade, TUITION],
    [lab, grade, LAB],
    [transport, null, TRANSPORT],
  ] as const) {
    await pool.query(`INSERT INTO fee_structures(school_id,academic_year_id,fee_head_id,grade_id,amount_paise) VALUES ($1,$2,$3,$4,$5)`, [
      school,
      year,
      headId,
      gradeId,
      amount,
    ])
  }

  server = await startServer()
  accountant = await member(['accountant'], { mfa: true })
  office = await member(['admin'], { mfa: true })
  teacher = await member(['teacher'], { staffId: teacherStaff })
  parent = await member(['parent'])

  const statement = await ok<{ asOf: string }>(await accountant.fetch(`${base}/fees/students/${aarav}/statement?academicYearId=${year}`))
  today = statement.asOf
  // Aarav's first month of tuition is paid, so his oldest unpaid tuition is the second month, after the lab's first quarter.
  await collectOnScreen(accountant, aarav, tuition, TUITION)
})

after(async () => {
  await server.close()
  await closeAdminPool()
})

// ---------------------------------------------------------------------------

test('an accountant records a payment: split oldest due first, one audit row, and the done card links to the receipt', async () => {
  const before = await receiptsOf(aarav)
  const proposal = await proposed(accountant, 'propose_fee_payment', {
    pupil: 'Aarav Shah',
    amountRupees: 2500,
    mode: 'upi',
    reference: 'UPI1234',
    payerName: 'Rakesh Shah',
  })
  assert.equal(proposal.kind, 'fee_payment')
  assert.equal(proposal.title, 'Record a payment for Aarav Shah')
  const preview = proposal.preview as FeePaymentPreview
  assert.deepEqual(preview.dues.map((due) => due.feeHeadId), [lab, tuition])
  assert.equal(preview.receivedOn, today)
  // Nothing is written by proposing.
  assert.equal(await receiptsOf(aarav), before)

  const done = await confirmed(accountant, proposal)
  assert.equal(done.status, 'done', JSON.stringify(done))
  assert.equal(done.outcome, 'Recorded ₹2,500 by UPI.')
  const audit = await writeAuditOf(proposal.id)
  assert.equal(audit.action, 'fees.collect')
  assert.equal(done.href, `/fees/receipts/${audit.target_id}`)
  assert.deepEqual(await receiptLines(audit.target_id), [
    { fee_head_id: lab, amount_paise: 2 * LAB },
    { fee_head_id: tuition, amount_paise: 250_000 - 2 * LAB },
  ])
  assert.equal(await receiptsOf(aarav), before + 1)

  // The outcome is a plain column: no pupil, no payer, no receipt number.
  const row = await adminPool().query<{ outcome: string; written_href: string }>('SELECT outcome, written_href FROM assistant_proposals WHERE id = $1', [proposal.id])
  assert.equal(row.rows[0]?.outcome, 'Recorded ₹2,500 by UPI.')
  assert.doesNotMatch(row.rows[0]?.outcome ?? '', /Aarav|Rakesh|AIF/)
  assert.equal(row.rows[0]?.written_href, `/fees/receipts/${audit.target_id}`)
  // The conversation reopened still links to the receipt.
  const states = await ok<{ items: AssistantProposal[] }>(await accountant.fetch(`${base}/assistant/threads/${proposal.threadId}/proposals`))
  assert.equal(states.items.find((item) => item.id === proposal.id)?.href, `/fees/receipts/${audit.target_id}`)
})

test('the amount edited on the card is split again by the server', async () => {
  const proposal = await proposed(accountant, 'propose_fee_payment', { pupil: 'Kabir' })
  const preview = proposal.preview as FeePaymentPreview
  // Nothing paid: both fell due on the first day, so they go by name.
  assert.deepEqual(preview.dues.map((due) => due.feeHeadId), [lab, tuition])
  assert.equal(preview.proposed.amountPaise, preview.dues.reduce((sum, due) => sum + due.balancePaise, 0))
  const edited: FeePaymentPreview = { ...preview, proposed: { ...preview.proposed, amountPaise: 200_000 } }
  const done = await confirmed(accountant, proposal, edited)
  assert.equal(done.status, 'done', JSON.stringify(done))
  assert.equal(done.outcome, 'Recorded ₹2,000 by cash.')
  const audit = await writeAuditOf(proposal.id)
  assert.deepEqual(await receiptLines(audit.target_id), [
    { fee_head_id: lab, amount_paise: 2 * LAB },
    { fee_head_id: tuition, amount_paise: 200_000 - 2 * LAB },
  ])
})

test('a payment recorded on the Fees screen after the proposal makes it stale, and nothing more is written', async () => {
  const proposal = await proposed(accountant, 'propose_fee_payment', { pupil: 'Meera Iyer', amountRupees: 500 })
  await collectOnScreen(accountant, meera, tuition, 10_000)
  const outcome = await confirmed(accountant, proposal)
  assert.equal(outcome.status, 'stale')
  assert.equal(outcome.outcome, STALE_OUTCOME)
  assert.equal(await receiptsOf(meera), 1)

  // A fresh proposal now warns about the payment recorded today.
  const again = await proposed(accountant, 'propose_fee_payment', { pupil: 'Meera Iyer', amountRupees: 500 })
  assert.equal((again.preview as FeePaymentPreview).paidToday.length, 1)
})

test('a concession needs the reason on the card, is one row and one audit row, and the reason stays out of the safe changes', async () => {
  const reason = `Younger sibling joined ${suffix}`
  const proposal = await proposed(accountant, 'propose_fee_concession', { pupil: 'Kabir Rao', fee: 'tuition', percent: 25, category: 'sibling' })
  assert.equal(proposal.title, 'Concession for Kabir Rao')
  const refused = await confirm(accountant, proposal.id, proposal.preview)
  assert.equal(refused.status, 400)
  assert.equal(((await refused.json()) as { error: { message: string } }).error.message, 'Add a reason for the concession.')

  const done = await confirmed(accountant, proposal, { ...(proposal.preview as FeeConcessionPreview), reason })
  assert.equal(done.status, 'done', JSON.stringify(done))
  assert.equal(done.outcome, 'Applied a 25% concession on Tuition.')
  const audit = await writeAuditOf(proposal.id)
  assert.equal(audit.action, 'fees.manage')
  assert.ok(!JSON.stringify(audit.safe_changes).includes(reason), 'the reason is not a safe change')
  const rows = await adminPool().query<{ percent_bp: number; category: string }>(
    'SELECT percent_bp, category FROM fee_concessions WHERE school_id = $1 AND student_id = $2',
    [school, kabir],
  )
  assert.deepEqual(rows.rows, [{ percent_bp: 2500, category: 'sibling' }])
})

test('an optional fee is added from a day as one row and one audit row', async () => {
  const proposal = await proposed(accountant, 'propose_fee_opt_in', { pupil: 'Aarav', fee: 'transport' })
  assert.equal(proposal.title, 'Add Transport for Aarav Shah')
  const done = await confirmed(accountant, proposal)
  assert.equal(done.status, 'done', JSON.stringify(done))
  assert.match(done.outcome ?? '', /^Added Transport from \d{1,2} [A-Z][a-z]{2} \d{4}\.$/)
  assert.equal((await writeAuditOf(proposal.id)).action, 'fees.manage')
  const rows = await adminPool().query<{ starts_on: string }>(
    `SELECT to_char(starts_on, 'YYYY-MM-DD') AS starts_on FROM fee_student_heads WHERE school_id = $1 AND student_id = $2 AND fee_head_id = $3`,
    [school, aarav, transport],
  )
  assert.deepEqual(rows.rows, [{ starts_on: today }])

  // Asked again, the tool says the pupil takes it already.
  const { output } = await ask(accountant, `CALL propose_fee_opt_in ${JSON.stringify({ pupil: 'Aarav', fee: 'transport' })}`)
  assert.equal(output?.status, 'invalid')
  assert.match(output?.problem ?? '', /already takes Transport/)
})

test('the office counter is offered only the payment tool; a teacher and a parent none of the fee tools', async () => {
  await ask(office, 'Hello')
  assert.deepEqual(offeredChangeTools().filter((name) => name.startsWith('propose_fee')), ['propose_fee_payment'])
  await ask(accountant, 'Hello')
  assert.deepEqual(offeredChangeTools(), ['propose_fee_concession', 'propose_fee_opt_in', 'propose_fee_payment'])
  for (const client of [teacher, parent]) {
    const calls = server.model.doStreamCalls.length
    await ask(client, 'Hello')
    assert.equal(server.model.doStreamCalls.length, calls + 1, 'the model was asked')
    // The teacher is offered their own change tools; the parent none at all (this server has no read tools).
    if (client === teacher) assert.ok(offeredChangeTools().includes('propose_message'), 'the teacher was offered their tools')
    assert.deepEqual(offeredChangeTools().filter((name) => name.startsWith('propose_fee')), [])
  }
})
