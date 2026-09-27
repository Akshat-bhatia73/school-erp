/**
 * Matrix rows: fees through the assistant (Task 24d exit check).
 *
 * The three fee change tools (propose_fee_payment, propose_fee_concession,
 * propose_fee_opt_in) never write anything. They read the dues list and the
 * pupil's statement as the person, and only the person's Confirm sends the
 * one write, through the real fee routes, as them. This file proves it end to
 * end with a scripted model (the AI SDK's mock model) calling the real tools
 * from PROPOSE_TOOLS against the real routes. The real model is never called.
 *
 * It proves that parents, pupils and teachers are offered no fee tool and the
 * office counter only the payment; that a pupil of another school cannot be
 * proposed for, and every fixed field of a card is fixed; that a payment can
 * never be more than what is due, nor a second receipt for money taken on the
 * screen meanwhile; that a proposal is its owner's alone; that each Confirm is
 * one audit row naming ids only; that the plain columns name nobody; what the
 * switches do to a Confirm; and that the payer's name and a concession's
 * reason reach no usage row and no log line.
 *
 * The file builds a school of its own, so switching the assistant off touches
 * no other file's school, and a second, bare one to be "another school".
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import {
  ROLE_TEMPLATES,
  type AssistantProposal,
  type FeeConcessionPreview,
  type FeeOptInPreview,
  type FeePaymentPreview,
} from '@erp/contracts'
import { loadConfig } from '../../apps/api/src/config.ts'
import { createPools } from '../../apps/api/src/db.ts'
import { createAuth } from '../../apps/api/src/auth/better-auth.ts'
import { createMemoryDocumentStorage } from '../../apps/api/src/files/storage.ts'
import { buildApp } from '../../apps/api/src/app.ts'
import { STALE_OUTCOME } from '../../apps/api/src/assistant/proposals/routes.ts'
import {
  CookieJar,
  adminPool,
  clientFor,
  closeAdminPool,
  freePort,
  resetRateLimits,
  seedDatabaseFixtures,
  setFixturePassword,
  testEnv,
} from '../../apps/api/tests/harness.ts'
import {
  body,
  codeOf,
  createMember,
  createScriptedDelivery,
  createTeacher,
  grantPortalAccess,
  postBody,
  putBody,
  signInMember,
  signInOffice,
  type Client,
  type CustomServer,
} from './support.ts'

const suffix = randomUUID().slice(0, 8)
/** The suffix in letters only: names in tool calls are in English letters. */
const tag = suffix.replace(/[0-9]/g, (digit) => 'abcdefghij'[Number(digit)]!)
const SCHOOL_CODE = `aif-sec-${suffix}`

const school = randomUUID()
const otherSchool = randomUUID()
const year = randomUUID()
const grade9 = randomUUID()
const nineA = randomUUID()
const maths = randomUUID()

const tuition = randomUUID()
const lab = randomUUID()
const transport = randomUUID()
const TUITION = 100_000
const LAB = 90_000
const TRANSPORT = 180_000

/** Every pupil's surname: a word no other row carries, so it can be looked for anywhere. */
const SURNAME = `Feepupil${tag}`
const PAYER = `Payername ${tag}`
const REASON_WORDS = `Concessionreason${tag}`

const aarav = randomUUID()
const kabir = randomUUID()
const meera = randomUUID()
const rohan = randomUUID()
const sana = randomUUID()
const tanvi = randomUUID()
const pia = randomUUID()
const zubin = randomUUID()
const PIA_ADMISSION = `AIFS/${suffix}/P`
const PUPIL_PASSWORD = 'Pupil-Pass!2026'
const FIRST_NAMES = ['Aarav', 'Kabir', 'Meera', 'Rohan', 'Sana', 'Tanvi', 'Pia', 'Zubin']

let server: CustomServer & { logs: string[] }
let owner: Client
let principal: Client
let accountant: Client
let otherAccountant: Client
let office: Client
let teacher: Client
let parent: Client
let pupil: Client
let ownerMembershipId = ''
let accountantMembershipId = ''
let today = ''

// ---------------------------------------------------------------------------
// The server, with every line a request logs kept.

/**
 * The security suite's server (support.ts startServerWith) with one addition:
 * each request's logger is wrapped so the test sees every line it writes.
 */
async function startLoggedServer(model: MockLanguageModelV4): Promise<CustomServer & { logs: string[] }> {
  const port = await freePort()
  const config = loadConfig(testEnv(port, { ASSISTANT_ENABLED: 'true', AI_GATEWAY_API_KEY: 'test-only-never-used' }))
  const pools = await createPools(config)
  const delivery = createScriptedDelivery()
  const auth = createAuth(config, pools.auth, delivery, pools.identity)
  const documents = createMemoryDocumentStorage()
  const app = buildApp({ config, auth, delivery, pools, documents, assistant: { assistantModel: model } })
  const logs: string[] = []
  app.addHook('onRequest', async (request) => {
    const keep =
      (level: string) =>
      (...args: unknown[]) => {
        logs.push(`${level} ${JSON.stringify(args)}`)
      }
    const capture = new Proxy(request.log, {
      get(target, property, receiver) {
        if (['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(String(property))) return keep(String(property))
        if (property === 'child') return () => capture
        return Reflect.get(target, property, receiver)
      },
    })
    request.log = capture
  })
  await app.listen({ port: config.PORT, host: '127.0.0.1' })
  const origin = `http://127.0.0.1:${config.PORT}`
  const jar = new CookieJar()
  return {
    printRoutes: () => app.printRoutes({ commonPrefix: false }),
    config,
    auth,
    delivery,
    pools,
    documents,
    origin,
    jar,
    logs,
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
      await pools.close().catch(() => undefined)
    },
  }
}

// ---------------------------------------------------------------------------
// The scripted model.

interface ScriptedCall {
  readonly tool: string
  readonly input: Record<string, unknown>
}

let script: readonly ScriptedCall[] = []
let turnTag = ''

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
}

const model = new MockLanguageModelV4({
  provider: 'test',
  modelId: 'security-fees-script',
  doStream: async (options) => {
    const roles = options.prompt.map((message) => message.role)
    const step = options.prompt.slice(roles.lastIndexOf('user') + 1).filter((message) => message.role === 'tool').length
    if (step === 0 && script.length > 0) {
      return {
        stream: simulateReadableStream({
          chunks: [
            ...script.map((call, index) => ({
              type: 'tool-call' as const,
              toolCallId: `${turnTag}-0-${index}`,
              toolName: call.tool,
              input: JSON.stringify(call.input),
            })),
            { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage },
          ],
        }),
      }
    }
    return {
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start' as const, id: 't1' },
          { type: 'text-delta' as const, id: 't1', delta: 'Check the card and press Confirm.' },
          { type: 'text-end' as const, id: 't1' },
          { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
        ],
      }),
    }
  },
})

// ---------------------------------------------------------------------------
// Asking, confirming, reading back.

interface ProposeOutput {
  status: 'ok' | 'not_available' | 'invalid' | 'failed'
  proposal?: AssistantProposal
  problem?: string
  forModel?: unknown
}

interface Turn {
  threadId: string
  raw: string
  /** Each scripted call's output, in order; undefined when the call was never run. */
  outputs: (ProposeOutput | undefined)[]
  modelCalls: (typeof model.doStreamCalls)[number][]
}

const api = (rest: string) => `/api/schools/${school}${rest}`
const assistant = (rest: string) => api(`/assistant${rest}`)

async function ask(client: Client, text: string, calls: readonly ScriptedCall[]): Promise<Turn> {
  const created = await client.fetch(assistant('/threads'), postBody({}))
  assert.equal(created.status, 201, await created.clone().text())
  const threadId = (await body<{ id: string }>(created)).id
  script = calls
  turnTag = randomUUID().slice(0, 8)
  const seen = model.doStreamCalls.length
  const response = await client.fetch(assistant(`/threads/${threadId}/turns`), postBody({ messageId: randomUUID(), text }))
  const raw = await response.text()
  assert.equal(response.status, 200, raw)
  const parts = raw
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>)
  const byId = new Map(
    parts.filter((part) => part.type === 'tool-output-available').map((part) => [part.toolCallId as string, part.output as ProposeOutput]),
  )
  const outputs = calls.map((_, index) => byId.get(`${turnTag}-0-${index}`))
  return { threadId, raw, outputs, modelCalls: model.doStreamCalls.slice(seen) }
}

function proposalOf(output: ProposeOutput | undefined, label: string): AssistantProposal {
  assert.equal(output?.status, 'ok', `${label} answered ${JSON.stringify(output)}`)
  assert.ok(output?.proposal, `${label} has no proposal`)
  return output.proposal
}

async function proposeOne(client: Client, call: ScriptedCall, text = 'Please prepare this.'): Promise<AssistantProposal> {
  return proposalOf((await ask(client, text, [call])).outputs[0], call.tool)
}

function offered(turn: Turn): Set<string> {
  return new Set(turn.modelCalls.flatMap((call) => (call.tools ?? []).map((entry) => entry.name)))
}

const feeTools = (names: Set<string>) => [...names].filter((name) => name.startsWith('propose_fee')).sort()

function confirm(client: Client, proposalId: string, preview: unknown): Promise<Response> {
  return client.fetch(assistant(`/proposals/${proposalId}/confirm`), postBody({ preview }))
}

function dismiss(client: Client, proposalId: string): Promise<Response> {
  return client.fetch(assistant(`/proposals/${proposalId}/dismiss`), { method: 'POST' })
}

async function confirmed(client: Client, proposal: AssistantProposal, preview: unknown = proposal.preview): Promise<AssistantProposal> {
  const response = await confirm(client, proposal.id, preview)
  assert.equal(response.status, 200, await response.clone().text())
  return (await body<{ proposal: AssistantProposal }>(response)).proposal
}

interface ProposalRow {
  status: string
  write_request_id: string | null
  outcome: string | null
  check_path: string
  written_href: string | null
}

async function proposalRow(proposalId: string): Promise<ProposalRow> {
  const found = await adminPool().query<ProposalRow>(
    'SELECT status, write_request_id, outcome, check_path, written_href FROM assistant_proposals WHERE id = $1',
    [proposalId],
  )
  const row = found.rows[0]
  assert.ok(row, 'the proposal row exists')
  return row
}

async function assertUnwritten(proposalId: string, label: string): Promise<void> {
  const row = await proposalRow(proposalId)
  assert.equal(row.status, 'open', `${label}: the proposal is ${row.status}`)
  assert.equal(row.write_request_id, null, `${label}: the proposal names a write`)
}

/** Every fee row of this school that a change could touch, as one fingerprint a refusal must not change. */
async function feeFingerprint(): Promise<string> {
  const found = await adminPool().query<{ fingerprint: string }>(
    `SELECT
       (SELECT count(*)::text FROM fee_student_heads WHERE school_id = $1) || '/' ||
       (SELECT count(*)::text FROM fee_concessions WHERE school_id = $1) || '/' ||
       (SELECT count(*)::text FROM fee_receipts WHERE school_id = $1) || '/' ||
       (SELECT COALESCE(sum(amount_paise), 0)::text FROM fee_receipts WHERE school_id = $1)
       AS fingerprint`,
    [school],
  )
  return found.rows[0]?.fingerprint ?? ''
}

async function receiptsOf(studentId: string): Promise<number> {
  const found = await adminPool().query<{ count: number }>('SELECT count(*)::int AS count FROM fee_receipts WHERE school_id = $1 AND student_id = $2', [
    school,
    studentId,
  ])
  return Number(found.rows[0]?.count)
}

interface AuditRow {
  id: string
  action: string
  actor_membership_id: string | null
  request_id: string
  target_id: string | null
  summary: string
  changes: string
}

async function auditSince(since: string): Promise<AuditRow[]> {
  const found = await adminPool().query<AuditRow>(
    `SELECT id, action, actor_membership_id, request_id, target_id::text, summary, safe_changes::text AS changes FROM audit_events
      WHERE school_id = $1 AND created_at >= $2::timestamptz AND result = 'allowed' ORDER BY created_at`,
    [school, since],
  )
  return found.rows
}

/** The audit rows a fee write left, without the read rows the check read and the assistant's own. */
const writeRows = (rows: AuditRow[]) => rows.filter((row) => row.action === 'fees.collect' || row.action === 'fees.manage')

async function now(): Promise<string> {
  const found = await adminPool().query<{ at: string }>('SELECT now()::text AS at')
  return found.rows[0]?.at as string
}

function shift(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`)
  moment.setUTCDate(moment.getUTCDate() + days)
  return moment.toISOString().slice(0, 10)
}

/** A payment taken on the Fees screen, straight through the route. */
async function collectOnScreen(client: Client, studentId: string, feeHeadId: string, amountPaise: number): Promise<void> {
  const response = await client.fetch(
    api(`/fees/students/${studentId}/collect`),
    postBody({ academicYearId: year, lines: [{ feeHeadId, amountPaise }], mode: 'cash', receivedOn: today }),
  )
  assert.equal(response.status, 201, await response.clone().text())
}

interface Settings {
  dailyQuestionsFamily: number
  monthlyQuestions: number
  version: number
}

async function switchSchool(enabled: boolean): Promise<void> {
  const current = await body<Settings>(await owner.fetch(assistant('/settings')))
  const saved = await owner.fetch(
    assistant('/settings'),
    putBody({
      enabled,
      dailyQuestionsStaff: 500,
      dailyQuestionsFamily: current.dailyQuestionsFamily,
      monthlyQuestions: current.monthlyQuestions,
      expectedVersion: current.version,
    }),
  )
  assert.equal(saved.status, 200, await saved.clone().text())
}

async function pupilLogin(studentId: string, admissionNumber: string): Promise<Client> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  await pool.query(`INSERT INTO auth_user(id,name,email) VALUES ($1::uuid,'Pia',$1::text || '@student.invalid')`, [userId])
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
  await pool.query('INSERT INTO membership_student_links(school_id,membership_id,student_id) VALUES ($1,$2,$3)', [school, membershipId, studentId])
  await resetRateLimits()
  const client = clientFor(server)
  const response = await client.fetch('/api/student-sign-in', postBody({ schoolCode: SCHOOL_CODE, admissionNumber, password: PUPIL_PASSWORD }))
  assert.equal(response.status, 200, await response.text())
  return client
}

const payment = (pupilName: string, extra: Record<string, unknown> = {}): ScriptedCall => ({
  tool: 'propose_fee_payment',
  input: { pupil: pupilName, ...extra },
})

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,'AIFS'),($4,$5,$6,'AIFO')`, [
    school,
    SCHOOL_CODE,
    `Assistant Fees Security School ${suffix}`,
    otherSchool,
    `aif-other-${suffix}`,
    `Assistant Fees Other School ${suffix}`,
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
  const found = await pool.query<{ today: string }>(
    `SELECT to_char((now() AT TIME ZONE timezone)::date, 'YYYY-MM-DD') AS today FROM schools WHERE id = $1`,
    [school],
  )
  today = found.rows[0]?.today as string
  await pool.query(`INSERT INTO academic_years(id,school_id,name,start_date,end_date,status) VALUES ($1,$2,$3,$4,$5,'current')`, [
    year,
    school,
    `AIFS-${suffix}`,
    shift(today, -100),
    shift(today, 200),
  ])
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [school, year])
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order,level) VALUES ($1,$2,'Class 9','9',9,9)`, [grade9, school])
  await pool.query(`INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,'A')`, [nineA, school, year, grade9])
  await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,'Maths',$3,'scholastic')`, [maths, school, `MF${suffix}`])
  for (const [index, [id, first]] of ([
    [aarav, 'Aarav'],
    [kabir, 'Kabir'],
    [meera, 'Meera'],
    [rohan, 'Rohan'],
    [sana, 'Sana'],
    [tanvi, 'Tanvi'],
    [pia, 'Pia'],
  ] as const).entries()) {
    const admission = id === pia ? PIA_ADMISSION : `AIFS/${suffix}/${index + 1}`
    await pool.query(`INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,$4,$5,'active')`, [
      id,
      school,
      admission,
      first,
      SURNAME,
    ])
    await pool.query(
      `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,roll_number,joined_on) VALUES ($1,$2,$3,$4,$5,$6)`,
      [school, id, year, nineA, index + 1, shift(today, -100)],
    )
  }
  // A pupil of another school, with the same surname: never reachable from here.
  await pool.query(`INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,'Zubin',$4,'active')`, [
    zubin,
    otherSchool,
    `AIFO/${suffix}/1`,
    SURNAME,
  ])
  // Tuition monthly and the lab quarterly, both charged to the class; transport is taken by choice.
  for (const [id, name, category, appliesTo, frequency] of [
    [tuition, 'Tuition', 'tuition', 'class', 'monthly'],
    [lab, 'Lab', 'lab', 'class', 'quarterly'],
    [transport, 'Transport', 'transport', 'opt_in', 'monthly'],
  ] as const) {
    await pool.query(`INSERT INTO fee_heads(id,school_id,name,category,applies_to,frequency) VALUES ($1,$2,$3,$4,$5,$6)`, [
      id,
      school,
      name,
      category,
      appliesTo,
      frequency,
    ])
  }
  for (const [headId, gradeId, amount] of [
    [tuition, grade9, TUITION],
    [lab, grade9, LAB],
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

  server = await startLoggedServer(model)

  const ownerMember = await createMember(school, ['owner'], 'Fees Owner')
  ownerMembershipId = ownerMember.membershipId
  owner = await signInOffice(server, ownerMember)
  principal = await signInOffice(server, await createMember(school, ['principal'], 'Fees Principal'))
  const accountantMember = await createMember(school, ['accountant'], 'Fees Accountant')
  accountantMembershipId = accountantMember.membershipId
  accountant = await signInOffice(server, accountantMember)
  otherAccountant = await signInOffice(server, await createMember(school, ['accountant'], 'Fees Other Accountant'))
  office = await signInOffice(server, await createMember(school, ['admin'], 'Fees Office'))
  const teacherMember = await createTeacher({ schoolId: school, academicYearId: year, sectionIds: [nineA], subjectId: maths, employeeCode: `AIFS-T-${suffix}` })
  await pool.query('UPDATE sections SET class_teacher_staff_id = $2 WHERE id = $1', [nineA, teacherMember.staffId])
  teacher = await signInMember(server, teacherMember)

  const parentMember = await createMember(school, ['parent'], 'Fees Parent')
  const guardianId = (await grantPortalAccess({ schoolId: school, membershipId: parentMember.membershipId, studentId: pia, approvedBy: ownerMembershipId }))
    .guardianId
  parent = await signInMember(server, parentMember)
  pupil = await pupilLogin(pia, PIA_ADMISSION)

  await switchSchool(true)
  const agreed = await parent.fetch(api(`/students/${pia}/consents`), postBody({ guardianId, purpose: 'ai_assistant', status: 'given', method: 'portal' }))
  assert.equal(agreed.status, 200, await agreed.clone().text())

  // Aarav's first month of tuition is paid on the screen, so his oldest unpaid fee is the lab.
  await collectOnScreen(accountant, aarav, tuition, TUITION)
})

after(async () => {
  await server?.close()
  await closeAdminPool()
})

// ---------------------------------------------------------------------------
// 1. Who is offered a fee tool at all.

test('[fees] parents, pupils and teachers are offered no fee tool and a call to one does nothing; the office counter only the payment', async () => {
  const all = ['propose_fee_concession', 'propose_fee_opt_in', 'propose_fee_payment']
  for (const [label, client] of [
    ['the owner', owner],
    ['a principal', principal],
    ['the accountant', accountant],
  ] as const) {
    assert.deepEqual(feeTools(offered(await ask(client, 'Hello', []))), all, label)
  }

  const calls: ScriptedCall[] = [
    payment('Pia', { amountRupees: 100 }),
    { tool: 'propose_fee_concession', input: { pupil: 'Pia', fee: 'Tuition', percent: 50, reason: 'Asked for it myself.' } },
    { tool: 'propose_fee_opt_in', input: { pupil: 'Pia', fee: 'Transport' } },
  ]
  for (const [label, client] of [
    ['a parent', parent],
    ['a pupil', pupil],
    ['a teacher', teacher],
  ] as const) {
    const names = offered(await ask(client, 'Hello', []))
    assert.ok(names.size > 0, `${label} was offered no tools at all`)
    assert.deepEqual(feeTools(names), [], `${label} was offered a fee tool`)

    const before = await feeFingerprint()
    const turn = await ask(client, 'Record a payment for Pia.', calls)
    // The SDK never runs a tool it was not given: no output, no proposal.
    for (const output of turn.outputs) assert.ok(output === undefined || output.status !== 'ok', `${label}: ${JSON.stringify(output)}`)
    assert.ok(!turn.raw.includes('"proposal"'), `${label}: the stream carries a proposal`)
    const saved = await adminPool().query('SELECT 1 FROM assistant_proposals WHERE thread_id = $1', [turn.threadId])
    assert.equal(saved.rowCount, 0, `${label}: a proposal was saved`)
    assert.equal(await feeFingerprint(), before, `${label}: a fee row changed`)
  }

  // The office counter takes money and does not set fees.
  assert.deepEqual(feeTools(offered(await ask(office, 'Hello', []))), ['propose_fee_payment'])
  const before = await feeFingerprint()
  const turn = await ask(office, 'Give Pia a concession.', calls.slice(1))
  for (const output of turn.outputs) assert.ok(output === undefined || output.status !== 'ok', `the office: ${JSON.stringify(output)}`)
  const saved = await adminPool().query('SELECT 1 FROM assistant_proposals WHERE thread_id = $1', [turn.threadId])
  assert.equal(saved.rowCount, 0, 'the office saved a concession or optional fee proposal')
  assert.equal(await feeFingerprint(), before)
  // Its payment tool does work, for a pupil of its own school.
  assert.equal((await proposeOne(office, payment('Pia', { amountRupees: 100 }))).kind, 'fee_payment')
})

// ---------------------------------------------------------------------------
// 2. Another school's pupil, and every fixed field of a card.

test("[fees] the accountant cannot propose for another school's pupil: nothing is saved, and the stream names them nowhere", async () => {
  const turn = await ask(accountant, 'Record a payment for Zubin.', [
    payment('Zubin', { amountRupees: 100 }),
    payment(`AIFO/${suffix}/1`, { amountRupees: 100 }),
    { tool: 'propose_fee_concession', input: { pupil: 'Zubin', percent: 10 } },
    { tool: 'propose_fee_opt_in', input: { pupil: 'Zubin', fee: 'Transport' } },
  ])
  turn.outputs.forEach((output, index) => {
    assert.equal(output?.status, 'invalid', `call ${index} answered ${JSON.stringify(output)}`)
    assert.equal(output?.proposal, undefined)
  })
  assert.ok(!turn.raw.includes(zubin), "the stream names the other school's pupil by id")
  const saved = await adminPool().query('SELECT 1 FROM assistant_proposals WHERE thread_id = $1', [turn.threadId])
  assert.equal(saved.rowCount, 0)
  const theirs = await adminPool().query('SELECT 1 FROM fee_receipts WHERE student_id = $1', [zubin])
  assert.equal(theirs.rowCount, 0)
})

test('[fees] editing any fixed field of a payment, concession or optional fee card on Confirm is refused, and nothing is written', async () => {
  const pay = await proposeOne(accountant, payment('Aarav', { amountRupees: 1000 }))
  const give = await proposeOne(accountant, {
    tool: 'propose_fee_concession',
    input: { pupil: 'Aarav', fee: 'Tuition', percent: 10, reason: 'A sibling joined.' },
  })
  const add = await proposeOne(accountant, { tool: 'propose_fee_opt_in', input: { pupil: 'Aarav', fee: 'Transport' } })
  const p = pay.preview as FeePaymentPreview
  const c = give.preview as FeeConcessionPreview
  const o = add.preview as FeeOptInPreview
  assert.deepEqual(p.dues.map((due) => due.feeHeadId), [lab, tuition])
  assert.equal(p.studentId, aarav)
  assert.equal(c.head?.id, tuition)
  assert.equal(o.head.id, transport)
  const since = await now()
  const before = await feeFingerprint()

  const [first, second] = p.dues as [FeePaymentPreview['dues'][number], FeePaymentPreview['dues'][number]]
  const attempts: [AssistantProposal, string, unknown][] = [
    [pay, 'studentId', { ...p, studentId: kabir }],
    [pay, "another school's pupil", { ...p, studentId: zubin }],
    [pay, 'academicYearId', { ...p, academicYearId: randomUUID() }],
    [pay, 'receivedOn', { ...p, receivedOn: shift(today, -1) }],
    [pay, 'balancePaise', { ...p, balancePaise: p.balancePaise + 1_000_000 }],
    [pay, 'dues balance', { ...p, dues: [{ ...first, balancePaise: first.balancePaise + 1_000_000 }, second] }],
    [pay, 'dues order', { ...p, dues: [second, first] }],
    [pay, 'dues id', { ...p, dues: [{ ...first, feeHeadId: transport }, second] }],
    [pay, 'dues dropped', { ...p, dues: [second] }],
    [pay, 'paidToday', { ...p, paidToday: [{ receiptNumber: 'R-1', amountPaise: 100, mode: 'cash' }] }],
    [give, 'studentId', { ...c, studentId: kabir, reason: 'x reason' }],
    [give, 'head', { ...c, head: { id: lab, name: 'Lab' }, reason: 'x reason' }],
    [give, 'head dropped', { ...c, head: null, reason: 'x reason' }],
    [give, 'fees', { ...c, fees: c.fees.map((fee) => ({ ...fee, chargedYearPaise: fee.chargedYearPaise + 100 })), reason: 'x reason' }],
    [give, 'existing', { ...c, existing: [{ headName: null, category: 'other', kind: 'percent', percentBp: 100, amountPaise: null }], reason: 'x reason' }],
    [add, 'head', { ...o, head: { id: lab, name: 'Lab' } }],
    [add, 'frequency', { ...o, frequency: 'yearly' }],
    [add, 'structureAmountPaise', { ...o, structureAmountPaise: 1 }],
    [add, 'yearStartsOn', { ...o, yearStartsOn: shift(o.yearStartsOn, -365) }],
    [add, 'yearEndsOn', { ...o, yearEndsOn: shift(o.yearEndsOn, 365) }],
    [add, 'studentId', { ...o, studentId: kabir }],
  ]
  for (const [proposal, label, edited] of attempts) {
    const response = await confirm(accountant, proposal.id, edited)
    assert.equal(response.status, 400, `${proposal.kind} ${label}: ${await response.clone().text()}`)
    assert.equal(await codeOf(response), 'INVALID_REQUEST', `${proposal.kind} ${label}`)
  }
  assert.equal(await feeFingerprint(), before)
  for (const proposal of [pay, give, add]) await assertUnwritten(proposal.id, proposal.kind)
  // Nothing was attempted as the accountant: no write route ran, allowed or refused.
  assert.deepEqual(writeRows(await auditSince(since)), [])
  for (const proposal of [pay, give, add]) assert.equal((await dismiss(accountant, proposal.id)).status, 200)
})

// ---------------------------------------------------------------------------
// 3. A payment is never more than what is due.

test('[fees] an amount edited above what is due is refused on Confirm, and nothing is written', async () => {
  const proposal = await proposeOne(accountant, payment('Tanvi', { amountRupees: 500 }))
  const preview = proposal.preview as FeePaymentPreview
  const due = preview.dues.reduce((sum, row) => sum + row.balancePaise, 0)
  const before = await feeFingerprint()
  for (const amountPaise of [due + 1, due + 100_000, 99_999_999]) {
    const response = await confirm(accountant, proposal.id, { ...preview, proposed: { ...preview.proposed, amountPaise } })
    assert.equal(response.status, 400, `${amountPaise}: ${await response.clone().text()}`)
    assert.equal(await codeOf(response), 'INVALID_REQUEST')
  }
  // A method other than cash needs its reference.
  const noReference = await confirm(accountant, proposal.id, { ...preview, proposed: { ...preview.proposed, mode: 'upi', reference: null } })
  assert.equal(noReference.status, 400, await noReference.clone().text())
  assert.equal(await feeFingerprint(), before)
  await assertUnwritten(proposal.id, 'overpaid')

  // Exactly what is due goes through, and is the one receipt.
  const done = await confirmed(accountant, proposal, { ...preview, proposed: { ...preview.proposed, amountPaise: due } })
  assert.equal(done.status, 'done', done.outcome ?? '')
  assert.equal(await receiptsOf(tanvi), 1)
})

test('[fees] a payment recorded on the screen after the proposal makes it stale, and no second receipt is written', async () => {
  const proposal = await proposeOne(accountant, payment('Meera', { amountRupees: 500 }))
  const twin = await proposeOne(otherAccountant, payment('Meera'))
  await collectOnScreen(accountant, meera, tuition, 10_000)
  assert.equal(await receiptsOf(meera), 1)
  const since = await now()

  const stale = await confirmed(accountant, proposal)
  assert.equal(stale.status, 'stale', stale.outcome ?? '')
  assert.equal(stale.outcome, STALE_OUTCOME)
  assert.equal((await proposalRow(proposal.id)).write_request_id, null)
  // Another accountant's card for everything due is stale too, even edited down.
  const staleTwin = await confirmed(otherAccountant, twin, {
    ...(twin.preview as FeePaymentPreview),
    proposed: { ...(twin.preview as FeePaymentPreview).proposed, amountPaise: 100 },
  })
  assert.equal(staleTwin.status, 'stale', staleTwin.outcome ?? '')
  assert.equal(await receiptsOf(meera), 1)
  assert.deepEqual(writeRows(await auditSince(since)), [])
})

// ---------------------------------------------------------------------------
// 4. A proposal is its owner's alone.

test("[fees] nobody else, the owner included, can confirm or dismiss the accountant's fee proposal", async () => {
  const proposals = [
    await proposeOne(accountant, payment('Kabir', { amountRupees: 300 })),
    await proposeOne(accountant, { tool: 'propose_fee_concession', input: { pupil: 'Kabir', percent: 5, reason: 'A sibling joined.' } }),
    await proposeOne(accountant, { tool: 'propose_fee_opt_in', input: { pupil: 'Kabir', fee: 'Transport' } }),
  ]
  const before = await feeFingerprint()
  const missing = randomUUID()
  for (const [label, other] of [
    ['the owner', owner],
    ['a principal', principal],
    ['another accountant', otherAccountant],
    ['the office', office],
    ['a parent', parent],
  ] as const) {
    for (const proposal of proposals) {
      const theirs = await confirm(other, proposal.id, proposal.preview)
      const none = await confirm(other, missing, proposal.preview)
      assert.equal(theirs.status, none.status, `${label}: confirm differs from a missing proposal`)
      assert.equal(await codeOf(theirs), 'RESOURCE_NOT_FOUND', `${label} confirming ${proposal.kind}`)
      assert.equal(await codeOf(none), 'RESOURCE_NOT_FOUND')
      assert.equal(await codeOf(await dismiss(other, proposal.id)), 'RESOURCE_NOT_FOUND', `${label} dismissing ${proposal.kind}`)
    }
  }
  assert.equal(await feeFingerprint(), before)
  for (const proposal of proposals) await assertUnwritten(proposal.id, proposal.kind)
  for (const proposal of proposals) assert.equal((await dismiss(accountant, proposal.id)).status, 200)
})

// ---------------------------------------------------------------------------
// 5, 6 and 8. One audit row each, plain columns that name nobody, and the words nowhere.

test('[fees] each Confirm is one audit row naming ids only; the plain columns name nobody; the payer and reason reach no usage row or log line', async () => {
  const logsBefore = server.logs.length
  const since = await now()
  const reason = `Hardship this term. ${REASON_WORDS}`

  // Each is proposed after the one before it is written: a written change moves the statement, which makes an older card stale.
  const pay = await proposeOne(
    accountant,
    payment(`Rohan ${SURNAME}`, { amountRupees: 1200, mode: 'upi', reference: `UPIREF${suffix}`, payerName: PAYER }),
    `Rohan ${SURNAME}'s father ${PAYER} paid by UPI.`,
  )
  const done = [await confirmed(accountant, pay)]
  const give = await proposeOne(
    accountant,
    { tool: 'propose_fee_concession', input: { pupil: 'Rohan', fee: 'Lab', amountRupees: 100, category: 'hardship', reason } },
    `Give Rohan a concession: ${reason}`,
  )
  // A concession without its reason is refused as it stands, and the refusal is logged.
  const noReason = await confirm(accountant, give.id, { ...(give.preview as FeeConcessionPreview), reason: undefined })
  assert.equal(noReason.status, 400, await noReason.clone().text())
  assert.ok(server.logs.length > logsBefore, 'nothing was logged, so the log check below would prove nothing')
  done.push(await confirmed(accountant, give))
  const add = await proposeOne(accountant, { tool: 'propose_fee_opt_in', input: { pupil: 'Rohan', fee: 'Transport' } })
  done.push(await confirmed(accountant, add))
  for (const proposal of done) assert.equal(proposal.status, 'done', `${proposal.kind}: ${proposal.outcome}`)
  assert.equal(done[0]?.outcome, 'Recorded ₹1,200 by UPI.')
  assert.equal(done[1]?.outcome, 'Applied ₹100 off each Lab instalment.')

  // One write each, as the accountant, under each proposal's own request id, naming ids only.
  const rows = writeRows(await auditSince(since))
  assert.equal(rows.length, 3, JSON.stringify(rows))
  const receipt = await adminPool().query<{ id: string; receipt_number: string; payer_name: string | null }>(
    'SELECT id, receipt_number, payer_name FROM fee_receipts WHERE school_id = $1 AND student_id = $2',
    [school, rohan],
  )
  assert.equal(receipt.rowCount, 1)
  const [written] = receipt.rows
  assert.equal(written?.payer_name, PAYER, 'the payer went to the receipt')
  const receiptNumbers = (await adminPool().query<{ receipt_number: string }>('SELECT receipt_number FROM fee_receipts WHERE school_id = $1', [school])).rows.map(
    (row) => row.receipt_number,
  )
  const personal = ['Rohan', SURNAME, PAYER, 'Payername', REASON_WORDS, 'Hardship this term', ...receiptNumbers]
  for (const [index, proposal] of [pay, give, add].entries()) {
    const stored = await proposalRow(proposal.id)
    const row = rows.find((audit) => audit.request_id === stored.write_request_id)
    assert.ok(row, `${proposal.kind}: no audit row under its request id`)
    assert.equal(rows.filter((audit) => audit.request_id === stored.write_request_id).length, 1, `${proposal.kind}: more than one audit row`)
    assert.equal(row.actor_membership_id, accountantMembershipId)
    assert.equal(row.action, index === 0 ? 'fees.collect' : 'fees.manage')
    for (const secret of personal) {
      assert.ok(!row.summary.includes(secret), `${proposal.kind}: the audit summary holds ${secret}`)
      assert.ok(!row.changes.includes(secret), `${proposal.kind}: the audit safe_changes hold ${secret}`)
    }
    if (index === 0) assert.equal(row.target_id, written?.id)
  }
  // The reason is the concession row's note, which can be redacted, and nowhere else in the audit trail.
  const notes = await adminPool().query<{ note: string }>('SELECT note FROM audit_event_notes WHERE audit_event_id = $1', [rows[1]?.id])
  assert.deepEqual(notes.rows.map((note) => note.note), [reason])

  // The plain columns of every fee proposal of this school name nobody and no receipt.
  const payRow = await proposalRow(pay.id)
  assert.equal(payRow.written_href, `/fees/receipts/${written?.id}`)
  assert.match(payRow.written_href ?? '', /^\/fees\/receipts\/[0-9a-f-]{36}$/)
  assert.equal(done[0]?.href, payRow.written_href)
  const plain = await adminPool().query<{ outcome: string | null; check_path: string; written_href: string | null }>(
    `SELECT outcome, check_path, written_href FROM assistant_proposals WHERE school_id = $1 AND kind LIKE 'fee_%'`,
    [school],
  )
  assert.ok(plain.rows.length >= 9, `only ${plain.rows.length} fee proposals`)
  for (const row of plain.rows) {
    for (const column of [row.outcome ?? '', row.check_path, row.written_href ?? '']) {
      for (const secret of [...personal, ...FIRST_NAMES, `AIFS/${suffix}`]) {
        assert.ok(!column.includes(secret), `a plain column holds ${secret}: ${column}`)
      }
    }
  }
  // Everything personal is only in the sealed columns.
  for (const secret of ['Rohan', SURNAME, PAYER, REASON_WORDS]) {
    const clear = await adminPool().query('SELECT 1 FROM assistant_proposals p WHERE school_id = $1 AND p::text LIKE $2', [school, `%${secret}%`])
    assert.equal(clear.rowCount, 0, `a proposal row holds ${secret} in the clear`)
  }

  // The payer and the reason: no audit row of this school, no usage row, no request log, no log line.
  for (const secret of [PAYER, REASON_WORDS]) {
    const audit = await adminPool().query('SELECT 1 FROM audit_events WHERE school_id = $1 AND (summary LIKE $2 OR safe_changes::text LIKE $2)', [
      school,
      `%${secret}%`,
    ])
    assert.equal(audit.rowCount, 0, `an audit row holds ${secret}`)
    const usageRows = await adminPool().query('SELECT 1 FROM assistant_usage u WHERE u::text LIKE $1', [`%${secret}%`])
    assert.equal(usageRows.rowCount, 0, `a usage row holds ${secret}`)
    const access = await adminPool().query('SELECT 1 FROM access_log l WHERE l::text LIKE $1', [`%${secret}%`])
    assert.equal(access.rowCount, 0, `the request log holds ${secret}`)
    for (const line of server.logs.slice(logsBefore)) assert.ok(!line.includes(secret), `a log line holds ${secret}: ${line.slice(0, 200)}`)
  }
})

// ---------------------------------------------------------------------------
// 7. The switches reach Confirm.

test('[fees] switching the school off after a proposal refuses its confirm, and nothing is written', async () => {
  const proposal = await proposeOne(accountant, payment('Sana', { amountRupees: 200 }))
  const before = await feeFingerprint()
  await switchSchool(false)
  try {
    const response = await confirm(accountant, proposal.id, proposal.preview)
    assert.ok(response.status >= 400, await response.clone().text())
    assert.equal(await codeOf(response), 'FEATURE_DISABLED')
  } finally {
    await switchSchool(true)
  }
  assert.equal(await feeFingerprint(), before)
  assert.equal(await receiptsOf(sana), 0)
  await assertUnwritten(proposal.id, 'switched off')
  assert.equal((await dismiss(accountant, proposal.id)).status, 200)
})

test('[fees] restricting the person after a proposal refuses its confirm and dismiss, and nothing is written', async () => {
  const member = await createMember(school, ['accountant'], 'Fees Restricted Accountant')
  const who = await signInOffice(server, member)
  const proposals = [
    await proposeOne(who, payment('Sana', { amountRupees: 200 })),
    await proposeOne(who, { tool: 'propose_fee_concession', input: { pupil: 'Sana', percent: 5, reason: 'A sibling joined.' } }),
  ]
  const before = await feeFingerprint()
  const version = await adminPool().query<{ access_version: number }>('SELECT access_version FROM school_memberships WHERE id = $1', [member.membershipId])
  const restricted = await owner.fetch(
    api(`/members/${member.membershipId}/restrictions`),
    postBody({ permission: 'ai_assistant.use', reason: 'Not for this member', expectedAccessVersion: Number(version.rows[0]?.access_version) }),
  )
  assert.equal(restricted.status, 201, await restricted.clone().text())

  for (const proposal of proposals) {
    const response = await confirm(who, proposal.id, proposal.preview)
    assert.equal(response.status, 403, await response.clone().text())
    assert.equal(await codeOf(response), 'ACCESS_DENIED')
    assert.equal(await codeOf(await dismiss(who, proposal.id)), 'ACCESS_DENIED')
    await assertUnwritten(proposal.id, `restricted ${proposal.kind}`)
  }
  assert.equal(await feeFingerprint(), before)
  assert.equal(await receiptsOf(sana), 0)
})
