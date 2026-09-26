/**
 * The assistant's API core (Task 24a): the switches in order, the settings
 * and usage, private threads, a streamed turn with a scripted model, the
 * restriction, the sweep, and a pupil's conversations through anonymisation
 * and the subject access export.
 *
 * The suite builds a school of its own with an owner, a principal, two
 * teachers, a parent and a Class 9 pupil with a login of their own.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { ROLE_TEMPLATES } from '@erp/contracts'
import { open, seal } from '../src/modules/shared/crypto.ts'
import {
  adminPool,
  clientFor,
  closeAdminPool,
  resetRateLimits,
  seedDatabaseFixtures,
  setFixturePassword,
  signInWithMfa,
  signInWithPassword,
} from './harness.ts'
import { FAIL_ONCE_WORDS, FAIL_WORDS, SLOW_WORDS, startAssistantServer, streamParts } from './assistant-support.ts'

const PASSWORD = 'Fixture-Pass!42'
const PUPIL_PASSWORD = 'Pupil-Pass!2026'
const suffix = randomUUID().slice(0, 8)
const SCHOOL_CODE = `ai-${suffix}`
const SCHOOL_NAME = `Assistant School ${suffix}`

const school = randomUUID()
const year = randomUUID()
const grade9 = randomUUID()
const section9 = randomUUID()
const pupilId = randomUUID()
const pupilAdmission = `AI/${suffix}/1`
const guardianId = randomUUID()

type Server = Awaited<ReturnType<typeof startAssistantServer>>
type Client = ReturnType<typeof clientFor>
let server: Server
let owner: { client: Client; membershipId: string }
let principal: { client: Client; membershipId: string }
let teacher: { client: Client; membershipId: string }
let restricted: { client: Client; membershipId: string }
let pupil: { client: Client; membershipId: string }

interface ErrorBody {
  error: { code: string }
}
interface Status {
  available: boolean
  reason?: string
  questionsLeftToday: number
  suggestions: string[]
}
interface Settings {
  enabled: boolean
  dailyQuestionsStaff: number
  dailyQuestionsFamily: number
  monthlyQuestions: number
  version: number
  allowedActions: string[]
}

const path = (rest: string) => `/api/schools/${school}/assistant${rest}`

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

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as ErrorBody).error.code
}

async function member(roleKeys: readonly string[], options: { mfa?: boolean } = {}) {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `ai-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, 'Assistant Member', email])
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
  await setFixturePassword(server, userId, PASSWORD)
  const client = options.mfa
    ? await signInWithMfa(server, { userId, email, password: PASSWORD })
    : await signInWithPassword(server, email, PASSWORD)
  return { client, membershipId }
}

async function pupilLogin(): Promise<{ client: Client; membershipId: string }> {
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
    pupilId,
  ])
  await resetRateLimits()
  const client = clientFor(server)
  const response = await client.fetch(
    '/api/student-sign-in',
    send('POST', { schoolCode: SCHOOL_CODE, admissionNumber: pupilAdmission, password: PUPIL_PASSWORD }),
  )
  assert.equal(response.status, 200, await response.text())
  return { client, membershipId }
}

async function status(client: Client): Promise<Status> {
  return ok<Status>(await client.fetch(path('/status')))
}

async function settings(): Promise<Settings> {
  return ok<Settings>(await owner.client.fetch(path('/settings')))
}

async function saveSettings(change: Partial<Settings>): Promise<Settings> {
  const current = await settings()
  const { version, allowedActions: _actions, ...values } = current
  return ok<Settings>(await owner.client.fetch(path('/settings'), send('PUT', { ...values, ...change, expectedVersion: version })))
}

async function consent(state: 'given' | 'withdrawn', minutesAgo: number): Promise<void> {
  await adminPool().query(
    `INSERT INTO guardian_consents(school_id,student_id,guardian_id,purpose,status,method,recorded_by_membership_id,recorded_at)
     VALUES ($1,$2,$3,'ai_assistant',$4,'portal',$5,now() - make_interval(mins => $6))`,
    [school, pupilId, guardianId, state, owner.membershipId, minutesAgo],
  )
}

async function usageRow(membershipId: string): Promise<string> {
  const row = await adminPool().query<{ id: string }>(
    `INSERT INTO assistant_usage(school_id,membership_id,role_keys,school_day,status)
     VALUES ($1,$2,ARRAY['teacher'],(now() AT TIME ZONE 'Asia/Kolkata')::date,'answered') RETURNING id`,
    [school, membershipId],
  )
  return row.rows[0]?.id as string
}

async function newThread(client: Client): Promise<string> {
  return (await ok<{ id: string }>(await client.fetch(path('/threads'), send('POST')), 201)).id
}

async function ask(client: Client, threadId: string, text: string): Promise<Response> {
  return client.fetch(path(`/threads/${threadId}/turns`), send('POST', { messageId: randomUUID(), text }))
}

async function auditRows(targetType: string, membershipId: string) {
  const rows = await adminPool().query<{ target_id: string | null; summary: string; safe_changes: Record<string, unknown>; result: string }>(
    `SELECT target_id, summary, safe_changes, result FROM audit_events
      WHERE school_id = $1 AND target_type = $2 AND actor_membership_id = $3 ORDER BY created_at`,
    [school, targetType, membershipId],
  )
  return rows.rows
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,'AIS')`, [school, SCHOOL_CODE, SCHOOL_NAME])
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
    [year, school, `AI-${suffix}`],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [school, year])
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order,level) VALUES ($1,$2,'Class 9','9',9,9)`, [grade9, school])
  await pool.query(`INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,'A')`, [
    section9,
    school,
    year,
    grade9,
  ])
  await pool.query(
    `INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,'Riya','Pupil','active')`,
    [pupilId, school, pupilAdmission],
  )
  await pool.query(
    `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
     VALUES ($1,$2,$3,$4,1,current_date - 100)`,
    [school, pupilId, year, section9],
  )
  await pool.query(`INSERT INTO guardians(id,school_id,first_name) VALUES ($1,$2,'Family')`, [guardianId, school])
  await pool.query(
    `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation,is_primary) VALUES ($1,$2,$3,'mother',true)`,
    [school, pupilId, guardianId],
  )

  server = await startAssistantServer()
  owner = await member(['owner'], { mfa: true })
  principal = await member(['principal'], { mfa: true })
  teacher = await member(['teacher'])
  restricted = await member(['teacher'])
  pupil = await pupilLogin()
})

after(async () => {
  await server.close()
  await closeAdminPool()
})

test('a school that never saved its settings reads the defaults at version 1, and only managers read them', async () => {
  const defaults = await settings()
  assert.deepEqual(
    { ...defaults, allowedActions: [...defaults.allowedActions].sort() },
    {
      enabled: false,
      dailyQuestionsStaff: 50,
      dailyQuestionsFamily: 20,
      monthlyQuestions: 3000,
      version: 1,
      allowedActions: ['ai_assistant.manage', 'ai_assistant.use'],
    },
  )
  assert.equal(await codeOf(await teacher.client.fetch(path('/settings'))), 'ACCESS_DENIED')
  assert.equal(await codeOf(await teacher.client.fetch(path('/usage'))), 'ACCESS_DENIED')
})

test('the service switch comes first: with the deployment switched off nobody may ask', async () => {
  const off = await startAssistantServer({ ASSISTANT_ENABLED: 'false' })
  try {
    const response = await fetch(`${off.origin}${path('/status')}`, {
      headers: { cookie: teacher.client.jar.header() ?? '' },
    })
    const body = await ok<Status>(response)
    assert.equal(body.available, false)
    assert.equal(body.reason, 'service_off')
  } finally {
    await off.close()
  }
})

test('then the school switch, and the first save writes one audit row', async () => {
  const before = await status(teacher.client)
  assert.deepEqual([before.available, before.reason], [false, 'school_off'])
  assert.ok(before.suggestions.includes('Who is absent in my class today?'))

  const stale = await owner.client.fetch(
    path('/settings'),
    send('PUT', { enabled: true, dailyQuestionsStaff: 50, dailyQuestionsFamily: 20, monthlyQuestions: 3000, expectedVersion: 7 }),
  )
  assert.equal(await codeOf(stale), 'VERSION_CONFLICT')

  const saved = await saveSettings({ enabled: true })
  assert.equal(saved.enabled, true)
  assert.equal(saved.version, 2)
  const rows = await auditRows('ai_assistant', owner.membershipId)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0]?.safe_changes, { changed: ['enabled'], firstSave: true, enabled: true })

  const after = await status(teacher.client)
  assert.deepEqual([after.available, after.reason, after.questionsLeftToday], [true, undefined, 50])
})

test('a pupil needs the newest guardian answer to be yes', async () => {
  assert.equal((await status(pupil.client)).reason, 'no_consent')
  await consent('given', 30)
  assert.equal((await status(pupil.client)).available, true)
  await consent('withdrawn', 20)
  assert.equal((await status(pupil.client)).reason, 'no_consent')
  await consent('given', 10)
  const allowed = await status(pupil.client)
  assert.deepEqual([allowed.available, allowed.questionsLeftToday], [true, 20])
  assert.ok(allowed.suggestions.includes('What is my timetable tomorrow?'))
})

test('then the daily limit per person, then the monthly limit for the school', async () => {
  await saveSettings({ dailyQuestionsStaff: 1 })
  const mine = await usageRow(teacher.membershipId)
  const daily = await status(teacher.client)
  assert.deepEqual([daily.available, daily.reason, daily.questionsLeftToday], [false, 'daily_limit', 0])
  // A family limit is separate from the staff one.
  assert.equal((await status(pupil.client)).available, true)
  const refused = await ask(teacher.client, await newThread(teacher.client), 'Who is absent?')
  assert.equal(await codeOf(refused), 'RATE_LIMITED')
  await adminPool().query('DELETE FROM assistant_usage WHERE id = $1', [mine])

  await saveSettings({ dailyQuestionsStaff: 50, monthlyQuestions: 1 })
  const someoneElse = await usageRow(owner.membershipId)
  assert.equal((await status(teacher.client)).reason, 'monthly_limit')
  await adminPool().query('DELETE FROM assistant_usage WHERE id = $1', [someoneElse])
  await saveSettings({ monthlyQuestions: 3000 })
  assert.equal((await status(teacher.client)).available, true)
})

test('a turn streams the answer, keeps the words sealed, finishes the usage row and writes one audit row', async () => {
  const threadId = await newThread(teacher.client)
  const question = `Which school is this, and who looks after it ${randomUUID()}?`
  const response = await ask(teacher.client, threadId, question)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.ok(response.headers.get('x-request-id'))
  const parts = streamParts(await response.text())

  const outputs = parts.filter((part) => part.type === 'tool-output-available')
  assert.equal(outputs.length, 2)
  const context = outputs.find((part) => part.toolCallId === 'call-1')?.output as Record<string, unknown>
  assert.equal(context.status, 'ok')
  assert.deepEqual(context.forModel, { school: SCHOOL_NAME })
  assert.equal((context.card as { title: string }).title, 'CARD-ONLY-TITLE')
  const settingsOutput = outputs.find((part) => part.toolCallId === 'call-2')?.output as Record<string, unknown>
  assert.deepEqual(settingsOutput, { status: 'not_available' })
  assert.ok(parts.some((part) => part.type === 'text-delta' && part.delta === 'Here is what I found.'))

  // The model read the trimmed part only, and a plain sentence for the refusal.
  const toolTurn = server.model.doStreamCalls.at(-1)
  assert.ok(toolTurn)
  const prompt = JSON.stringify(toolTurn.prompt)
  assert.ok(prompt.includes(SCHOOL_NAME))
  assert.ok(prompt.includes('Not available to you.'))
  assert.ok(!prompt.includes('CARD-ONLY-TITLE'))
  const instructions = JSON.stringify(toolTurn.prompt.filter((message) => message.role === 'system'))
  assert.ok(instructions.includes(SCHOOL_NAME))
  assert.ok(instructions.includes(`AI-${suffix}`))

  // Sealed at rest: neither column holds the question.
  const stored = await adminPool().query<{ role: string; content_sealed: string }>(
    `SELECT role, content_sealed FROM assistant_messages WHERE thread_id = $1 ORDER BY created_at`,
    [threadId],
  )
  assert.deepEqual(stored.rows.map((row) => row.role), ['user', 'assistant'])
  for (const row of stored.rows) assert.ok(!row.content_sealed.includes(question))
  const key = server.config.DATA_ENCRYPTION_KEY
  assert.ok(open(stored.rows[0]?.content_sealed as string, key).includes(question))
  assert.ok(open(stored.rows[1]?.content_sealed as string, key).includes('Here is what I found.'))
  const title = await adminPool().query<{ title_sealed: string }>('SELECT title_sealed FROM assistant_threads WHERE id = $1', [threadId])
  assert.ok(!title.rows[0]?.title_sealed.includes('Which school'))
  assert.equal(open(title.rows[0]?.title_sealed as string, key), question.slice(0, 60).trimEnd() + '…')

  const usage = await adminPool().query(
    `SELECT id, status, model, tool_calls, refused_calls, input_tokens, output_tokens, finished_at, role_keys
       FROM assistant_usage WHERE school_id = $1 AND membership_id = $2`,
    [school, teacher.membershipId],
  )
  assert.equal(usage.rows.length, 1)
  const row = usage.rows[0]
  assert.equal(row.status, 'answered')
  assert.equal(row.model, 'test/scripted')
  assert.deepEqual([row.tool_calls, row.refused_calls, row.input_tokens, row.output_tokens], [2, 1, 22, 14])
  assert.notEqual(row.finished_at, null)
  assert.deepEqual(row.role_keys, ['teacher'])

  const audits = await auditRows('assistant_turn', teacher.membershipId)
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.target_id, row.id)
  assert.equal(audits[0]?.summary, 'Asked the assistant a question.')
  assert.deepEqual(audits[0]?.safe_changes, {
    tools: ['school_context', 'assistant_settings'],
    toolCalls: 2,
    refused: 1,
    model: 'test/scripted',
    inputTokens: 22,
    outputTokens: 14,
    status: 'answered',
  })
  const everything = await adminPool().query<{ text: string }>(
    `SELECT e.summary || e.safe_changes::text || COALESCE(n.note, '') AS text
       FROM audit_events e LEFT JOIN audit_event_notes n ON n.audit_event_id = e.id
      WHERE e.school_id = $1`,
    [school],
  )
  assert.ok(everything.rows.every((entry) => !entry.text.includes(question)))

  // The tool's own inner call is an ordinary request: its refusal is on record.
  const denied = await adminPool().query(
    `SELECT 1 FROM audit_events WHERE school_id = $1 AND actor_membership_id = $2
        AND result = 'denied' AND action = 'ai_assistant.manage'`,
    [school, teacher.membershipId],
  )
  assert.ok(denied.rows.length >= 1)
  const logged = await adminPool().query<{ route: string }>(
    `SELECT route FROM access_log WHERE membership_id = $1 AND route LIKE '/api/schools/:schoolId/assistant/threads/%'`,
    [teacher.membershipId],
  )
  assert.ok(logged.rows.some((entry) => entry.route.endsWith('/turns')))

  // The conversation reads back, oldest first, unsealed, and is listed.
  const thread = await ok<{ title: string; messages: { role: string; parts: { type: string; text?: string }[] }[] }>(
    await teacher.client.fetch(path(`/threads/${threadId}`)),
  )
  assert.deepEqual(thread.messages.map((message) => message.role), ['user', 'assistant'])
  assert.equal(thread.messages[0]?.parts[0]?.text, question)
  assert.ok(thread.messages[1]?.parts.some((part) => part.type === 'tool-school_context'))
  const list = await ok<{ items: { id: string }[] }>(await teacher.client.fetch(path('/threads')))
  assert.deepEqual(list.items.map((item) => item.id), [threadId])

  // The next question replays the kept conversation to the model.
  const second = await ask(teacher.client, threadId, 'And again?')
  assert.equal(second.status, 200)
  await second.text()
  const replay = JSON.stringify(server.model.doStreamCalls.at(-2)?.prompt)
  assert.ok(replay.includes(question))
  assert.ok(!replay.includes('CARD-ONLY-TITLE'))
})

test('a turn that fails after it started still finishes its usage row and its one audit row', async () => {
  const threadId = await newThread(teacher.client)
  const response = await ask(teacher.client, threadId, FAIL_WORDS)
  assert.equal(response.status, 200)
  const parts = streamParts(await response.text())
  const error = parts.find((part) => part.type === 'error')
  assert.equal(error?.errorText, 'Something went wrong while answering. Please try again.')
  const audits = await auditRows('assistant_turn', teacher.membershipId)
  const last = audits.at(-1)
  assert.equal((last?.safe_changes as { status: string }).status, 'failed')
  const usage = await adminPool().query<{ status: string }>('SELECT status FROM assistant_usage WHERE id = $1', [last?.target_id])
  assert.equal(usage.rows[0]?.status, 'failed')
})

test('Try again answers the newest question again, keeping it once; anything else is refused as a repeat', async () => {
  const threadId = await newThread(teacher.client)
  const first = await ask(teacher.client, threadId, 'An earlier question')
  assert.equal(first.status, 200)
  await first.text()

  const text = `${FAIL_ONCE_WORDS} ${randomUUID()}`
  const messageId = randomUUID()
  const turn = (body: { messageId: string; text: string }) => teacher.client.fetch(path(`/threads/${threadId}/turns`), send('POST', body))
  const failed = await turn({ messageId, text })
  assert.equal(failed.status, 200)
  assert.ok(streamParts(await failed.text()).some((part) => part.type === 'error'))

  // The same words under a different question, or an older question, are not a retry.
  assert.equal(await codeOf(await turn({ messageId, text: `${text} changed` })), 'INVALID_REQUEST')
  const kept = await adminPool().query<{ message_key: string }>(
    `SELECT message_key FROM assistant_messages WHERE school_id = $1 AND thread_id = $2 ORDER BY created_at, id`,
    [school, threadId],
  )
  const olderKey = kept.rows[0]?.message_key as string
  assert.equal(await codeOf(await turn({ messageId: olderKey, text: 'An earlier question' })), 'INVALID_REQUEST')

  const retried = await turn({ messageId, text })
  assert.equal(retried.status, 200)
  const parts = streamParts(await retried.text())
  assert.equal(parts.some((part) => part.type === 'error'), false)
  assert.ok(parts.some((part) => part.type === 'text-delta' && part.delta === 'Here is what I found.'))

  const questions = await adminPool().query<{ count: string }>(
    `SELECT count(*) FROM assistant_messages WHERE school_id = $1 AND thread_id = $2 AND message_key = $3`,
    [school, threadId, messageId],
  )
  assert.equal(Number(questions.rows[0]?.count), 1)
})

test('a person who leaves halfway stops the answer, and what was written so far is kept', async () => {
  const threadId = await newThread(teacher.client)
  const leave = new AbortController()
  const response = await teacher.client.fetch(path(`/threads/${threadId}/turns`), {
    ...send('POST', { messageId: randomUUID(), text: SLOW_WORDS }),
    signal: leave.signal,
  })
  assert.equal(response.status, 200)
  const reader = response.body?.getReader()
  assert.ok(reader)
  let seen = ''
  while (!seen.includes('word')) {
    const chunk = await reader.read()
    if (chunk.done) break
    seen += new TextDecoder().decode(chunk.value)
  }
  leave.abort()

  let status: string | undefined
  for (let attempt = 0; attempt < 50 && status === undefined; attempt += 1) {
    const audits = await auditRows('assistant_turn', teacher.membershipId)
    const last = audits.at(-1)?.safe_changes as { status?: string } | undefined
    if (last?.status === 'stopped') status = last.status
    else await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(status, 'stopped')
  const kept = await adminPool().query<{ role: string; content_sealed: string }>(
    'SELECT role, content_sealed FROM assistant_messages WHERE thread_id = $1 ORDER BY created_at',
    [threadId],
  )
  assert.deepEqual(kept.rows.map((row) => row.role), ['user', 'assistant'])
  const answer = open(kept.rows[1]?.content_sealed as string, server.config.DATA_ENCRYPTION_KEY)
  assert.ok(answer.includes('word'))
  assert.ok(answer.split('word').length - 1 < 40)
})

test("a conversation is its owner's alone: the principal cannot list, read, delete or ask in a teacher's", async () => {
  const threadId = await newThread(teacher.client)
  await (await ask(teacher.client, threadId, 'Who is in my class?')).text()

  const list = await ok<{ items: { id: string }[] }>(await principal.client.fetch(path('/threads')))
  assert.ok(!list.items.some((item) => item.id === threadId))
  assert.equal(await codeOf(await principal.client.fetch(path(`/threads/${threadId}`))), 'RESOURCE_NOT_FOUND')
  assert.equal(await codeOf(await principal.client.fetch(path(`/threads/${threadId}`), send('DELETE'))), 'RESOURCE_NOT_FOUND')
  assert.equal(await codeOf(await owner.client.fetch(path(`/threads/${threadId}`))), 'RESOURCE_NOT_FOUND')
  assert.equal(await codeOf(await ask(principal.client, threadId, 'What did they ask?')), 'RESOURCE_NOT_FOUND')
  // Nothing was counted for a refused turn.
  const counted = await adminPool().query('SELECT 1 FROM assistant_usage WHERE membership_id = $1', [principal.membershipId])
  assert.equal(counted.rows.length, 0)

  const removed = await teacher.client.fetch(path(`/threads/${threadId}`), send('DELETE'))
  assert.equal(removed.status, 204)
  const gone = await adminPool().query('SELECT 1 FROM assistant_messages WHERE thread_id = $1', [threadId])
  assert.equal(gone.rows.length, 0)
  const rows = await auditRows('assistant_thread', teacher.membershipId)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.target_id, threadId)
  assert.deepEqual(rows[0]?.safe_changes, {})
})

test('a member restricted from the assistant is refused at the gate, on the status and on a turn', async () => {
  const threadId = await newThread(restricted.client)
  const version = await adminPool().query<{ access_version: number }>(
    'SELECT access_version FROM school_memberships WHERE id = $1',
    [restricted.membershipId],
  )
  const restriction = await owner.client.fetch(
    `/api/schools/${school}/members/${restricted.membershipId}/restrictions`,
    send('POST', {
      permission: 'ai_assistant.use',
      reason: 'Not for this member',
      expectedAccessVersion: Number(version.rows[0]?.access_version),
    }),
  )
  assert.equal(restriction.status, 201, await restriction.text())
  assert.equal(await codeOf(await restricted.client.fetch(path('/status'))), 'ACCESS_DENIED')
  assert.equal(await codeOf(await ask(restricted.client, threadId, 'Hello?')), 'ACCESS_DENIED')
  const denied = await adminPool().query(
    `SELECT 1 FROM audit_events WHERE actor_membership_id = $1 AND result = 'denied' AND action = 'ai_assistant.use'`,
    [restricted.membershipId],
  )
  assert.ok(denied.rows.length >= 2)
})

test('usage counts questions per role, never words', async () => {
  const usage = await ok<{ month: string; questions: number; monthlyQuestions: number; byRole: { role: string; questions: number; people: number }[] }>(
    await principal.client.fetch(path('/usage')),
  )
  assert.match(usage.month, /^\d{4}-\d{2}$/)
  assert.equal(usage.monthlyQuestions, 3000)
  const teachers = usage.byRole.find((entry) => entry.role === 'teacher')
  assert.deepEqual([teachers?.questions, teachers?.people], [usage.questions, 1])
  assert.equal(await codeOf(await principal.client.fetch(path('/usage?month=2026-13'))), 'INVALID_REQUEST')
})

test('the nightly sweep removes messages older than 30 days and the conversations left empty', async () => {
  const pool = adminPool()
  const key = server.config.DATA_ENCRYPTION_KEY
  const old = randomUUID()
  await pool.query(
    `INSERT INTO assistant_threads(id,school_id,membership_id,title_sealed,created_at,last_message_at)
     VALUES ($1,$2,$3,$4,now() - interval '40 days',now() - interval '31 days')`,
    [old, school, teacher.membershipId, seal('Old question', key)],
  )
  await pool.query(
    `INSERT INTO assistant_messages(school_id,thread_id,membership_id,message_key,role,content_sealed,created_at)
     VALUES ($1,$2,$3,$4,'user',$5,now() - interval '31 days')`,
    [school, old, teacher.membershipId, randomUUID(), seal('{}', key)],
  )
  const response = await fetch(`${server.origin}/api/maintenance/sweep`, {
    headers: { authorization: `Bearer ${server.config.CRON_SECRET}` },
  })
  const body = await ok<{ swept: Record<string, number> }>(response)
  assert.ok((body.swept['assistant.assistant_messages'] ?? 0) >= 1)
  assert.ok((body.swept['assistant.assistant_threads'] ?? 0) >= 1)
  assert.equal((await pool.query('SELECT 1 FROM assistant_threads WHERE id = $1', [old])).rows.length, 0)
  // A conversation used today is untouched.
  const recent = await pool.query('SELECT 1 FROM assistant_threads WHERE membership_id = $1', [teacher.membershipId])
  assert.ok(recent.rows.length >= 1)
})

test("a pupil's subject access export counts their conversations without their words, and they go when the pupil is anonymised", async () => {
  const threadId = await newThread(pupil.client)
  const question = `What is my timetable ${randomUUID()}?`
  const response = await ask(pupil.client, threadId, question)
  assert.equal(response.status, 200)
  await response.text()

  const exported = await ok<{ assistantConversations?: { conversations: number; questions: number; keptDays: number } }>(
    await owner.client.fetch(`/api/schools/${school}/students/${pupilId}/subject-access`),
  )
  // That the pupil used it, never what they asked: the words are theirs alone.
  assert.ok((exported.assistantConversations?.conversations ?? 0) >= 1)
  assert.ok((exported.assistantConversations?.questions ?? 0) >= 1)
  assert.equal(exported.assistantConversations?.keptDays, 30)
  assert.equal(JSON.stringify(exported).includes(question), false)

  const pool = adminPool()
  await pool.query(`UPDATE students SET status = 'left', left_on = current_date - interval '4 years' WHERE id = $1`, [pupilId])
  const version = await pool.query<{ version: number }>('SELECT version FROM students WHERE id = $1', [pupilId])
  const anonymised = await owner.client.fetch(
    `/api/schools/${school}/students/${pupilId}/anonymise`,
    send('POST', { expectedVersion: Number(version.rows[0]?.version), reason: 'Retention period has run' }),
  )
  assert.equal(anonymised.status, 200, await anonymised.text())
  const left = await pool.query('SELECT 1 FROM assistant_threads WHERE membership_id = $1', [pupil.membershipId])
  assert.equal(left.rows.length, 0)
  const messages = await pool.query('SELECT 1 FROM assistant_messages WHERE membership_id = $1', [pupil.membershipId])
  assert.equal(messages.rows.length, 0)
  const audit = await pool.query<{ safe_changes: { assistantThreadsDeleted: number } }>(
    `SELECT safe_changes FROM audit_events WHERE school_id = $1 AND action = 'students.anonymise' AND target_id = $2`,
    [school, pupilId],
  )
  assert.equal(audit.rows[0]?.safe_changes.assistantThreadsDeleted, 1)
})
