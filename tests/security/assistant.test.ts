/**
 * Matrix rows: the assistant (Task 24a exit check).
 *
 * The assistant is the person using it: every tool is one of our own GET
 * routes called as the person, so "is the assistant safe" is "are the routes
 * safe". This file proves it end to end. A scripted model (the AI SDK's mock
 * model) calls exactly the tools a test names, with the inputs the test gives,
 * and the tools are the real ones from READ_TOOLS reaching the real routes. The
 * real model is never called; there is no key.
 *
 * It proves that a teacher, a parent and a pupil get nothing through the
 * assistant a screen would not give them, the promoted child's past year
 * included; that another school's ids read like missing records; that a
 * conversation is its owner's alone; that the switches work on the next
 * request; that no word of a question or an answer is kept anywhere but the
 * sealed message rows; and that each inner call is an ordinary read on the
 * pupil's own record of who opened it.
 *
 * The file builds a school of its own, so switching the assistant on touches
 * no other file's school. Fixture schools A and B are only ever asked about.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { ROLE_TEMPLATES } from '@erp/contracts'
import { fixtureIds } from '@erp/db/fixtures'
import { open } from '../../apps/api/src/modules/shared/crypto.ts'
import { READ_TOOLS } from '../../apps/api/src/assistant/tools/registry.ts'
import {
  adminPool,
  clientFor,
  closeAdminPool,
  resetRateLimits,
  seedDatabaseFixtures,
  setFixturePassword,
} from '../../apps/api/tests/harness.ts'
import {
  body,
  codeOf,
  createMember,
  createTeacher,
  grantPortalAccess,
  postBody,
  putBody,
  signInMember,
  signInOffice,
  startServerWith,
  versionOf,
  type Client,
  type CustomServer,
} from './support.ts'

const suffix = randomUUID().slice(0, 8)
const SCHOOL_CODE = `ai-sec-${suffix}`

const school = randomUUID()
const lastYear = randomUUID()
const year = randomUUID()
const gradeLast = randomUUID()
const gradeNow = randomUUID()
const grade9 = randomUUID()
const lastSection = randomUUID()
const nextSection = randomUUID()
const sectionMine = randomUUID()
const sectionOther = randomUUID()
const section9 = randomUUID()
const maths = randomUUID()

// Pupils. Every name is one no other row in the database carries, so a name
// found anywhere came from that pupil.
const child = randomUUID()
const stranger = randomUUID()
const mira = randomUUID()
const zorawar = randomUUID()
const pia = randomUUID()
const kavya = randomUUID()
const NAMES: Record<string, [string, string]> = {
  [child]: ['Ishaan', `Ownchild${suffix}`],
  [stranger]: ['Veer', `Otherfamily${suffix}`],
  [mira]: ['Mira', `Myclass${suffix}`],
  [zorawar]: ['Zorawar', `Otherclass${suffix}`],
  [pia]: ['Pia', `Selfpupil${suffix}`],
  [kavya]: ['Kavya', `Classmate${suffix}`],
}
const surname = (pupil: string): string => NAMES[pupil]![1]
const PIA_ADMISSION = `AIS/${suffix}/P`
const PUPIL_PASSWORD = 'Pupil-Pass!2026'

// Last year's exams and this year's one paper in the class the teacher does not teach.
const lastPt1 = randomUUID()
const lastHalfYearly = randomUUID()
const examNow = randomUUID()
const lastPapers = { [lastPt1]: randomUUID(), [lastHalfYearly]: randomUUID() }
const otherPaper = randomUUID()

const schoolA = fixtureIds.schoolA as string
const studentA = fixtureIds.studentA as string
const studentB = fixtureIds.studentB as string
const sectionA = fixtureIds.sectionA as string

let server: CustomServer
let owner: Client
let teacher: Client
let familyParent: Client
let pupilParent: Client
let pupil: Client
let ownerMembershipId = ''
let teacherMembershipId = ''
let pupilGuardianId = ''
let today = ''
let lastDay = ''
let childLastReceipt = ''

// ---------------------------------------------------------------------------
// The scripted model.

interface ScriptedCall {
  readonly tool: string
  readonly input: Record<string, unknown>
}

/**
 * What the model does in one turn: the tool calls of each step, in order, and
 * then the answer. `beforeStep` runs as the model is asked for a step, so a
 * test can change the world halfway through a turn.
 */
interface Script {
  readonly steps: readonly (readonly ScriptedCall[])[]
  readonly answer?: string
  readonly beforeStep?: (step: number) => Promise<void>
}

let script: Script = { steps: [] }
let turnTag = ''

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
}

const model = new MockLanguageModelV4({
  provider: 'test',
  modelId: 'security-script',
  doStream: async (options) => {
    const roles = options.prompt.map((message) => message.role)
    // Each finished step of this turn left one tool message after the question.
    const step = options.prompt.slice(roles.lastIndexOf('user') + 1).filter((message) => message.role === 'tool').length
    await script.beforeStep?.(step)
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
          { type: 'text-delta' as const, id: 't1', delta: script.answer ?? 'Here is what I found.' },
          { type: 'text-end' as const, id: 't1' },
          { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
        ],
      }),
    }
  },
})

// ---------------------------------------------------------------------------
// Asking.

interface ToolOutput {
  status: 'ok' | 'not_available' | 'failed'
  forModel?: unknown
  card?: unknown
  source?: { label: string; href: string }
}

interface Turn {
  /** The raw event stream the browser read. */
  raw: string
  /** Every tool output streamed back, in the order the script called them. */
  outputs: ToolOutput[]
  /** What the model was sent on each of its calls in this turn. */
  modelCalls: (typeof model.doStreamCalls)[number][]
}

const assistant = (rest: string) => `/api/schools/${school}/assistant${rest}`

async function newThread(client: Client): Promise<string> {
  const response = await client.fetch(assistant('/threads'), postBody({}))
  assert.equal(response.status, 201, await response.clone().text())
  return (await body<{ id: string }>(response)).id
}

function postTurn(client: Client, threadId: string, text: string): Promise<Response> {
  return client.fetch(assistant(`/threads/${threadId}/turns`), postBody({ messageId: randomUUID(), text }))
}

/** One question with a script, answered in full. */
async function ask(client: Client, threadId: string, text: string, next: Script): Promise<Turn> {
  script = next
  turnTag = randomUUID().slice(0, 8)
  const seen = model.doStreamCalls.length
  const response = await postTurn(client, threadId, text)
  const raw = await response.text()
  assert.equal(response.status, 200, raw)
  const parts = raw
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>)
  const byId = new Map(
    parts
      .filter((part) => part.type === 'tool-output-available')
      .map((part) => [part.toolCallId as string, part.output as ToolOutput]),
  )
  const outputs: ToolOutput[] = []
  next.steps.forEach((calls, step) =>
    calls.forEach((call, index) => {
      const output = byId.get(`${turnTag}-${step}-${index}`)
      assert.ok(output, `no output for ${call.tool} in step ${step}`)
      outputs.push(output)
    }),
  )
  return { raw, outputs, modelCalls: model.doStreamCalls.slice(seen) }
}

/** A turn in a fresh conversation that runs every call in one step. */
async function askOnce(client: Client, calls: readonly ScriptedCall[], text = 'What can you see?'): Promise<Turn> {
  return ask(client, await newThread(client), text, { steps: [calls] })
}

/** The tool results the model was given, as text: what the model could read. */
function toolResultsSeen(turn: Turn): string {
  return JSON.stringify(turn.modelCalls.flatMap((call) => call.prompt.filter((message) => message.role === 'tool')))
}

function assertNothingOf(text: string, secrets: readonly string[], label: string): void {
  for (const secret of secrets) assert.ok(!text.includes(secret), `${label} holds ${secret}`)
}

function forModelOf<T>(output: ToolOutput | undefined, label: string): T {
  assert.equal(output?.status, 'ok', `${label} answered ${output?.status}`)
  return output?.forModel as T
}

// ---------------------------------------------------------------------------
// Set-up helpers.

function shift(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`)
  moment.setUTCDate(moment.getUTCDate() + days)
  return moment.toISOString().slice(0, 10)
}

/** The Wednesday of the week holding `date`, so a mark never falls on a Sunday. */
function midweek(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay()
  return shift(date, 3 - day)
}

async function created(response: Response): Promise<string> {
  const text = await response.text()
  assert.ok(response.status === 200 || response.status === 201, text)
  return (JSON.parse(text) as { id: string }).id
}

async function insertMark(
  paperId: string,
  examId: string,
  yearId: string,
  sectionId: string,
  studentId: string,
  component: string,
  value: number,
): Promise<void> {
  await adminPool().query(
    `INSERT INTO exam_marks(school_id,paper_id,exam_id,academic_year_id,section_id,subject_id,student_id,
                            component,status,marks_tenths,revision,kind,recorded_by_membership_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'marked',$9,1,'entry',$10)`,
    [school, paperId, examId, yearId, sectionId, maths, studentId, component, Math.round(value * 10), ownerMembershipId],
  )
}

const COMPONENTS: Record<string, readonly [string, number][]> = {
  periodic_test_1: [['periodic_test', 8]],
  half_yearly: [
    ['notebook', 4],
    ['subject_enrichment', 4],
    ['written', 61],
  ],
}

/** A pupil login with its own session, as /api/student-sign-in makes one. */
async function pupilLogin(studentId: string, admissionNumber: string): Promise<Client> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  await pool.query(`INSERT INTO auth_user(id,name,email) VALUES ($1::uuid,'Pia',$1::text || '@student.invalid')`, [userId])
  await setFixturePassword(server, userId, PUPIL_PASSWORD)
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'student','active')`,
    [membershipId, school, userId],
  )
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = 'student'`,
    [school, membershipId],
  )
  await pool.query('INSERT INTO membership_student_links(school_id,membership_id,student_id) VALUES ($1,$2,$3)', [
    school,
    membershipId,
    studentId,
  ])
  await resetRateLimits()
  const client = clientFor(server)
  const response = await client.fetch(
    '/api/student-sign-in',
    postBody({ schoolCode: SCHOOL_CODE, admissionNumber, password: PUPIL_PASSWORD }),
  )
  assert.equal(response.status, 200, await response.text())
  return client
}

async function recordConsent(status: 'given' | 'withdrawn'): Promise<void> {
  const response = await pupilParent.fetch(
    `/api/schools/${school}/students/${pia}/consents`,
    postBody({ guardianId: pupilGuardianId, purpose: 'ai_assistant', status, method: 'portal' }),
  )
  assert.equal(response.status, 200, await response.clone().text())
}

interface Settings {
  enabled: boolean
  dailyQuestionsStaff: number
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
      dailyQuestionsStaff: current.dailyQuestionsStaff,
      dailyQuestionsFamily: current.dailyQuestionsFamily,
      monthlyQuestions: current.monthlyQuestions,
      expectedVersion: current.version,
    }),
  )
  assert.equal(saved.status, 200, await saved.clone().text())
}

/** The database clock, so "since" never depends on this process's clock. */
async function now(): Promise<string> {
  const found = await adminPool().query<{ at: string }>('SELECT now()::text AS at')
  return found.rows[0]?.at as string
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,'AIS')`, [
    school,
    SCHOOL_CODE,
    `Assistant Security School ${suffix}`,
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
  const found = await pool.query<{ today: string }>(
    `SELECT to_char((now() AT TIME ZONE timezone)::date, 'YYYY-MM-DD') AS today FROM schools WHERE id = $1`,
    [school],
  )
  today = found.rows[0]?.today as string
  const lastStart = shift(today, -700)
  const yearStart = shift(today, -300)
  lastDay = midweek(shift(today, -500))

  // Last year the two families' children sat one class together; this year
  // is the current one. The promotion between them happens in a test.
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,$4,$5,'upcoming'),($6,$2,$7,$8,$9,'current')`,
    [lastYear, school, `AIS-L-${suffix}`, lastStart, shift(today, -301), year, `AIS-N-${suffix}`, yearStart, shift(today, 200)],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [school, year])
  await pool.query(
    `INSERT INTO grades(id,school_id,name,short_name,sort_order,level)
     VALUES ($1,$4,'Class 7',$5,7,7),($2,$4,'Class 8',$6,8,8),($3,$4,'Class 9',$7,9,9)`,
    [gradeLast, gradeNow, grade9, school, `7${suffix}`, `8${suffix}`, `9${suffix}`],
  )
  const teacherStaff = randomUUID()
  await pool.query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status,joining_date)
     VALUES ($1,$2,$3,'Assistant Class Teacher','teaching','Teacher','active',$4)`,
    [teacherStaff, school, `AIS-${suffix}`, lastStart],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id)
     VALUES ($1,$6,$7,$8,'A',NULL),($2,$6,$9,$10,'A',NULL),($3,$6,$9,$10,'B',$12),
            ($4,$6,$9,$10,'C',NULL),($5,$6,$9,$11,'A',NULL)`,
    [lastSection, nextSection, sectionMine, sectionOther, section9, school, lastYear, gradeLast, year, gradeNow, grade9, teacherStaff],
  )
  await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,'Maths',$3,'scholastic')`, [
    maths,
    school,
    `M${suffix}`,
  ])
  await pool.query(
    `INSERT INTO grade_subjects(school_id,grade_id,academic_year_id,subject_id) VALUES ($1,$2,$3,$4),($1,$5,$6,$4)`,
    [school, gradeLast, lastYear, maths, gradeNow, year],
  )

  const rolls: [string, string, string, string][] = [
    [child, lastYear, lastSection, lastStart],
    [stranger, lastYear, lastSection, lastStart],
    [mira, year, sectionMine, yearStart],
    [zorawar, year, sectionOther, yearStart],
    [pia, year, section9, yearStart],
    [kavya, year, section9, yearStart],
  ]
  for (const [index, [pupilId, yearId, sectionId, joinedOn]] of rolls.entries()) {
    const [first, last] = NAMES[pupilId]!
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,$4,$5,'active')`,
      [pupilId, school, pupilId === pia ? PIA_ADMISSION : `AIS/${suffix}/${index}`, first, last],
    )
    await pool.query(
      `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [school, pupilId, yearId, sectionId, index + 1, joinedOn],
    )
  }

  server = await startServerWith({
    env: { ASSISTANT_ENABLED: 'true', AI_GATEWAY_API_KEY: 'test-only-never-used' },
    // The scripted model only: the tools are the real registry's.
    assistant: { assistantModel: model },
  })

  const ownerMember = await createMember(school, ['owner'], 'Assistant Owner')
  ownerMembershipId = ownerMember.membershipId
  owner = await signInOffice(server, ownerMember)

  const teacherMember = await createMember(school, ['teacher'], 'Assistant Class Teacher')
  teacherMembershipId = teacherMember.membershipId
  await pool.query('INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)', [
    school,
    teacherMember.membershipId,
    teacherStaff,
  ])
  teacher = await signInMember(server, teacherMember)

  const familyMember = await createMember(school, ['parent'], 'Assistant Family Parent')
  await grantPortalAccess({ schoolId: school, membershipId: familyMember.membershipId, studentId: child, approvedBy: ownerMembershipId })
  familyParent = await signInMember(server, familyMember)

  const pupilParentMember = await createMember(school, ['parent'], 'Assistant Pupil Parent')
  pupilGuardianId = (
    await grantPortalAccess({ schoolId: school, membershipId: pupilParentMember.membershipId, studentId: pia, approvedBy: ownerMembershipId })
  ).guardianId
  pupilParent = await signInMember(server, pupilParentMember)
  pupil = await pupilLogin(pia, PIA_ADMISSION)

  // Last year's rows for both children: a mark, a payment, two published
  // exams and a published report card.
  for (const pupilId of [child, stranger]) {
    await pool.query(
      `INSERT INTO attendance_entries(school_id,student_id,section_id,academic_year_id,date,mark,revision,kind,recorded_by_membership_id)
       VALUES ($1,$2,$3,$4,$5::date,'absent',1,'marking',$6)`,
      [school, pupilId, lastSection, lastYear, lastDay, ownerMembershipId],
    )
  }
  const base = `/api/schools/${school}`
  const head = await created(
    await owner.fetch(`${base}/fees/heads`, postBody({ name: `Tuition ${suffix}`, category: 'tuition', appliesTo: 'class', frequency: 'monthly' })),
  )
  await created(
    await owner.fetch(`${base}/fees/structures`, postBody({ academicYearId: lastYear, feeHeadId: head, gradeId: gradeLast, amountPaise: 150_000 })),
  )
  for (const pupilId of [child, stranger]) {
    const receipt = await created(
      await owner.fetch(
        `${base}/fees/students/${pupilId}/collect`,
        postBody({ academicYearId: lastYear, lines: [{ feeHeadId: head, amountPaise: 150_000 }], mode: 'cash', receivedOn: lastDay }),
      ),
    )
    if (pupilId === child) childLastReceipt = receipt
  }
  for (const [examId, kind, offset] of [
    [lastPt1, 'periodic_test_1', -600],
    [lastHalfYearly, 'half_yearly', -450],
  ] as const) {
    await pool.query(
      `INSERT INTO exams(id,school_id,academic_year_id,kind,starts_on,ends_on,recheck_deadline) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [examId, school, lastYear, kind, shift(today, offset), shift(today, offset + 2), shift(today, offset + 10)],
    )
    const paperId = lastPapers[examId]!
    await pool.query(
      `INSERT INTO exam_papers(id,school_id,exam_id,academic_year_id,section_id,subject_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [paperId, school, examId, lastYear, lastSection, maths],
    )
    for (const pupilId of [child, stranger]) {
      for (const [component, value] of COMPONENTS[kind]!) {
        await insertMark(paperId, examId, lastYear, lastSection, pupilId, component, value)
      }
    }
    const published = await owner.fetch(`${base}/exams/${examId}/sections/${lastSection}/publish`, postBody({}))
    assert.ok(published.status < 300, await published.clone().text())
  }
  const carded = await owner.fetch(`${base}/report-cards/sections/${lastSection}/cards/term_1/publish`, postBody({}))
  assert.ok(carded.status < 300, await carded.clone().text())

  // This year: one paper in the class the teacher does not teach, with a mark.
  await pool.query(
    `INSERT INTO exams(id,school_id,academic_year_id,kind,starts_on,ends_on,recheck_deadline)
     VALUES ($1,$2,$3,'periodic_test_1',$4,$5,$6)`,
    [examNow, school, year, shift(today, -100), shift(today, -98), shift(today, -90)],
  )
  await pool.query(
    `INSERT INTO exam_papers(id,school_id,exam_id,academic_year_id,section_id,subject_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [otherPaper, school, examNow, year, sectionOther, maths],
  )
  await insertMark(otherPaper, examNow, year, sectionOther, zorawar, 'periodic_test', 7)

  // The school switches the assistant on through its own settings route, and
  // Pia's guardian agrees through the parent's own consent route.
  await switchSchool(true)
  await recordConsent('given')
})

after(async () => {
  await server?.close()
  await closeAdminPool()
})

// ---------------------------------------------------------------------------
// 1. A teacher and another class.

/** Every read a screen offers about the class next door, as tool calls. */
const otherClassCalls = (): ScriptedCall[] => [
  { tool: 'section_attendance_day', input: { sectionId: sectionOther } },
  { tool: 'section_attendance_month', input: { sectionId: sectionOther } },
  { tool: 'section_timetable', input: { sectionId: sectionOther } },
  { tool: 'paper_marks', input: { paperId: otherPaper } },
  { tool: 'student_record', input: { studentId: zorawar } },
  { tool: 'student_attendance_month', input: { studentId: zorawar } },
  { tool: 'student_enrolments', input: { studentId: zorawar } },
  { tool: 'section_details', input: { sectionId: sectionOther } },
]

test('[assistant] a teacher asking about a class they do not teach gets not available for every tool, and no name or id of it', async () => {
  // The same eight calls as the owner answer with the class, so every one of
  // them names a real record the teacher is being kept from.
  const control = await askOnce(owner, otherClassCalls())
  control.outputs.forEach((output, index) => assert.equal(output.status, 'ok', `owner: ${otherClassCalls()[index]?.tool}`))
  assert.ok(JSON.stringify(control.outputs).includes(surname(zorawar)))

  const turn = await askOnce(teacher, otherClassCalls(), 'Tell me about class 8C.')
  turn.outputs.forEach((output, index) =>
    assert.deepEqual(output, { status: 'not_available' }, `${otherClassCalls()[index]?.tool} answered ${output.status}`),
  )
  const secrets = [surname(zorawar), 'Zorawar', zorawar, sectionOther, otherPaper, examNow]
  assertNothingOf(JSON.stringify(turn.outputs), secrets, 'a tool output')
  assertNothingOf(toolResultsSeen(turn), secrets, "the model's tool results")
  // Nor does anything the browser was sent.
  assertNothingOf(turn.raw, [surname(zorawar)], 'the stream')

  // A search by name answers, and answers with nobody from that class.
  const search = await askOnce(teacher, [{ tool: 'find_students', input: { query: surname(zorawar) } }])
  const found = forModelOf<{ pupils: unknown[] }>(search.outputs[0], 'find_students')
  assert.deepEqual(found.pupils, [])
  assertNothingOf(toolResultsSeen(search), [zorawar], "the model's search result")

  // Their own class answers, so the refusals above are about the class.
  const own = await askOnce(teacher, [{ tool: 'section_attendance_day', input: { sectionId: sectionMine } }])
  const register = forModelOf<{ pupils: { studentId: string }[] }>(own.outputs[0], 'own register')
  assert.deepEqual(register.pupils.map((row) => row.studentId), [mira])
})

// ---------------------------------------------------------------------------
// 2. A parent, their own child and another family's child, across a promotion.

const lastMonth = (): string => lastDay.slice(0, 7)

/** The four records of last year a parent may ask about. */
const lastYearCalls = (pupilId: string): ScriptedCall[] => [
  { tool: 'student_fee_statement', input: { studentId: pupilId, academicYearId: lastYear } },
  { tool: 'student_attendance_month', input: { studentId: pupilId, month: lastMonth() } },
  { tool: 'student_results', input: { studentId: pupilId, academicYearId: lastYear } },
  { tool: 'student_report_cards', input: { studentId: pupilId, academicYearId: lastYear } },
]

/** The same records for this year, and the pupil's own record. */
const thisYearCalls = (pupilId: string): ScriptedCall[] => [
  { tool: 'student_record', input: { studentId: pupilId } },
  { tool: 'student_fee_statement', input: { studentId: pupilId } },
  { tool: 'student_attendance_month', input: { studentId: pupilId } },
  { tool: 'student_results', input: { studentId: pupilId } },
  { tool: 'student_report_cards', input: { studentId: pupilId } },
]

interface LastYear {
  receipts: string[]
  absentOn: string[]
  exams: string[]
  cards: number
}

/** What a parent read of last year, reduced to the rows that must survive a promotion. */
function lastYearRows(turn: Turn): LastYear {
  const [fees, month, results, cards] = turn.outputs
  return {
    receipts: forModelOf<{ recentReceipts: { id: string }[] }>(fees, 'fee statement').recentReceipts.map((receipt) => receipt.id),
    absentOn: forModelOf<{ absentOn: string[] }>(month, 'attendance month').absentOn,
    exams: forModelOf<{ exams: { examId: string }[] }>(results, 'results').exams.map((exam) => exam.examId).sort(),
    cards: forModelOf<{ cards: unknown[] }>(cards, 'report cards').cards.length,
  }
}

test("[assistant] a parent reads their own child's last year before and after the promotion, and never another family's child", async () => {
  const expected: LastYear = {
    receipts: [childLastReceipt],
    absentOn: [lastDay],
    exams: [lastPt1, lastHalfYearly].sort(),
    cards: 1,
  }
  const before = await askOnce(familyParent, lastYearCalls(child))
  assert.deepEqual(lastYearRows(before), expected)

  // The office promotes the class through the real route and closes the year.
  const promoted = await owner.fetch(
    `/api/schools/${school}/students/promote`,
    postBody({
      fromAcademicYearId: lastYear,
      toAcademicYearId: year,
      fromSectionId: lastSection,
      toSectionId: nextSection,
      studentIds: [child, stranger],
      detainedStudentIds: [],
      reason: 'Year end promotion',
    }),
  )
  assert.equal(promoted.status, 200, await promoted.clone().text())
  await adminPool().query(`UPDATE academic_years SET status = 'closed' WHERE id = $1`, [lastYear])

  // The boundary is the child, not the year: last year is still theirs.
  const afterPromotion = await askOnce(familyParent, lastYearCalls(child))
  assert.deepEqual(lastYearRows(afterPromotion), expected)

  // Another family's child sat the same class: nothing of theirs, in either year.
  const secrets = [surname(stranger), 'Veer', stranger]
  for (const calls of [lastYearCalls(stranger), thisYearCalls(stranger)]) {
    const turn = await askOnce(familyParent, calls)
    turn.outputs.forEach((output, index) =>
      assert.deepEqual(output, { status: 'not_available' }, `${calls[index]?.tool} about another family's child`),
    )
    assertNothingOf(JSON.stringify(turn.outputs), secrets, 'a tool output')
    assertNothingOf(toolResultsSeen(turn), secrets, "the model's tool results")
    assertNothingOf(turn.raw, [surname(stranger)], 'the stream')
  }
})

test('[assistant] the same tools about the parent’s own child answer ok this year', async () => {
  const turn = await askOnce(familyParent, thisYearCalls(child))
  const [record, fees, month, results, cards] = turn.outputs
  assert.equal(forModelOf<{ id: string }>(record, 'student_record').id, child)
  assert.equal(forModelOf<{ academicYearId: string }>(fees, 'student_fee_statement').academicYearId, year)
  assert.equal(forModelOf<{ studentId: string }>(month, 'student_attendance_month').studentId, child)
  assert.deepEqual(forModelOf<{ exams: unknown[] }>(results, 'student_results').exams, [])
  assert.deepEqual(forModelOf<{ cards: unknown[] }>(cards, 'student_report_cards').cards, [])
  // Every answer that used school data names where it came from.
  for (const output of turn.outputs) assert.ok(output.source?.href.startsWith('/'), 'an ok output without a source')
  assertNothingOf(JSON.stringify(turn.outputs), [stranger, surname(stranger)], 'an own-child output')
})

// ---------------------------------------------------------------------------
// 3. A pupil.

test('[assistant] a pupil reads their own record and attendance, and nothing about a classmate', async () => {
  const calls: ScriptedCall[] = [
    { tool: 'student_record', input: { studentId: pia } },
    { tool: 'student_attendance_month', input: { studentId: pia } },
    { tool: 'student_record', input: { studentId: kavya } },
    { tool: 'student_attendance_month', input: { studentId: kavya } },
    { tool: 'student_results', input: { studentId: kavya } },
    { tool: 'student_report_cards', input: { studentId: kavya } },
    { tool: 'student_enrolments', input: { studentId: kavya } },
  ]
  const turn = await askOnce(pupil, calls)
  assert.equal(forModelOf<{ id: string }>(turn.outputs[0], 'own record').id, pia)
  assert.equal(forModelOf<{ studentId: string }>(turn.outputs[1], 'own attendance').studentId, pia)
  turn.outputs.slice(2).forEach((output, index) =>
    assert.deepEqual(output, { status: 'not_available' }, `${calls[index + 2]?.tool} about a classmate`),
  )
  const secrets = [surname(kavya), 'Kavya', kavya]
  assertNothingOf(JSON.stringify(turn.outputs), secrets, 'a tool output')
  assertNothingOf(toolResultsSeen(turn), secrets, "the model's tool results")
  // A pupil holds no guardian key: their own record carries no guardian.
  assert.equal((turn.outputs[0]?.forModel as { guardians?: unknown }).guardians, undefined)
})

test('[assistant] a pupil is offered no fee, guardian or staff-register tool at all', async () => {
  // A pupil holds no guardian key, so no guardian tool is offered, not even
  // about themself; the route would leave their guardians out anyway.
  const turn = await askOnce(pupil, [{ tool: 'student_record', input: { studentId: pia } }], 'Hello')
  assert.equal(forModelOf<{ id: string }>(turn.outputs[0], 'own record').id, pia)

  const offered = new Set(turn.modelCalls.flatMap((call) => (call.tools ?? []).map((tool) => tool.name)))
  assert.ok(offered.has('student_record'), 'the pupil was offered no tools at all')
  const byName = new Map(READ_TOOLS.map((tool) => [tool.name, tool]))
  const unwanted = [...offered].filter((name) => {
    const tool = byName.get(name)
    return (
      tool === undefined ||
      tool.permission.startsWith('fees.') ||
      tool.permission.startsWith('staff_attendance.') ||
      tool.permission.startsWith('staff.') ||
      tool.name.includes('guardian')
    )
  })
  assert.deepEqual(unwanted, [])
})

// ---------------------------------------------------------------------------
// 4. Another school.

test("[assistant] another school's ids answer exactly like records that do not exist", async () => {
  const missing = randomUUID()
  const calls: ScriptedCall[] = [
    { tool: 'student_record', input: { studentId: studentA } },
    { tool: 'student_record', input: { studentId: missing } },
    { tool: 'student_fee_statement', input: { studentId: studentA } },
    { tool: 'student_attendance_month', input: { studentId: studentB } },
    { tool: 'section_attendance_day', input: { sectionId: sectionA } },
    { tool: 'section_attendance_day', input: { sectionId: missing } },
    { tool: 'section_timetable', input: { sectionId: sectionA } },
  ]
  // The owner holds every key there is in this school, and none in the other.
  const turn = await askOnce(owner, calls)
  turn.outputs.forEach((output, index) => assert.deepEqual(output, { status: 'not_available' }, calls[index]?.tool))
  assertNothingOf(toolResultsSeen(turn), ['Fixture'], "the model's tool results")

  // Underneath, the route answers another school's pupil and a made-up id alike.
  const theirs = await owner.fetch(`/api/schools/${school}/students/${studentA}`)
  const nobody = await owner.fetch(`/api/schools/${school}/students/${missing}`)
  assert.equal(theirs.status, nobody.status)
  assert.equal(await codeOf(theirs), await codeOf(nobody))
  // And the other school's own path is closed to this school's owner.
  assert.equal((await owner.fetch(`/api/schools/${schoolA}/assistant/status`)).status, 403)
})

// ---------------------------------------------------------------------------
// 5. Conversations are private.

test("[assistant] nobody, the owner included, can list, read, delete or ask in another member's conversation", async () => {
  const threadId = await newThread(teacher)
  await ask(teacher, threadId, 'Who is in my class?', { steps: [] })
  const missing = randomUUID()

  for (const other of [owner, familyParent, pupil]) {
    const list = await body<{ items: { id: string }[] }>(await other.fetch(assistant('/threads')))
    assert.ok(!list.items.some((item) => item.id === threadId), 'another member listed the conversation')

    for (const [method, init] of [
      ['GET', undefined],
      ['DELETE', { method: 'DELETE' }],
    ] as const) {
      const real = await other.fetch(assistant(`/threads/${threadId}`), init)
      const fake = await other.fetch(assistant(`/threads/${missing}`), init)
      assert.equal(real.status, fake.status, `${method} a real thread differs from a missing one`)
      assert.equal(await codeOf(real), 'RESOURCE_NOT_FOUND')
      assert.equal(await codeOf(fake), 'RESOURCE_NOT_FOUND')
    }
    const realTurn = await postTurn(other, threadId, 'What did they ask?')
    const fakeTurn = await postTurn(other, missing, 'What did they ask?')
    assert.equal(realTurn.status, fakeTurn.status)
    assert.equal(await codeOf(realTurn), 'RESOURCE_NOT_FOUND')
    assert.equal(await codeOf(fakeTurn), 'RESOURCE_NOT_FOUND')
  }

  // Nothing was added, removed or counted: the conversation is as its owner left it.
  const kept = await body<{ messages: { role: string }[] }>(await teacher.fetch(assistant(`/threads/${threadId}`)))
  assert.deepEqual(kept.messages.map((message) => message.role), ['user', 'assistant'])
  const stored = await adminPool().query<{ membership_id: string }>(
    'SELECT DISTINCT membership_id FROM assistant_messages WHERE thread_id = $1',
    [threadId],
  )
  assert.deepEqual(stored.rows.map((row) => row.membership_id), [teacherMembershipId])
})

// ---------------------------------------------------------------------------
// 6. The switches work on the next request.

test('[assistant] switching the school off refuses the very next turn', async () => {
  const threadId = await newThread(teacher)
  await ask(teacher, threadId, 'First question', { steps: [] })
  await switchSchool(false)
  try {
    const refused = await postTurn(teacher, threadId, 'Second question')
    assert.equal(await codeOf(refused), 'FEATURE_DISABLED')
    const status = await body<{ available: boolean; reason?: string }>(await teacher.fetch(assistant('/status')))
    assert.deepEqual([status.available, status.reason], [false, 'school_off'])
  } finally {
    await switchSchool(true)
  }
  await ask(teacher, threadId, 'Third question', { steps: [] })
})

test('[assistant] a restriction through the member access route refuses the very next turn', async () => {
  const subject = randomUUID()
  await adminPool().query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,'Science',$3,'scholastic')`, [
    subject,
    school,
    `S${suffix}`,
  ])
  const member = await createTeacher({ schoolId: school, academicYearId: year, sectionIds: [sectionMine], subjectId: subject, employeeCode: `AIS-R-${suffix}` })
  const client = await signInMember(server, member)
  const threadId = await newThread(client)
  await ask(client, threadId, 'First question', { steps: [] })

  const version = await adminPool().query<{ access_version: number }>('SELECT access_version FROM school_memberships WHERE id = $1', [
    member.membershipId,
  ])
  const restricted = await owner.fetch(
    `/api/schools/${school}/members/${member.membershipId}/restrictions`,
    postBody({ permission: 'ai_assistant.use', reason: 'Not for this member', expectedAccessVersion: Number(version.rows[0]?.access_version) }),
  )
  assert.equal(restricted.status, 201, await restricted.clone().text())
  assert.equal(await codeOf(await postTurn(client, threadId, 'Second question')), 'ACCESS_DENIED')
})

test('[assistant] a guardian withdrawing consent refuses the pupil’s very next turn', async () => {
  const threadId = await newThread(pupil)
  await ask(pupil, threadId, 'First question', { steps: [] })
  await recordConsent('withdrawn')
  try {
    assert.equal(await codeOf(await postTurn(pupil, threadId, 'Second question')), 'FEATURE_DISABLED')
    const status = await body<{ reason?: string }>(await pupil.fetch(assistant('/status')))
    assert.equal(status.reason, 'no_consent')
  } finally {
    await recordConsent('given')
  }
  await ask(pupil, threadId, 'Third question', { steps: [] })
})

test('[assistant] suspending a member stops their next tool call halfway through a turn, and their next turn', async () => {
  const member = await createTeacher({
    schoolId: school,
    academicYearId: year,
    sectionIds: [sectionMine],
    subjectId: maths,
    employeeCode: `AIS-S-${suffix}`,
  })
  const client = await signInMember(server, member)
  const threadId = await newThread(client)
  const read: ScriptedCall = { tool: 'student_record', input: { studentId: mira } }
  const turn = await ask(client, threadId, 'Look Mira up twice', {
    steps: [[read], [read]],
    // Between the two steps the owner suspends the member through the real route.
    beforeStep: async (step) => {
      if (step !== 1) return
      const suspended = await owner.fetch(
        `/api/schools/${school}/members/${member.membershipId}/suspend`,
        postBody({ expectedVersion: await versionOf(member.membershipId), reason: 'Under review' }),
      )
      assert.equal(suspended.status, 200, await suspended.clone().text())
    },
  })
  assert.equal(turn.outputs[0]?.status, 'ok')
  assert.deepEqual(turn.outputs[1], { status: 'not_available' })

  const refused = await postTurn(client, threadId, 'And again?')
  assert.equal(refused.status, 403, await refused.clone().text())
  assert.equal(await codeOf(refused), 'SCHOOL_ACCESS_UNAVAILABLE')
})

// ---------------------------------------------------------------------------
// 7 and 8. No words are kept, and every inner call is an ordinary read.

test('[assistant] the words of a question and an answer are kept only sealed, and each inner read is on the pupil’s record', async () => {
  const marker = `Qmarker${randomUUID().replace(/-/g, '')}`
  const since = await now()
  const threadId = await newThread(teacher)
  const turn = await ask(teacher, threadId, `How is Mira doing? ${marker}`, {
    steps: [[
      { tool: 'student_record', input: { studentId: mira } },
      // The model may put the question's words into a tool's input.
      { tool: 'find_students', input: { query: marker } },
    ]],
    answer: `Mira is in class 8B. ${marker}`,
  })
  assert.equal(turn.outputs[0]?.status, 'ok')
  assert.ok(turn.raw.includes(marker), 'the answer was streamed')

  const pool = adminPool()
  const like = `%${marker}%`
  const audit = await pool.query(
    `SELECT 1 FROM audit_events WHERE summary LIKE $1 OR safe_changes::text LIKE $1`,
    [like],
  )
  assert.equal(audit.rowCount, 0, 'an audit row holds the words')
  const notes = await pool.query('SELECT 1 FROM audit_event_notes WHERE note LIKE $1', [like])
  assert.equal(notes.rowCount, 0, 'an audit note holds the words')
  const access = await pool.query('SELECT 1 FROM access_log l WHERE l::text LIKE $1', [like])
  assert.equal(access.rowCount, 0, 'the request log holds the words')
  const usageRows = await pool.query('SELECT 1 FROM assistant_usage u WHERE u::text LIKE $1', [like])
  assert.equal(usageRows.rowCount, 0, 'a usage row holds the words')

  // Every table, not only the ones named: the words are nowhere in the clear.
  const tables = await pool.query<{ schema: string; name: string }>(
    `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
  )
  for (const table of tables.rows) {
    const found = await pool.query(
      `SELECT 1 FROM "${table.schema}"."${table.name}" t WHERE t::text LIKE $1 LIMIT 1`,
      [like],
    )
    assert.equal(found.rowCount, 0, `${table.schema}.${table.name} holds the words in the clear`)
  }

  // The kept conversation is sealed, and it opens to exactly the words.
  const key = server.config.DATA_ENCRYPTION_KEY
  const messages = await pool.query<{ role: string; content_sealed: string }>(
    'SELECT role, content_sealed FROM assistant_messages WHERE thread_id = $1 ORDER BY created_at',
    [threadId],
  )
  assert.deepEqual(messages.rows.map((row) => row.role), ['user', 'assistant'])
  for (const row of messages.rows) assert.ok(open(row.content_sealed, key).includes(marker))
  const title = await pool.query<{ title_sealed: string }>('SELECT title_sealed FROM assistant_threads WHERE id = $1', [threadId])
  assert.ok(open(title.rows[0]?.title_sealed as string, key).includes('How is Mira doing?'))

  // The turn's own audit row names the tools and counts, and no words.
  const turnRows = await pool.query<{ safe_changes: { tools: string[]; toolCalls: number } }>(
    `SELECT safe_changes FROM audit_events
      WHERE school_id = $1 AND actor_membership_id = $2 AND target_type = 'assistant_turn' AND created_at >= $3::timestamptz`,
    [school, teacherMembershipId, since],
  )
  assert.equal(turnRows.rowCount, 1)
  assert.deepEqual(turnRows.rows[0]?.safe_changes.tools, ['student_record', 'find_students'])

  // The record read through the assistant is on the pupil's record of who
  // opened it, as the teacher, exactly like a read from the screen.
  const reads = await pool.query<{ result: string; summary: string }>(
    `SELECT result, summary FROM audit_events
      WHERE school_id = $1 AND target_id = $2 AND action = 'students.read_basic'
        AND actor_membership_id = $3 AND created_at >= $4::timestamptz`,
    [school, mira, teacherMembershipId, since],
  )
  assert.equal(reads.rowCount, 1)
  assert.deepEqual(reads.rows[0], { result: 'allowed', summary: 'Opened the student record.' })
  const lines = await pool.query<{ route: string }>(
    `SELECT route FROM access_log WHERE membership_id = $1 AND at >= $2::timestamptz`,
    [teacherMembershipId, since],
  )
  const routes = lines.rows.map((row) => row.route)
  assert.ok(routes.includes('/api/schools/:schoolId/students/:studentId'), 'the inner read has no request log line')
  assert.ok(routes.includes('/api/schools/:schoolId/assistant/threads/:threadId/turns'))

  const exported = await body<{ accessHistory?: { action: string; actorDisplayName: string; outcome: string }[] }>(
    await owner.fetch(`/api/schools/${school}/students/${mira}/subject-access`),
  )
  assert.ok(
    exported.accessHistory?.some(
      (event) =>
        event.action === 'students.read_basic' &&
        event.outcome === 'allowed' &&
        event.actorDisplayName === 'Assistant Class Teacher',
    ),
    'the read is not in the pupil’s access history',
  )
})
