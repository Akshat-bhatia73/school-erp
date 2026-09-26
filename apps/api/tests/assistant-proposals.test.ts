/**
 * The assistant's proposals (Task 24b): a change tool's turn saves an open,
 * sealed proposal; the person's Confirm sends the one write through the real
 * route as them, and nothing else writes. Edits within the editable fields
 * are written as edited; anything else is refused before any write. A record
 * that moved makes the proposal stale; expiry, discard and a double click are
 * handled; a proposal is its owner's alone; the write route's own refusal is
 * the card's outcome; the next turn tells the model where each proposal
 * stands; the nightly sweep removes old ones.
 *
 * The change tool here is a test-only one against the real attendance mark
 * route (PUT the whole roster for today), so the framework is proved apart
 * from the four real tools. The suite builds a school of its own.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { z } from 'zod'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import {
  AttendanceDayPreview,
  AttendanceDayResponse,
  AttendanceMark,
  ROLE_TEMPLATES,
  type AssistantProposal,
} from '@erp/contracts'
import { loadConfig } from '../src/config.ts'
import { createPools } from '../src/db.ts'
import { createSandboxDelivery } from '../src/delivery/index.ts'
import { createAuth } from '../src/auth/better-auth.ts'
import { createMemoryDocumentStorage } from '../src/files/storage.ts'
import { buildApp } from '../src/app.ts'
import { open, seal } from '../src/modules/shared/crypto.ts'
import { proposeTool, type AnyProposeTool } from '../src/assistant/proposals/types.ts'
import { STALE_OUTCOME, REFUSED_OUTCOME } from '../src/assistant/proposals/routes.ts'
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
const TOOL = 'propose_test_register'

const school = randomUUID()
const year = randomUUID()
const grade = randomUUID()
/** The teacher's own section. */
const sectionA = randomUUID()
const sectionB = randomUUID()
const sectionC = randomUUID()
const sectionD = randomUUID()
/** The second teacher's own section. */
const sectionE = randomUUID()
const teacherStaff = randomUUID()
const teacher2Staff = randomUUID()

/** Three pupils in every section: `${first} ${section}`. */
const FIRST_NAMES = ['Asha', 'Bela', 'Chirag'] as const
const pupils = new Map<string, string[]>()

type Server = TestServer & { model: MockLanguageModelV4 }
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let server: Server
let today = ''
let owner: { client: Client; membershipId: string }
let principal: { client: Client; membershipId: string }
let teacher: { client: Client; membershipId: string }
let teacher2: { client: Client; membershipId: string }

// ---------------------------------------------------------------------------
// The test change tool: mark one section's register for today.

const MarkInput = z.object({
  sectionId: z.string(),
  marks: z.array(z.object({ pupil: z.string(), mark: AttendanceMark })).max(60).default([]),
})

const registerTool = proposeTool<z.infer<typeof MarkInput>, AttendanceDayPreview>({
  name: TOOL,
  description: "Test only: propose today's register for one section.",
  kind: 'attendance_day',
  permission: 'attendance.record',
  input: MarkInput,
  preview: AttendanceDayPreview,
  prepare: async (input, context) => {
    const checkPath = `/attendance/sections/${input.sectionId}/days/${context.today}`
    const answer = await context.get(checkPath)
    if (!answer.ok) return answer.status === 403 || answer.status === 404 ? { status: 'not_available' } : { status: 'failed' }
    const day = AttendanceDayResponse.parse(answer.body)
    const wanted = new Map(input.marks.map((line) => [line.pupil.toLowerCase(), line.mark]))
    const known = new Set(day.rows.map((row) => row.student.name.split(' ')[0]?.toLowerCase()))
    for (const name of wanted.keys()) {
      if (!known.has(name)) return { status: 'invalid', problem: `Nobody called ${name} is on this register.` }
    }
    const rows = day.rows.map((row) => ({
      studentId: row.student.id,
      name: row.student.name,
      rollNumber: row.student.rollNumber ?? null,
      current: row.mark ?? null,
      proposed: wanted.get(row.student.name.split(' ')[0]?.toLowerCase() ?? '') ?? 'present',
    }))
    const sectionName = `${day.grade.name} ${day.section.name}`
    return {
      status: 'ok',
      draft: {
        kind: 'attendance_day',
        title: `Mark ${sectionName} for ${day.date}`,
        preview: {
          kind: 'attendance_day',
          mode: day.marked ? 'correction' : 'first_entry',
          sectionId: input.sectionId,
          sectionName,
          date: day.date,
          rows,
        },
        checkPath,
        forModel: { sectionName, notPresent: rows.filter((row) => row.proposed !== 'present').map((row) => row.name) },
        href: `/attendance/${input.sectionId}?date=${day.date}`,
      },
    }
  },
  sameTarget: (original, edited) =>
    original.sectionId === edited.sectionId &&
    original.date === edited.date &&
    original.mode === edited.mode &&
    original.rows.length === edited.rows.length &&
    original.rows.every((row, index) => row.studentId === edited.rows[index]?.studentId),
  write: (preview) =>
    preview.rows.every((row) => row.current === row.proposed)
      ? { problem: 'Nothing has changed.' }
      : {
          method: 'PUT',
          path: `/attendance/sections/${preview.sectionId}/days/${preview.date}`,
          body: { marks: preview.rows.map((row) => ({ studentId: row.studentId, mark: row.proposed })) },
        },
  describeDone: (preview) => {
    const absent = preview.rows.filter((row) => row.proposed === 'absent').length
    return `Saved ${preview.sectionName}'s register: ${preview.rows.length - absent} present, ${absent} absent.`
  },
})

// ---------------------------------------------------------------------------
// A scripted model: "PROPOSE {json}" calls the test tool with that input;
// anything else is answered in words.

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

function proposalModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'test',
    modelId: 'scripted',
    doStream: async (options) => {
      const last = options.prompt[options.prompt.length - 1]
      if (last?.role !== 'user') return words('Check the card and press Confirm.')
      const text = last.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
      const at = text.indexOf('PROPOSE ')
      if (at < 0) return words('Noted.')
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'tool-call' as const, toolCallId: `call-${randomUUID()}`, toolName: TOOL, input: text.slice(at + 'PROPOSE '.length) },
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
      CRON_SECRET: 'assistant-proposals-cron-secret-0123456789ab',
    }),
  )
  const pools = await createPools(config)
  const delivery = createSandboxDelivery(() => {})
  const auth = createAuth(config, pools.auth, delivery, pools.identity)
  const documents = createMemoryDocumentStorage()
  const model = proposalModel()
  // Test-only dependencies: the scripted model, no read tools and the one test change tool.
  const assistant = { assistantModel: model, assistantTools: [], assistantProposeTools: [registerTool as unknown as AnyProposeTool] }
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
const path = (rest: string) => `${base}/assistant${rest}`

function send(method: string, value?: unknown): RequestInit {
  return value === undefined
    ? { method }
    : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
}

async function ok<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text()
  assert.equal(response.status, status, text)
  return (text ? JSON.parse(text) : null) as T
}

async function errorOf(response: Response): Promise<{ status: number; code: string; message: string }> {
  const body = (await response.json()) as { error: { code: string; message: string } }
  return { status: response.status, code: body.error.code, message: body.error.message }
}

async function member(roleKeys: readonly string[], options: { mfa?: boolean; staffId?: string } = {}) {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `ai-prop-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, 'Proposal Member', email])
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
  const client = options.mfa
    ? await signInWithMfa(server, { userId, email, password: PASSWORD })
    : await signInWithPassword(server, email, PASSWORD)
  return { client, membershipId }
}

async function newThread(client: Client): Promise<string> {
  return (await ok<{ id: string }>(await client.fetch(path('/threads'), send('POST')), 201)).id
}

/** Ask one question; returns the stream parts. */
async function ask(client: Client, threadId: string, text: string): Promise<Record<string, unknown>[]> {
  const response = await client.fetch(path(`/threads/${threadId}/turns`), send('POST', { messageId: randomUUID(), text }))
  assert.equal(response.status, 200)
  return streamParts(await response.text())
}

interface ToolOutput {
  status: string
  proposal?: AssistantProposal
  problem?: string
  forModel?: unknown
}

/** Ask the scripted model to propose; returns the tool's output. */
async function propose(
  client: Client,
  threadId: string,
  sectionId: string,
  marks: { pupil: string; mark: string }[] = [],
): Promise<ToolOutput> {
  const parts = await ask(client, threadId, `PROPOSE ${JSON.stringify({ sectionId, marks })}`)
  const output = parts.find((part) => part.type === 'tool-output-available')?.output as ToolOutput | undefined
  assert.ok(output, 'the tool answered')
  return output
}

async function proposed(
  client: Client,
  sectionId: string,
  marks: { pupil: string; mark: string }[] = [],
): Promise<{ threadId: string; proposal: AssistantProposal }> {
  const threadId = await newThread(client)
  const output = await propose(client, threadId, sectionId, marks)
  assert.equal(output.status, 'ok', JSON.stringify(output))
  assert.ok(output.proposal)
  return { threadId, proposal: output.proposal }
}

function confirm(client: Client, proposalId: string, preview: unknown): Promise<Response> {
  return client.fetch(path(`/proposals/${proposalId}/confirm`), send('POST', { preview }))
}

async function confirmed(client: Client, proposal: AssistantProposal, preview: unknown = proposal.preview): Promise<AssistantProposal> {
  return (await ok<{ proposal: AssistantProposal }>(await confirm(client, proposal.id, preview))).proposal
}

async function register(client: Client, sectionId: string): Promise<AttendanceDayResponse> {
  return AttendanceDayResponse.parse(await ok(await client.fetch(`${base}/attendance/sections/${sectionId}/days/${today}`)))
}

async function markOf(sectionId: string, first: string): Promise<string | undefined> {
  const day = await register(owner.client, sectionId)
  return day.rows.find((row) => row.student.name.startsWith(first))?.mark
}

interface ProposalDbRow {
  status: string
  outcome: string | null
  write_request_id: string | null
  edited: boolean | null
  title_sealed: string
  preview_sealed: string
  check_digest: string
  thread_id: string
  membership_id: string
  minutes: number
}

async function row(proposalId: string): Promise<ProposalDbRow> {
  const found = await adminPool().query<ProposalDbRow>(
    `SELECT status, outcome, write_request_id, edited, title_sealed, preview_sealed, check_digest, thread_id,
            membership_id, round(extract(epoch FROM expires_at - created_at) / 60)::int AS minutes
       FROM assistant_proposals WHERE id = $1`,
    [proposalId],
  )
  const first = found.rows[0]
  assert.ok(first, 'the proposal row exists')
  return first
}

async function writesOn(sectionId: string): Promise<{ request_id: string; actor_membership_id: string }[]> {
  const found = await adminPool().query<{ request_id: string; actor_membership_id: string }>(
    `SELECT request_id, actor_membership_id FROM audit_events
      WHERE school_id = $1 AND action = 'attendance.record' AND target_id = $2 AND result = 'allowed'`,
    [school, sectionId],
  )
  return found.rows
}

// ---------------------------------------------------------------------------

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,'AIP')`, [
    school,
    `ai-prop-${suffix}`,
    `Proposal School ${suffix}`,
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
  // In this school the accountant also reads every register, so a teacher
  // who is an accountant too can read a section they may not mark.
  await pool.query(
    `INSERT INTO role_permissions(school_id,role_id,permission,scope)
     SELECT $1, id, 'attendance.read', 'school' FROM roles WHERE school_id = $1 AND key = 'accountant'`,
    [school],
  )
  await pool.query(`INSERT INTO assistant_settings(school_id,enabled) VALUES ($1,true)`, [school])
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,current_date - 100,current_date + 200,'current')`,
    [year, school, `AIP-${suffix}`],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [school, year])
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order,level) VALUES ($1,$2,'Class 9','9',9,9)`, [
    grade,
    school,
  ])
  for (const [staffId, name] of [
    [teacherStaff, 'Proposal Teacher'],
    [teacher2Staff, 'Second Teacher'],
  ] as const) {
    await pool.query(
      `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status,joining_date)
       VALUES ($1,$2,$3,$4,'teaching','Teacher','active',current_date - 100)`,
      [staffId, school, `AIP-${randomUUID().slice(0, 8)}`, name],
    )
  }
  const sections: [string, string, string | null][] = [
    [sectionA, 'A', teacherStaff],
    [sectionB, 'B', null],
    [sectionC, 'C', null],
    [sectionD, 'D', null],
    [sectionE, 'E', teacher2Staff],
  ]
  for (const [id, name, classTeacher] of sections) {
    await pool.query(
      `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, school, year, grade, name, classTeacher],
    )
    const ids: string[] = []
    for (const [index, first] of FIRST_NAMES.entries()) {
      const studentId = randomUUID()
      ids.push(studentId)
      await pool.query(
        `INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,$4,$5,'active')`,
        [studentId, school, `AIP/${suffix}/${name}${index}`, first, `Pupil${name}`],
      )
      await pool.query(
        `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
         VALUES ($1,$2,$3,$4,$5,current_date - 100)`,
        [school, studentId, year, id, index + 1],
      )
    }
    pupils.set(id, ids)
  }

  server = await startServer()
  owner = await member(['owner'], { mfa: true })
  principal = await member(['principal'], { mfa: true })
  teacher = await member(['teacher'], { staffId: teacherStaff })
  teacher2 = await member(['teacher', 'accountant'], { mfa: true, staffId: teacher2Staff })

  const listed = await ok<{ date: string; day: { kind: string } }>(await owner.client.fetch(`${base}/attendance/sections`))
  today = listed.date
  assert.equal(listed.day.kind, 'school_day', 'the proposal suite needs today to be a school day')
})

after(async () => {
  await server.close()
  await closeAdminPool()
})

let teacherThread = ''
let teacherProposal: AssistantProposal

test('a change tool in a turn saves an open proposal, sealed, and the model reads only what it is meant to', async () => {
  teacherThread = await newThread(teacher.client)
  const output = await propose(teacher.client, teacherThread, sectionA, [{ pupil: 'Bela', mark: 'absent' }])
  assert.equal(output.status, 'ok')
  const proposal = output.proposal
  assert.ok(proposal)
  teacherProposal = proposal
  assert.equal(proposal.status, 'open')
  assert.equal(proposal.kind, 'attendance_day')
  assert.equal(proposal.title, `Mark Class 9 A for ${today}`)
  assert.equal(proposal.href, undefined)
  assert.equal(proposal.decidedAt, undefined)
  const preview = AttendanceDayPreview.parse(proposal.preview)
  assert.equal(preview.mode, 'first_entry')
  assert.deepEqual(
    preview.rows.map((entry) => [entry.name.split(' ')[0], entry.current, entry.proposed]),
    [
      ['Asha', null, 'present'],
      ['Bela', null, 'absent'],
      ['Chirag', null, 'present'],
    ],
  )
  assert.deepEqual(output.forModel, {
    proposalId: proposal.id,
    title: proposal.title,
    summary: { sectionName: 'Class 9 A', notPresent: ['Bela PupilA'] },
  })

  // Sealed at rest, in this thread, as this person, for 30 minutes.
  const stored = await row(proposal.id)
  assert.equal(stored.status, 'open')
  assert.equal(stored.thread_id, teacherThread)
  assert.equal(stored.membership_id, teacher.membershipId)
  assert.equal(stored.minutes, 30)
  assert.match(stored.check_digest, /^[0-9a-f]{64}$/)
  assert.ok(!stored.preview_sealed.includes('Bela'))
  assert.ok(!stored.title_sealed.includes('Class 9'))
  const key = server.config.DATA_ENCRYPTION_KEY
  assert.ok(open(stored.preview_sealed, key).includes('Bela PupilA'))
  assert.equal(open(stored.title_sealed, key), proposal.title)

  // The model read forModel only, never the preview's rows.
  const prompt = JSON.stringify(server.model.doStreamCalls.at(-1)?.prompt)
  assert.ok(prompt.includes(proposal.id))
  assert.ok(!prompt.includes(preview.rows[0]?.studentId ?? 'none'))

  // Nothing was written, and the call counted as a tool call.
  assert.equal((await register(teacher.client, sectionA)).marked, false)
  const usage = await adminPool().query<{ tool_calls: number }>(
    `SELECT tool_calls FROM assistant_usage WHERE school_id = $1 AND membership_id = $2`,
    [school, teacher.membershipId],
  )
  assert.deepEqual(usage.rows.map((entry) => entry.tool_calls), [1])
  const turnAudit = await adminPool().query<{ safe_changes: { tools: string[] } }>(
    `SELECT safe_changes FROM audit_events WHERE school_id = $1 AND actor_membership_id = $2 AND target_type = 'assistant_turn'`,
    [school, teacher.membershipId],
  )
  assert.deepEqual(turnAudit.rows[0]?.safe_changes.tools, [TOOL])
})

test('a name the tool cannot find is passed on as a problem, and nothing is saved', async () => {
  const threadId = await newThread(teacher.client)
  const output = await propose(teacher.client, threadId, sectionA, [{ pupil: 'Zoya', mark: 'absent' }])
  assert.deepEqual(output, { status: 'invalid', problem: 'Nobody called zoya is on this register.' })
  assert.ok(JSON.stringify(server.model.doStreamCalls.at(-1)?.prompt).includes('Nobody called zoya is on this register.'))
  const saved = await adminPool().query('SELECT 1 FROM assistant_proposals WHERE thread_id = $1', [threadId])
  assert.equal(saved.rows.length, 0)
})

test('confirm writes through the real route as the person: one audit row, from the route, with the request id kept', async () => {
  const before = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events WHERE school_id = $1 AND actor_membership_id = $2`,
    [school, teacher.membershipId],
  )
  const done = await confirmed(teacher.client, teacherProposal)
  assert.equal(done.status, 'done')
  assert.equal(done.outcome, "Saved Class 9 A's register: 2 present, 1 absent.")
  assert.equal(done.href, `/attendance/${sectionA}?date=${today}`)
  assert.ok(done.decidedAt && Math.abs(Date.parse(done.decidedAt) - Date.now()) < 60_000)

  const day = await register(teacher.client, sectionA)
  assert.equal(day.marked, true)
  assert.equal(day.rows.find((entry) => entry.student.name.startsWith('Bela'))?.mark, 'absent')
  assert.equal(day.rows.find((entry) => entry.student.name.startsWith('Asha'))?.mark, 'present')

  const stored = await row(teacherProposal.id)
  assert.equal(stored.status, 'done')
  assert.equal(stored.edited, false)
  assert.ok(stored.write_request_id)
  const writes = await writesOn(sectionA)
  assert.equal(writes.length, 1)
  assert.equal(writes[0]?.actor_membership_id, teacher.membershipId)
  assert.equal(writes[0]?.request_id, stored.write_request_id)
  // The write route's row is the only one: the proposal routes write none.
  const afterCount = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events WHERE school_id = $1 AND actor_membership_id = $2`,
    [school, teacher.membershipId],
  )
  assert.equal(Number(afterCount.rows[0]?.count) - Number(before.rows[0]?.count), 1)

  // Confirming again changes nothing: it is already done.
  const again = await confirmed(teacher.client, teacherProposal)
  assert.equal(again.status, 'done')
  assert.equal((await writesOn(sectionA)).length, 1)
})

test('the proposal states read back for the thread, and the next turn tells the model where the proposal stands', async () => {
  const states = await ok<{ items: AssistantProposal[] }>(await teacher.client.fetch(path(`/threads/${teacherThread}/proposals`)))
  assert.deepEqual(
    states.items.map((item) => [item.id, item.status, item.outcome]),
    [[teacherProposal.id, 'done', "Saved Class 9 A's register: 2 present, 1 absent."]],
  )

  await ask(teacher.client, teacherThread, 'Is it saved?')
  const replay = server.model.doStreamCalls.at(-1)?.prompt
  const text = JSON.stringify(replay)
  assert.ok(text.includes('\\"status\\":\\"done\\"') || text.includes('"status":"done"'), text)
  assert.ok(text.includes("Saved Class 9 A's register: 2 present, 1 absent."))
  assert.ok(!text.includes('notPresent'))

  // The browser's copy is the proposal as it was made.
  const thread = await ok<{ messages: { parts: { type: string; output?: ToolOutput }[] }[] }>(
    await teacher.client.fetch(path(`/threads/${teacherThread}`)),
  )
  const part = thread.messages.flatMap((message) => message.parts).find((entry) => entry.type === `tool-${TOOL}`)
  assert.equal(part?.output?.proposal?.status, 'open')
  assert.deepEqual((part?.output?.forModel as { summary: unknown }).summary, { sectionName: 'Class 9 A', notPresent: ['Bela PupilA'] })
})

test('an edited mark is written as edited', async () => {
  const { proposal } = await proposed(owner.client, sectionB, [{ pupil: 'Asha', mark: 'absent' }])
  const preview = AttendanceDayPreview.parse(proposal.preview)
  const edited = {
    ...preview,
    rows: preview.rows.map((entry) => (entry.name.startsWith('Chirag') ? { ...entry, proposed: 'late' as const } : entry)),
  }
  const done = await confirmed(owner.client, proposal, edited)
  assert.equal(done.status, 'done')
  assert.equal(AttendanceDayPreview.parse(done.preview).rows[2]?.proposed, 'late')
  assert.equal((await row(proposal.id)).edited, true)
  assert.equal(await markOf(sectionB, 'Asha'), 'absent')
  assert.equal(await markOf(sectionB, 'Chirag'), 'late')
  assert.equal(await markOf(sectionB, 'Bela'), 'present')
})

test("a tool's problem with the preview is a 400 in its own words, and the proposal stays open", async () => {
  // Section B is already marked exactly like this: nothing would change.
  const { proposal } = await proposed(owner.client, sectionB, [
    { pupil: 'Asha', mark: 'absent' },
    { pupil: 'Chirag', mark: 'late' },
  ])
  const response = await confirm(owner.client, proposal.id, proposal.preview)
  // Answered by the proposal scope's own handler, still with the usual headers.
  assert.ok(response.headers.get('x-request-id'))
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const refused = await errorOf(response)
  assert.deepEqual(refused, { status: 400, code: 'INVALID_REQUEST', message: 'Nothing has changed.' })
  assert.equal((await row(proposal.id)).status, 'open')

  // Fixed on the card, it goes through.
  const preview = AttendanceDayPreview.parse(proposal.preview)
  const fixed = { ...preview, rows: preview.rows.map((entry, index) => (index === 0 ? { ...entry, proposed: 'present' as const } : entry)) }
  assert.equal((await confirmed(owner.client, proposal, fixed)).status, 'done')
  assert.equal(await markOf(sectionB, 'Asha'), 'present')
})

test('a preview for another section, another day or with a pupil added is refused, and nothing is written', async () => {
  const { proposal } = await proposed(owner.client, sectionC, [{ pupil: 'Bela', mark: 'absent' }])
  const preview = AttendanceDayPreview.parse(proposal.preview)
  const first = preview.rows[0]
  assert.ok(first)
  const variants: unknown[] = [
    { ...preview, sectionId: sectionD },
    { ...preview, date: '2020-01-02' },
    { ...preview, mode: 'correction' },
    { ...preview, rows: [...preview.rows, { ...first, studentId: randomUUID(), name: 'Someone Else' }] },
    { ...preview, rows: [...preview.rows].reverse() },
    { ...preview, rows: preview.rows.slice(1) },
    { ...preview, kind: 'staff_attendance_day' },
    { ...preview, rows: preview.rows.map((entry) => ({ ...entry, extra: 1 })) },
  ]
  for (const variant of variants) {
    const refused = await errorOf(await confirm(owner.client, proposal.id, variant))
    assert.equal(refused.code, 'INVALID_REQUEST', JSON.stringify(variant))
  }
  assert.equal((await row(proposal.id)).status, 'open')
  assert.equal((await register(owner.client, sectionC)).marked, false)
  assert.equal((await register(owner.client, sectionD)).marked, false)
  assert.equal((await writesOn(sectionC)).length, 0)
})

test('a register someone else changed after the proposal makes it stale, and nothing is written', async () => {
  const { proposal } = await proposed(owner.client, sectionC, [{ pupil: 'Asha', mark: 'absent' }])
  // The principal marks the same register on the screen in between.
  const ids = pupils.get(sectionC) ?? []
  await ok(
    await principal.client.fetch(
      `${base}/attendance/sections/${sectionC}/days/${today}`,
      send('PUT', { marks: ids.map((studentId, index) => ({ studentId, mark: index === 2 ? 'leave' : 'present' })) }),
    ),
  )
  const stale = await confirmed(owner.client, proposal)
  assert.equal(stale.status, 'stale')
  assert.equal(stale.outcome, STALE_OUTCOME)
  assert.equal(await markOf(sectionC, 'Asha'), 'present')
  assert.equal(await markOf(sectionC, 'Chirag'), 'leave')
  const writes = await writesOn(sectionC)
  assert.deepEqual(writes.map((entry) => entry.actor_membership_id), [principal.membershipId])
  assert.equal((await row(proposal.id)).write_request_id, null)
})

test('an expired proposal cannot be confirmed, and reads back as expired', async () => {
  const { threadId, proposal } = await proposed(owner.client, sectionD, [{ pupil: 'Asha', mark: 'absent' }])
  const second = await propose(owner.client, threadId, sectionD, [{ pupil: 'Bela', mark: 'absent' }])
  assert.ok(second.proposal)
  await adminPool().query(
    `UPDATE assistant_proposals SET expires_at = now() - interval '1 minute' WHERE thread_id = $1`,
    [threadId],
  )
  const expired = await confirmed(owner.client, proposal)
  assert.equal(expired.status, 'expired')
  assert.equal((await register(owner.client, sectionD)).marked, false)

  // Reading the states marks the other one expired too.
  const states = await ok<{ items: AssistantProposal[] }>(await owner.client.fetch(path(`/threads/${threadId}/proposals`)))
  assert.deepEqual(states.items.map((item) => item.status), ['expired', 'expired'])
  assert.ok(states.items.every((item) => item.decidedAt === undefined))
  assert.equal((await row(second.proposal.id)).status, 'expired')
})

test('a dismissed proposal stays dismissed and is never written', async () => {
  const { proposal } = await proposed(owner.client, sectionD, [{ pupil: 'Asha', mark: 'absent' }])
  const dismissed = await ok<{ proposal: AssistantProposal }>(await owner.client.fetch(path(`/proposals/${proposal.id}/dismiss`), send('POST')))
  assert.equal(dismissed.proposal.status, 'dismissed')
  assert.equal((await confirmed(owner.client, proposal)).status, 'dismissed')
  const again = await ok<{ proposal: AssistantProposal }>(await owner.client.fetch(path(`/proposals/${proposal.id}/dismiss`), send('POST')))
  assert.equal(again.proposal.status, 'dismissed')
  assert.equal((await register(owner.client, sectionD)).marked, false)
})

test('two confirms at once write once', async () => {
  const { proposal } = await proposed(owner.client, sectionD, [{ pupil: 'Chirag', mark: 'absent' }])
  const [first, second] = await Promise.all([
    confirm(owner.client, proposal.id, proposal.preview),
    confirm(owner.client, proposal.id, proposal.preview),
  ])
  const answers = [
    (await ok<{ proposal: AssistantProposal }>(first)).proposal,
    (await ok<{ proposal: AssistantProposal }>(second)).proposal,
  ]
  assert.deepEqual(answers.map((answer) => answer.status), ['done', 'done'])
  assert.equal((await writesOn(sectionD)).length, 1)
  assert.equal(await markOf(sectionD, 'Chirag'), 'absent')
})

test("nobody else, the owner included, can read, confirm or dismiss someone's proposal", async () => {
  const { threadId, proposal } = await proposed(teacher.client, sectionA, [{ pupil: 'Asha', mark: 'absent' }])
  for (const other of [owner, principal, teacher2]) {
    assert.equal((await errorOf(await other.client.fetch(path(`/threads/${threadId}/proposals`)))).code, 'RESOURCE_NOT_FOUND')
    assert.equal((await errorOf(await confirm(other.client, proposal.id, proposal.preview))).code, 'RESOURCE_NOT_FOUND')
    assert.equal((await errorOf(await other.client.fetch(path(`/proposals/${proposal.id}/dismiss`), send('POST')))).code, 'RESOURCE_NOT_FOUND')
  }
  assert.equal((await row(proposal.id)).status, 'open')
  assert.equal(await markOf(sectionA, 'Asha'), 'present')
  // A proposal that does not exist answers the same.
  assert.equal((await errorOf(await confirm(owner.client, randomUUID(), proposal.preview))).code, 'RESOURCE_NOT_FOUND')
})

test('a teacher confirming for a section they do not teach is refused by the write route', async () => {
  // They can read section A's register (as accountant) but only mark their own section.
  const { proposal } = await proposed(teacher2.client, sectionA, [{ pupil: 'Chirag', mark: 'absent' }])
  const failed = await confirmed(teacher2.client, proposal)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.outcome, REFUSED_OUTCOME)
  assert.equal((await row(proposal.id)).write_request_id, null)
  assert.equal(await markOf(sectionA, 'Chirag'), 'present')
  const writes = await writesOn(sectionA)
  assert.ok(writes.every((entry) => entry.actor_membership_id !== teacher2.membershipId))

  // Their own section goes through.
  const own = await proposed(teacher2.client, sectionE, [{ pupil: 'Chirag', mark: 'absent' }])
  assert.equal((await confirmed(teacher2.client, own.proposal)).status, 'done')
})

test('the nightly sweep removes proposals older than 30 days', async () => {
  const key = server.config.DATA_ENCRYPTION_KEY
  const old = randomUUID()
  await adminPool().query(
    `INSERT INTO assistant_proposals
       (id, school_id, thread_id, membership_id, kind, tool_name, title_sealed, preview_sealed,
        check_path, check_digest, created_at, expires_at)
     VALUES ($1, $2, $3, $4, 'attendance_day', $5, $6, $7, $8, $9, now() - interval '31 days', now() - interval '31 days')`,
    [old, school, teacherThread, teacher.membershipId, TOOL, seal('Old', key), seal('{}', key), `/attendance/sections/${sectionA}/days/${today}`, 'a'.repeat(64)],
  )
  const response = await fetch(`${server.origin}/api/maintenance/sweep`, {
    headers: { authorization: `Bearer ${server.config.CRON_SECRET}` },
  })
  const body = await ok<{ swept: Record<string, number> }>(response)
  assert.ok((body.swept['assistant.assistant_proposals'] ?? 0) >= 1)
  assert.equal((await adminPool().query('SELECT 1 FROM assistant_proposals WHERE id = $1', [old])).rows.length, 0)
  // A recent one is kept.
  assert.equal((await row(teacherProposal.id)).status, 'done')
})
