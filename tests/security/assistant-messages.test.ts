/**
 * Matrix rows: notices through the assistant (Task 24c exit check).
 *
 * The three message change tools (propose_message, propose_message_change,
 * propose_message_withdraw) never send anything. They read the audiences and
 * messages routes as the person, and only the person's Confirm sends the one
 * write, through the real message routes, as them. This file proves it end to
 * end with a scripted model (the AI SDK's mock model) calling the real tools
 * from PROPOSE_TOOLS against the real routes. The real model is never called.
 *
 * It proves that a teacher can neither propose nor confirm a notice to an
 * audience they may not send to; that every fixed field of a card is fixed;
 * that a proposal is its owner's alone; that parents and pupils are offered no
 * message tool and a call to one does nothing; that a withdrawal needs its
 * reason and keeps it only as a redactable note; what the switches do to a
 * Confirm; that the words reach no audit row, usage row or log line; that the
 * consent rule is unchanged; and that a message changed on screen is never
 * overwritten while its delivery figures moving is not a change.
 *
 * The file builds a school of its own, so switching the assistant off touches
 * no other file's school.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import {
  ROLE_TEMPLATES,
  type AssistantProposal,
  type MessageDetail,
  type MessagePreview,
  type MessageWithdrawPreview,
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
const SCHOOL_CODE = `aim-sec-${suffix}`

const school = randomUUID()
const year = randomUUID()
const grade8 = randomUUID()
const grade9 = randomUUID()
/** 8 A: the teacher's own class. */
const sectionMine = randomUUID()
/** 8 B: a class the teacher does not teach. */
const sectionOther = randomUUID()
const section9 = randomUUID()
const maths = randomUUID()

/** Mira's guardian gave no communication consent; Tara's did. */
const mira = randomUUID()
const tara = randomUUID()
const zorawar = randomUUID()
const pia = randomUUID()
const PIA_ADMISSION = `AIMS/${suffix}/P`
const PUPIL_PASSWORD = 'Pupil-Pass!2026'

/** A word no other row carries, put in every notice's words, so it can be looked for anywhere. */
const WORDS = `Sealednotice${suffix}`
const REASON_WORDS = `Withdrawnbecause${suffix}`

let server: CustomServer & { logs: string[] }
let owner: Client
let principal: Client
let teacher: Client
let otherTeacher: Client
let familyParent: Client
let taraParent: Client
let pupilParent: Client
let pupil: Client
let ownerMembershipId = ''
let teacherMembershipId = ''
let teacherStaffId = ''
let miraGuardianId = ''
let taraGuardianId = ''
let pupilGuardianId = ''
let today = ''

// ---------------------------------------------------------------------------
// The server, with every line a request logs kept.

/**
 * The security suite's server (support.ts startServerWith) with one addition:
 * each request's logger is wrapped so the test sees every line it writes. The
 * app logs nothing in tests; this sees each call anyway.
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

interface Script {
  readonly steps: readonly (readonly ScriptedCall[])[]
  readonly answer?: string
}

let script: Script = { steps: [] }
let turnTag = ''

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
}

const model = new MockLanguageModelV4({
  provider: 'test',
  modelId: 'security-messages-script',
  doStream: async (options) => {
    const roles = options.prompt.map((message) => message.role)
    const step = options.prompt.slice(roles.lastIndexOf('user') + 1).filter((message) => message.role === 'tool').length
    const calls = script.steps[step] ?? []
    if (calls.length > 0) {
      return {
        stream: simulateReadableStream({
          chunks: [
            ...calls.map((call, index) => ({
              type: 'tool-call' as const,
              toolCallId: `${turnTag}-${step}-${index}`,
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
          { type: 'text-delta' as const, id: 't1', delta: script.answer ?? 'Check the card and press Confirm.' },
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
  parts: Record<string, unknown>[]
  /** Each scripted call's output, in order; undefined when the call was never run. */
  outputs: (ProposeOutput | undefined)[]
  modelCalls: (typeof model.doStreamCalls)[number][]
}

const api = (rest: string) => `/api/schools/${school}${rest}`
const assistant = (rest: string) => api(`/assistant${rest}`)

async function newThread(client: Client): Promise<string> {
  const response = await client.fetch(assistant('/threads'), postBody({}))
  assert.equal(response.status, 201, await response.clone().text())
  return (await body<{ id: string }>(response)).id
}

async function ask(client: Client, text: string, calls: readonly ScriptedCall[]): Promise<Turn> {
  const threadId = await newThread(client)
  script = { steps: calls.length > 0 ? [calls] : [] }
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
  return { threadId, raw, parts, outputs, modelCalls: model.doStreamCalls.slice(seen) }
}

function proposalOf(output: ProposeOutput | undefined, label: string): AssistantProposal {
  assert.equal(output?.status, 'ok', `${label} answered ${JSON.stringify(output)}`)
  assert.ok(output?.proposal, `${label} has no proposal`)
  return output.proposal
}

async function proposeOne(client: Client, call: ScriptedCall, text = 'Please prepare this notice.'): Promise<AssistantProposal> {
  const turn = await ask(client, text, [call])
  return proposalOf(turn.outputs[0], call.tool)
}

function offered(turn: Turn): Set<string> {
  return new Set(turn.modelCalls.flatMap((call) => (call.tools ?? []).map((entry) => entry.name)))
}

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
}

async function proposalRow(proposalId: string): Promise<ProposalRow> {
  const found = await adminPool().query<ProposalRow>('SELECT status, write_request_id, outcome FROM assistant_proposals WHERE id = $1', [
    proposalId,
  ])
  const row = found.rows[0]
  assert.ok(row, 'the proposal row exists')
  return row
}

async function assertUnwritten(proposalId: string, label: string): Promise<void> {
  const row = await proposalRow(proposalId)
  assert.equal(row.status, 'open', `${label}: the proposal is ${row.status}`)
  assert.equal(row.write_request_id, null, `${label}: the proposal names a write`)
}

/** Every message row of this school, with what could move: its status, version and words. */
async function messageRows(): Promise<string> {
  const found = await adminPool().query<{ line: string }>(
    `SELECT id || ' ' || status || ' ' || version || ' ' || title || ' ' || recipients AS line FROM messages WHERE school_id = $1 ORDER BY id`,
    [school],
  )
  return found.rows.map((row) => row.line).join('\n')
}

async function recipientRowCount(): Promise<number> {
  const found = await adminPool().query<{ count: string }>('SELECT count(*)::text AS count FROM message_recipients WHERE school_id = $1', [school])
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
      WHERE school_id = $1 AND created_at >= $2::timestamptz ORDER BY created_at`,
    [school, since],
  )
  return found.rows
}

/** The audit rows a write left, without the read rows the check read and the assistant's own. */
const writeRows = (rows: AuditRow[]) => rows.filter((row) => row.action.startsWith('communication.'))

async function now(): Promise<string> {
  const found = await adminPool().query<{ at: string }>('SELECT now()::text AS at')
  return found.rows[0]?.at as string
}

function shift(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`)
  moment.setUTCDate(moment.getUTCDate() + days)
  return moment.toISOString().slice(0, 10)
}

async function detailOf(client: Client, messageId: string): Promise<MessageDetail> {
  const response = await client.fetch(api(`/messages/${messageId}`))
  assert.equal(response.status, 200, await response.clone().text())
  return body<MessageDetail>(response)
}

/** A notice written on the Messages screen by the teacher: a draft, or sent at once. */
async function screenMessage(client: Client, title: string, send: 'draft' | 'now'): Promise<MessageDetail> {
  const response = await client.fetch(
    api('/messages'),
    postBody({ audience: { kind: 'section', sectionId: sectionMine }, title, body: `On the screen. ${WORDS}`, send: { when: send } }),
  )
  assert.equal(response.status, 201, await response.clone().text())
  return body<MessageDetail>(response)
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

async function communicationConsent(studentId: string, guardianId: string): Promise<void> {
  await adminPool().query(
    `INSERT INTO guardian_consents(school_id,student_id,guardian_id,purpose,status,method,recorded_by_membership_id,recorded_at)
     VALUES ($1,$2,$3,'communication','given','signed_form',$4,now() - interval '1 day')`,
    [school, studentId, guardianId, ownerMembershipId],
  )
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

async function addPupil(pupilId: string, first: string, sectionId: string, roll: number, admission: string): Promise<void> {
  const pool = adminPool()
  await pool.query(`INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,$4,$5,'active')`, [
    pupilId,
    school,
    admission,
    first,
    `Msgpupil${suffix}`,
  ])
  await pool.query(
    `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,roll_number,joined_on) VALUES ($1,$2,$3,$4,$5,$6)`,
    [school, pupilId, year, sectionId, roll, shift(today, -100)],
  )
}

/** A fresh teacher of a new 8th section of their own, signed in: for the tests that restrict someone. */
async function freshTeacher(sectionName: string): Promise<{ client: Client; membershipId: string; sectionId: string }> {
  const sectionId = randomUUID()
  await adminPool().query(`INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,$5)`, [
    sectionId,
    school,
    year,
    grade8,
    sectionName,
  ])
  await addPupil(randomUUID(), 'Asha', sectionId, 1, `AIMS/${suffix}/${sectionName}`)
  const member = await createTeacher({ schoolId: school, academicYearId: year, sectionIds: [sectionId], subjectId: maths, employeeCode: `AIMS-${sectionName}-${suffix}` })
  await adminPool().query('UPDATE sections SET class_teacher_staff_id = $2 WHERE id = $1', [sectionId, member.staffId])
  return { client: await signInMember(server, member), membershipId: member.membershipId, sectionId }
}

/** Tomorrow at ten on the school's clock: a time every schedule rule allows. */
const tomorrowAtTen = () => ({ when: 'at', date: shift(today, 1), time: '10:00' })

/** A new notice to the teacher's own class. */
const ownNotice = (title: string, when: Record<string, unknown> = { when: 'now' }): ScriptedCall => ({
  tool: 'propose_message',
  input: { audience: '8A', title, body: `Bring a water bottle. ${WORDS}`, ...when },
})

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,'AIMS')`, [
    school,
    SCHOOL_CODE,
    `Assistant Messages Security School ${suffix}`,
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
    `AIMS-${suffix}`,
    shift(today, -100),
    shift(today, 200),
  ])
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [school, year])
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order,level) VALUES ($1,$3,'Class 8','8',8,8),($2,$3,'Class 9','9',9,9)`, [
    grade8,
    grade9,
    school,
  ])
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$4,$5,$6,'A'),($2,$4,$5,$6,'B'),($3,$4,$5,$7,'A')`,
    [sectionMine, sectionOther, section9, school, year, grade8, grade9],
  )
  await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,'Maths',$3,'scholastic')`, [maths, school, `MM${suffix}`])
  await addPupil(mira, 'Mira', sectionMine, 1, `AIMS/${suffix}/M`)
  await addPupil(tara, 'Tara', sectionMine, 2, `AIMS/${suffix}/T`)
  await addPupil(zorawar, 'Zorawar', sectionOther, 1, `AIMS/${suffix}/Z`)
  await addPupil(pia, 'Pia', section9, 1, PIA_ADMISSION)

  server = await startLoggedServer(model)

  const ownerMember = await createMember(school, ['owner'], 'Messages Owner')
  ownerMembershipId = ownerMember.membershipId
  owner = await signInOffice(server, ownerMember)
  principal = await signInOffice(server, await createMember(school, ['principal'], 'Messages Principal'))

  const teacherMember = await createTeacher({ schoolId: school, academicYearId: year, sectionIds: [sectionMine], subjectId: maths, employeeCode: `AIMS-T-${suffix}` })
  teacherMembershipId = teacherMember.membershipId
  teacherStaffId = teacherMember.staffId
  await pool.query('UPDATE sections SET class_teacher_staff_id = $2 WHERE id = $1', [sectionMine, teacherStaffId])
  teacher = await signInMember(server, teacherMember)

  const otherMember = await createTeacher({ schoolId: school, academicYearId: year, sectionIds: [sectionOther], subjectId: maths, employeeCode: `AIMS-O-${suffix}` })
  await pool.query('UPDATE sections SET class_teacher_staff_id = $2 WHERE id = $1', [sectionOther, otherMember.staffId])
  otherTeacher = await signInMember(server, otherMember)

  // Mira's family has the portal and no communication consent; Tara's has both.
  const familyMember = await createMember(school, ['parent'], 'Messages Family Parent')
  miraGuardianId = (await grantPortalAccess({ schoolId: school, membershipId: familyMember.membershipId, studentId: mira, approvedBy: ownerMembershipId })).guardianId
  familyParent = await signInMember(server, familyMember)
  const taraMember = await createMember(school, ['parent'], 'Messages Tara Parent')
  taraGuardianId = (await grantPortalAccess({ schoolId: school, membershipId: taraMember.membershipId, studentId: tara, approvedBy: ownerMembershipId })).guardianId
  await communicationConsent(tara, taraGuardianId)
  taraParent = await signInMember(server, taraMember)

  const pupilParentMember = await createMember(school, ['parent'], 'Messages Pupil Parent')
  pupilGuardianId = (await grantPortalAccess({ schoolId: school, membershipId: pupilParentMember.membershipId, studentId: pia, approvedBy: ownerMembershipId })).guardianId
  pupilParent = await signInMember(server, pupilParentMember)
  pupil = await pupilLogin(pia, PIA_ADMISSION)

  await switchSchool(true)
  const agreed = await pupilParent.fetch(
    api(`/students/${pia}/consents`),
    postBody({ guardianId: pupilGuardianId, purpose: 'ai_assistant', status: 'given', method: 'portal' }),
  )
  assert.equal(agreed.status, 200, await agreed.clone().text())
})

after(async () => {
  await server?.close()
  await closeAdminPool()
})

// ---------------------------------------------------------------------------
// 1. A teacher and audiences they may not send to.

test('[messages] a teacher asking for another class, the whole school or all staff gets a problem and no proposal', async () => {
  const before = await messageRows()
  const calls: ScriptedCall[] = [
    { tool: 'propose_message', input: { audience: '8B', title: 'Trip', body: 'A trip on Friday.', when: 'now' } },
    { tool: 'propose_message', input: { audience: 'Class 8 B', title: 'Trip', body: 'A trip on Friday.', when: 'draft' } },
    { tool: 'propose_message', input: { audience: 'the whole school', title: 'Trip', body: 'A trip on Friday.', when: 'now' } },
    { tool: 'propose_message', input: { audience: 'all staff', title: 'Trip', body: 'A trip on Friday.', when: 'now' } },
    { tool: 'propose_message', input: { pupil: 'Zorawar', title: 'Trip', body: 'A trip on Friday.', when: 'now' } },
  ]
  // The class's own teacher and the owner can: the audiences are real.
  proposalOf((await ask(otherTeacher, 'Tell 8B.', [calls[0]!])).outputs[0], "8 B's teacher")
  for (const call of calls.slice(2, 4)) proposalOf((await ask(owner, 'Tell them.', [call])).outputs[0], `the owner: ${String(call.input.audience)}`)

  const turn = await ask(teacher, 'Tell them all about the trip.', calls)
  turn.outputs.forEach((output, index) => {
    assert.equal(output?.status, 'invalid', `call ${index} answered ${JSON.stringify(output)}`)
    assert.equal(output?.proposal, undefined)
  })
  assert.ok(!turn.raw.includes(zorawar), 'the stream names a pupil of another class by id')
  const saved = await adminPool().query('SELECT 1 FROM assistant_proposals WHERE thread_id = $1', [turn.threadId])
  assert.equal(saved.rowCount, 0, 'a proposal was saved for an audience the teacher may not send to')
  assert.equal(await messageRows(), before)
})

test('[messages] a confirm whose audience was swapped to another class, the school or staff is refused, and nothing is sent', async () => {
  const proposal = await proposeOne(teacher, ownNotice('Sports day'))
  const preview = proposal.preview as MessagePreview
  assert.deepEqual(preview.audience, { kind: 'section', sectionId: sectionMine, recipients: 'families' })
  const since = await now()
  const before = await messageRows()
  const recipients = await recipientRowCount()

  const swaps: unknown[] = [
    { ...preview, audience: { ...preview.audience, sectionId: sectionOther } },
    { ...preview, audience: { kind: 'section', sectionId: sectionOther, recipients: 'families' }, audienceLabel: 'Class 8 B' },
    { ...preview, audience: { kind: 'school', recipients: 'families' }, audienceLabel: 'The whole school' },
    { ...preview, audience: { kind: 'staff' }, audienceLabel: 'All staff', pupilAudience: false },
    { ...preview, audience: { kind: 'pupil', studentId: zorawar, recipients: 'families' } },
  ]
  for (const [index, swapped] of swaps.entries()) {
    const response = await confirm(teacher, proposal.id, swapped)
    assert.equal(response.status, 400, `swap ${index}: ${await response.clone().text()}`)
    assert.equal(await codeOf(response), 'INVALID_REQUEST')
  }
  assert.equal(await messageRows(), before)
  assert.equal(await recipientRowCount(), recipients)
  await assertUnwritten(proposal.id, 'swapped audience')
  assert.deepEqual(writeRows(await auditSince(since)), [])
})

// ---------------------------------------------------------------------------
// 2. Every fixed field of a message card is fixed.

test('[messages] editing any fixed field of a new or changed notice on Confirm is refused, and nothing is written', async () => {
  const draft = await screenMessage(teacher, `Fixed fields draft ${suffix}`, 'draft')
  const secondDraft = await screenMessage(teacher, `Another draft ${suffix}`, 'draft')
  const fresh = await proposeOne(teacher, ownNotice('Library week', tomorrowAtTen()))
  const change = await proposeOne(teacher, {
    tool: 'propose_message_change',
    input: { message: `Fixed fields draft ${suffix}`, title: 'Library week, changed', when: 'now' },
  })
  const staff = await proposeOne(owner, { tool: 'propose_message', input: { audience: 'all staff', title: 'Staff meeting', body: 'At four.', when: 'draft' } })
  const n = fresh.preview as MessagePreview
  const c = change.preview as MessagePreview
  const s = staff.preview as MessagePreview
  assert.equal(c.messageId, draft.id)
  assert.equal(s.pupilAudience, false)
  const since = await now()
  const before = await messageRows()

  const attempts: [Client, AssistantProposal, string, unknown][] = [
    [teacher, fresh, 'messageId', { ...n, messageId: secondDraft.id }],
    [teacher, fresh, 'version', { ...n, version: 1 }],
    [teacher, fresh, 'currentStatus', { ...n, currentStatus: 'draft' }],
    [teacher, fresh, 'audience kind', { ...n, audience: { kind: 'grade', gradeId: grade8, recipients: 'families' } }],
    [teacher, fresh, 'audience id', { ...n, audience: { kind: 'section', sectionId: section9, recipients: 'families' } }],
    [teacher, fresh, 'audienceLabel', { ...n, audienceLabel: 'Class 8 B' }],
    [teacher, fresh, 'pupilAudience', { ...n, pupilAudience: false }],
    [teacher, fresh, 'timeZone', { ...n, timeZone: 'UTC' }],
    [teacher, fresh, 'current', { ...n, current: { title: 'x', body: 'y', sendAt: null, recipients: 'families' } }],
    [teacher, change, 'messageId', { ...c, messageId: secondDraft.id }],
    [teacher, change, 'version', { ...c, version: (c.version ?? 0) + 1 }],
    [teacher, change, 'currentStatus', { ...c, currentStatus: 'scheduled' }],
    [teacher, change, 'current.title', { ...c, current: { ...c.current!, title: 'Something else' } }],
    [teacher, change, 'current.body', { ...c, current: { ...c.current!, body: 'Something else' } }],
    [teacher, change, 'current.sendAt', { ...c, current: { ...c.current!, sendAt: new Date(Date.now() + 86_400_000).toISOString() } }],
    [teacher, change, 'current.recipients', { ...c, current: { ...c.current!, recipients: 'both' } }],
    [teacher, change, 'current dropped', { ...c, current: null }],
    [teacher, change, 'audience id', { ...c, audience: { kind: 'section', sectionId: sectionOther, recipients: 'families' } }],
    [teacher, change, 'timeZone', { ...c, timeZone: 'America/New_York' }],
    // A notice to all staff has no families or pupils to choose.
    [owner, staff, 'recipients on staff', { ...s, audience: { kind: 'staff', recipients: 'both' } }],
    [owner, staff, 'pupilAudience on staff', { ...s, pupilAudience: true }],
    [owner, staff, 'staff to school', { ...s, audience: { kind: 'school', recipients: 'both' }, pupilAudience: true }],
  ]
  for (const [client, proposal, label, edited] of attempts) {
    const response = await confirm(client, proposal.id, edited)
    assert.equal(response.status, 400, `${label}: ${await response.clone().text()}`)
    assert.equal(await codeOf(response), 'INVALID_REQUEST', label)
  }
  assert.equal(await messageRows(), before)
  for (const proposal of [fresh, change, staff]) await assertUnwritten(proposal.id, proposal.title)
  assert.deepEqual(writeRows(await auditSince(since)), [])
  assert.equal((await detailOf(teacher, draft.id)).version, draft.version)
})

// ---------------------------------------------------------------------------
// 3. A proposal is its owner's alone.

test("[messages] nobody else, the owner included, can confirm or dismiss a teacher's message proposal", async () => {
  const draft = await screenMessage(teacher, `Owner only draft ${suffix}`, 'draft')
  const sent = await screenMessage(teacher, `Owner only sent ${suffix}`, 'now')
  const proposals = [
    await proposeOne(teacher, ownNotice('Owner only notice')),
    await proposeOne(teacher, { tool: 'propose_message_change', input: { message: `Owner only draft ${suffix}`, when: 'now' } }),
    await proposeOne(teacher, { tool: 'propose_message_withdraw', input: { message: `Owner only sent ${suffix}`, reason: 'Sent by mistake.' } }),
  ]
  const before = await messageRows()
  const missing = randomUUID()
  for (const [label, other] of [
    ['the owner', owner],
    ['a principal', principal],
    ["8 B's teacher", otherTeacher],
    ['a parent', familyParent],
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
  assert.equal(await messageRows(), before)
  for (const proposal of proposals) await assertUnwritten(proposal.id, proposal.title)
  assert.equal((await detailOf(teacher, draft.id)).status, 'draft')
  assert.equal((await detailOf(teacher, sent.id)).status, 'sent')
})

// ---------------------------------------------------------------------------
// 4. Parents and pupils.

test('[messages] parents and pupils are offered no message tool, and a scripted call to one does nothing', async () => {
  const messageTools = ['propose_message', 'propose_message_change', 'propose_message_withdraw']
  const teacherOffered = offered(await ask(teacher, 'Hello', []))
  for (const name of messageTools) assert.ok(teacherOffered.has(name), `the teacher was not offered ${name}`)

  const sent = await screenMessage(teacher, `Parents cannot withdraw ${suffix}`, 'now')
  for (const [label, client] of [
    ['a parent', familyParent],
    ['a pupil', pupil],
  ] as const) {
    const names = offered(await ask(client, 'Hello', []))
    assert.ok(names.has('student_record'), `${label} was offered no tools at all`)
    for (const name of messageTools) assert.ok(!names.has(name), `${label} was offered ${name}`)

    const before = await messageRows()
    const turn = await ask(client, 'Send a notice to 8A.', [
      ownNotice('From a family'),
      { tool: 'propose_message_withdraw', input: { message: sent.id, reason: 'Not wanted here.' } },
    ])
    // The SDK never runs a tool it was not given: no output, no proposal.
    for (const output of turn.outputs) assert.ok(output === undefined || output.status !== 'ok', `${label}: ${JSON.stringify(output)}`)
    assert.ok(!turn.raw.includes('"proposal"'), `${label}: the stream carries a proposal`)
    const saved = await adminPool().query('SELECT 1 FROM assistant_proposals WHERE thread_id = $1', [turn.threadId])
    assert.equal(saved.rowCount, 0, `${label}: a proposal was saved`)
    assert.equal(await messageRows(), before, `${label}: a message changed`)
  }
  assert.equal((await detailOf(teacher, sent.id)).status, 'sent')
})

// ---------------------------------------------------------------------------
// 5. A withdrawal and its reason.

test('[messages] a withdrawal needs a reason; with one it is the one audit row, and the reason is only its note', async () => {
  const title = `Withdraw me ${WORDS}`
  const sent = await screenMessage(teacher, title, 'now')
  const turn = await ask(teacher, 'Take back the withdraw me notice.', [{ tool: 'propose_message_withdraw', input: { message: title } }])
  const proposal = proposalOf(turn.outputs[0], 'withdraw')
  const preview = proposal.preview as MessageWithdrawPreview
  assert.equal(preview.messageId, sent.id)
  assert.equal(preview.reason, undefined)
  // The model is told the card asks for the reason.
  const seen = JSON.stringify(turn.modelCalls.flatMap((call) => call.prompt.filter((message) => message.role === 'tool')))
  assert.ok(seen.includes('"needsReason":true'), seen)

  // Without a reason, or with a blank one, it is refused as it stands and stays open.
  for (const edited of [preview, { ...preview, reason: undefined }]) {
    const response = await confirm(teacher, proposal.id, edited)
    assert.equal(response.status, 400, await response.clone().text())
    assert.equal(await codeOf(response), 'INVALID_REQUEST')
  }
  const blank = await confirm(teacher, proposal.id, { ...preview, reason: '   ' })
  assert.equal(blank.status, 400, await blank.clone().text())
  await assertUnwritten(proposal.id, 'no reason')
  assert.equal((await detailOf(teacher, sent.id)).status, 'sent')

  const reason = `Sent to the wrong class. ${REASON_WORDS}`
  const since = await now()
  const done = await confirmed(teacher, proposal, { ...preview, reason })
  assert.equal(done.status, 'done', done.outcome)
  assert.equal((await detailOf(teacher, sent.id)).status, 'withdrawn')

  const stored = await proposalRow(proposal.id)
  const rows = writeRows(await auditSince(since))
  assert.equal(rows.length, 1, JSON.stringify(rows))
  const [row] = rows
  assert.equal(row?.actor_membership_id, teacherMembershipId)
  assert.equal(row?.target_id, sent.id)
  assert.equal(row?.request_id, stored.write_request_id)
  for (const secret of [WORDS, REASON_WORDS, 'wrong class', 'Withdraw me']) {
    assert.ok(!row?.summary.includes(secret), `the audit summary holds ${secret}`)
    assert.ok(!row?.changes.includes(secret), `the audit safe_changes hold ${secret}`)
  }
  // The module keeps a typed reason as the row's note, which can be redacted.
  const notes = await adminPool().query<{ note: string }>('SELECT note FROM audit_event_notes WHERE audit_event_id = $1', [row?.id])
  assert.deepEqual(notes.rows.map((note) => note.note), [reason])
})

// ---------------------------------------------------------------------------
// 6. The switches reach Confirm.

test('[messages] switching the school off after a proposal refuses its confirm, and nothing is sent', async () => {
  const proposal = await proposeOne(teacher, ownNotice('Switched off notice'))
  const before = await messageRows()
  await switchSchool(false)
  try {
    const response = await confirm(teacher, proposal.id, proposal.preview)
    assert.ok(response.status >= 400, await response.clone().text())
    assert.equal(await codeOf(response), 'FEATURE_DISABLED')
  } finally {
    await switchSchool(true)
  }
  assert.equal(await messageRows(), before)
  await assertUnwritten(proposal.id, 'switched off')
})

test('[messages] restricting the person after a proposal refuses its confirm and dismiss, and nothing is sent', async () => {
  const who = await freshTeacher('R')
  const proposal = await proposeOne(who.client, {
    tool: 'propose_message',
    input: { audience: '8R', title: 'Restricted notice', body: 'Bring your books.', when: 'now' },
  })
  const before = await messageRows()
  const version = await adminPool().query<{ access_version: number }>('SELECT access_version FROM school_memberships WHERE id = $1', [who.membershipId])
  const restricted = await owner.fetch(
    api(`/members/${who.membershipId}/restrictions`),
    postBody({ permission: 'ai_assistant.use', reason: 'Not for this member', expectedAccessVersion: Number(version.rows[0]?.access_version) }),
  )
  assert.equal(restricted.status, 201, await restricted.clone().text())

  const response = await confirm(who.client, proposal.id, proposal.preview)
  assert.equal(response.status, 403, await response.clone().text())
  assert.equal(await codeOf(response), 'ACCESS_DENIED')
  assert.equal(await codeOf(await dismiss(who.client, proposal.id)), 'ACCESS_DENIED')
  assert.equal(await messageRows(), before)
  const theirs = await adminPool().query('SELECT 1 FROM messages WHERE school_id = $1 AND section_id = $2', [school, who.sectionId])
  assert.equal(theirs.rowCount, 0)
  await assertUnwritten(proposal.id, 'restricted')
})

// ---------------------------------------------------------------------------
// 7 and 8. The words, and consent.

test("[messages] a notice sent from a card reaches only consenting families, and its words reach no audit row, usage row or log line", async () => {
  const logsBefore = server.logs.length
  const since = await now()
  const title = `Picnic ${WORDS}`
  const proposal = await proposeOne(teacher, ownNotice(title, tomorrowAtTen()), `Tell 8A about the picnic. ${WORDS}`)
  const preview = proposal.preview as MessagePreview
  assert.equal(preview.proposed.send.when, 'at')

  // Words with a placeholder the audience cannot fill are refused as they stand, and the refusal is logged.
  const unfillable = await confirm(teacher, proposal.id, { ...preview, proposed: { ...preview.proposed, body: `${WORDS} {fee_amount}` } })
  assert.equal(unfillable.status, 400, await unfillable.clone().text())
  assert.ok(server.logs.length > logsBefore, 'nothing was logged, so the log check below would prove nothing')

  // The person edits what the card lets them: the title, the words, send now, and pupils too.
  const edited: MessagePreview = {
    ...preview,
    audience: { kind: 'section', sectionId: sectionMine, recipients: 'both' },
    proposed: { title: `${title}, today`, body: `Picnic is today. ${WORDS}`, send: { when: 'now' } },
  }
  const done = await confirmed(teacher, proposal, edited)
  assert.equal(done.status, 'done', done.outcome)
  const stored = await proposalRow(proposal.id)

  const created = await adminPool().query<{ id: string; status: string; recipients: string; title: string }>(
    'SELECT id, status, recipients, title FROM messages WHERE school_id = $1 AND title = $2',
    [school, `${title}, today`],
  )
  assert.equal(created.rowCount, 1)
  const message = created.rows[0]!
  assert.equal(message.status, 'sent')
  assert.equal(message.recipients, 'both')

  // One write, as the teacher, under the proposal's request id.
  const rows = writeRows(await auditSince(since))
  assert.equal(rows.length, 1, JSON.stringify(rows))
  assert.equal(rows[0]?.request_id, stored.write_request_id)
  assert.equal(rows[0]?.actor_membership_id, teacherMembershipId)

  // Consent is unchanged: Mira's family gave none and gets nothing; Tara's did and gets it.
  const families = await adminPool().query<{ guardian_id: string; outcome: string; in_app: boolean; email_status: string }>(
    'SELECT guardian_id, outcome, in_app, email_status FROM message_recipients WHERE message_id = $1 AND guardian_id IS NOT NULL',
    [message.id],
  )
  const byGuardian = new Map(families.rows.map((row) => [row.guardian_id, row]))
  assert.equal(byGuardian.get(miraGuardianId)?.outcome, 'no_consent')
  assert.equal(byGuardian.get(miraGuardianId)?.in_app, false)
  assert.equal(byGuardian.get(miraGuardianId)?.email_status, 'none')
  assert.equal(byGuardian.get(taraGuardianId)?.outcome, 'delivered')
  const inbox = async (client: Client) =>
    (await body<{ items: { messageId: string }[] }>(await client.fetch(api('/messages/inbox?pageSize=100')))).items.map((item) => item.messageId)
  assert.ok(!(await inbox(familyParent)).includes(message.id), "Mira's family received a notice without consent")
  assert.ok((await inbox(taraParent)).includes(message.id), "Tara's family did not receive the notice")
  const mirasOwn = await familyParent.fetch(api(`/messages/${message.id}`))
  assert.equal(await codeOf(mirasOwn), 'RESOURCE_NOT_FOUND')

  // The words: in no audit row of this school, no usage row, no log line of any request.
  const audit = await adminPool().query('SELECT 1 FROM audit_events WHERE school_id = $1 AND (summary LIKE $2 OR safe_changes::text LIKE $2)', [
    school,
    `%${WORDS}%`,
  ])
  assert.equal(audit.rowCount, 0, 'an audit row holds the words')
  const usageRows = await adminPool().query('SELECT 1 FROM assistant_usage u WHERE u::text LIKE $1', [`%${WORDS}%`])
  assert.equal(usageRows.rowCount, 0, 'a usage row holds the words')
  const access = await adminPool().query('SELECT 1 FROM access_log l WHERE l::text LIKE $1', [`%${WORDS}%`])
  assert.equal(access.rowCount, 0, 'the request log holds the words')
  const lines = server.logs.slice(logsBefore)
  for (const line of lines) assert.ok(!line.includes(WORDS), `a log line holds the words: ${line.slice(0, 200)}`)
  // And the seal is what hides them in the proposal row.
  const sealed = await adminPool().query('SELECT 1 FROM assistant_proposals p WHERE id = $1 AND p::text LIKE $2', [proposal.id, `%${WORDS}%`])
  assert.equal(sealed.rowCount, 0, 'the proposal row holds the words in the clear')
})

// ---------------------------------------------------------------------------
// 9. Changed on screen, or only delivered.

test('[messages] a draft changed on screen after the proposal is stale, and the screen change stands', async () => {
  const title = `Stale draft ${suffix}`
  const draft = await screenMessage(teacher, title, 'draft')
  const proposal = await proposeOne(teacher, { tool: 'propose_message_change', input: { message: title, title: 'From the card', when: 'now' } })

  const patched = await teacher.fetch(
    api(`/messages/${draft.id}`),
    { ...postBody({ expectedVersion: draft.version, title: 'From the screen' }), method: 'PATCH' },
  )
  assert.equal(patched.status, 200, await patched.clone().text())
  const since = await now()
  const stale = await confirmed(teacher, proposal)
  assert.equal(stale.status, 'stale', stale.outcome)
  assert.equal(stale.outcome, STALE_OUTCOME)
  assert.equal((await proposalRow(proposal.id)).write_request_id, null)
  const after = await detailOf(teacher, draft.id)
  assert.equal(after.title, 'From the screen')
  assert.equal(after.status, 'draft')
  assert.deepEqual(writeRows(await auditSince(since)), [])
})

test('[messages] a sent message whose delivery figures moved is not stale: the withdrawal goes through', async () => {
  const title = `Read then withdrawn ${suffix}`
  const sent = await screenMessage(teacher, title, 'now')
  const proposal = await proposeOne(teacher, { tool: 'propose_message_withdraw', input: { message: title, reason: 'The date was wrong.' } })
  const before = await detailOf(teacher, sent.id)

  // Tara's family reads it: the counts move, the message does not.
  const seen = await body<MessageDetail>(await taraParent.fetch(api(`/messages/${sent.id}`)))
  assert.ok(seen.myReceipt, 'the family has no receipt')
  const read = await taraParent.fetch(api(`/messages/inbox/${seen.myReceipt.recipientId}/read`), postBody({}))
  assert.ok(read.status < 300, await read.clone().text())
  const moved = await detailOf(teacher, sent.id)
  assert.equal(moved.version, before.version)
  assert.equal(moved.counts?.read, (before.counts?.read ?? 0) + 1, 'the read was not counted')

  const done = await confirmed(teacher, proposal)
  assert.equal(done.status, 'done', done.outcome)
  assert.equal((await detailOf(teacher, sent.id)).status, 'withdrawn')
})

test("[messages] a done card's outcome, a plain column, holds no words of any notice and no pupil's name", async () => {
  const proposal = await proposeOne(teacher, {
    tool: 'propose_message',
    input: { pupil: 'Tara', title: `For one family ${WORDS}`, body: `Please meet the class teacher. ${WORDS}`, when: 'now' },
  })
  assert.match((proposal.preview as MessagePreview).audienceLabel, /^Tara /)
  const done = await confirmed(teacher, proposal)
  assert.equal(done.status, 'done', done.outcome)
  assert.equal(done.outcome, "Sent the notice to one pupil's family.")

  const outcomes = await adminPool().query<{ outcome: string }>(
    'SELECT outcome FROM assistant_proposals WHERE school_id = $1 AND outcome IS NOT NULL',
    [school],
  )
  assert.ok(outcomes.rows.length >= 4, `only ${outcomes.rows.length} outcomes`)
  for (const row of outcomes.rows) {
    for (const secret of [WORDS, REASON_WORDS, `Msgpupil${suffix}`, 'Tara', 'Mira', suffix]) {
      assert.ok(!row.outcome.includes(secret), `an outcome holds ${secret}: ${row.outcome}`)
    }
  }
})
