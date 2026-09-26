/**
 * Matrix rows: the assistant's change cards (Task 24b exit check).
 *
 * A change tool never writes. It reads through the same GET routes as the
 * person and the framework saves an editable, sealed proposal; only the
 * person's Confirm sends the one write, through the real route, as them. This
 * file proves that end to end with a scripted model (the AI SDK's mock model)
 * calling the real change tools from PROPOSE_TOOLS against the real routes.
 * The real model is never called; there is no key.
 *
 * It proves that a turn alone writes nothing; that a teacher can neither
 * propose for nor confirm into a class they do not teach; that parents,
 * pupils and an accountant are offered no change tool they hold no key for;
 * that a proposal is its owner's alone; that Confirm is the person's own
 * write with the route's own audit row; that a record someone else changed
 * is never overwritten; what the switches do to a Confirm made after them;
 * that titles, previews and the assistant's own rows name no pupil; and that
 * another school's ids read like missing records.
 *
 * The file builds a school of its own (and a second, bare one to be "another
 * school"), so switching the assistant on or off touches no other file's
 * school. Fixture school A is only ever asked about.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import {
  ROLE_TEMPLATES,
  type AssistantProposal,
  type AttendanceDayPreview,
  type CoScholasticPreview,
  type ExamMarksPreview,
} from '@erp/contracts'
import { fixtureIds } from '@erp/db/fixtures'
import { open } from '../../apps/api/src/modules/shared/crypto.ts'
import { PROPOSE_TOOLS } from '../../apps/api/src/assistant/proposals/registry.ts'
import { STALE_OUTCOME } from '../../apps/api/src/assistant/proposals/routes.ts'
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
const SCHOOL_CODE = `aip-sec-${suffix}`

const school = randomUUID()
const year = randomUUID()
const grade8 = randomUUID()
const grade9 = randomUUID()
/** 8 A: the teacher's own class. They are its class teacher and teach it Maths. */
const sectionMine = randomUUID()
/** 8 B: a class the teacher does not teach. */
const sectionOther = randomUUID()
const section9 = randomUUID()
const maths = randomUUID()

// Pupils. Every surname is one no other row in the database carries, so a
// surname found anywhere came from that pupil.
const mira = randomUUID()
const tara = randomUUID()
const zorawar = randomUUID()
const kiran = randomUUID()
const pia = randomUUID()
const NAMES: Record<string, [string, string]> = {
  [mira]: ['Mira', `Propmine${suffix}`],
  [tara]: ['Tara', `Propminetwo${suffix}`],
  [zorawar]: ['Zorawar', `Propother${suffix}`],
  [kiran]: ['Kiran', `Propothertwo${suffix}`],
  [pia]: ['Pia', `Proppupil${suffix}`],
}
const surname = (pupil: string): string => NAMES[pupil]![1]
const fullName = (pupil: string): string => NAMES[pupil]!.join(' ')
const PIA_ADMISSION = `AIPS/${suffix}/P`
const PUPIL_PASSWORD = 'Pupil-Pass!2026'

// Another school, with a class and a paper of its own.
const otherSchool = randomUUID()
const otherSchoolSection = randomUUID()
const otherSchoolPaper = randomUUID()
const OTHER_SCHOOL_NAME = `Elsewhere Proposal School ${suffix}`
const fixtureSection = fixtureIds.sectionA as string

let server: CustomServer
let owner: Client
let principal: Client
let accountant: Client
let teacher: Client
let otherTeacher: Client
let familyParent: Client
let pupilParent: Client
let pupil: Client
let teacherMembershipId = ''
let pupilGuardianId = ''
let today = ''
let minePaper = ''
let otherPaper = ''
const extraSurnames: string[] = []

// ---------------------------------------------------------------------------
// The scripted model.

interface ScriptedCall {
  readonly tool: string
  readonly input: Record<string, unknown>
}

/** What the model does in one turn: the tool calls of each step, in order, and then the answer. */
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
  modelId: 'security-proposals-script',
  doStream: async (options) => {
    const roles = options.prompt.map((message) => message.role)
    // Each finished step of this turn left one tool message after the question.
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

/** A change tool's output as the browser gets it. */
interface ProposeOutput {
  status: 'ok' | 'not_available' | 'invalid' | 'failed'
  proposal?: AssistantProposal
  problem?: string
  forModel?: unknown
}

interface Turn {
  raw: string
  outputs: ProposeOutput[]
  modelCalls: (typeof model.doStreamCalls)[number][]
}

const assistant = (rest: string) => `/api/schools/${school}/assistant${rest}`

async function newThread(client: Client): Promise<string> {
  const response = await client.fetch(assistant('/threads'), postBody({}))
  assert.equal(response.status, 201, await response.clone().text())
  return (await body<{ id: string }>(response)).id
}

async function ask(client: Client, threadId: string, text: string, next: Script): Promise<Turn> {
  script = next
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
    parts
      .filter((part) => part.type === 'tool-output-available')
      .map((part) => [part.toolCallId as string, part.output as ProposeOutput]),
  )
  const outputs: ProposeOutput[] = []
  next.steps.forEach((calls, step) =>
    calls.forEach((call, index) => {
      const output = byId.get(`${turnTag}-${step}-${index}`)
      assert.ok(output, `no output for ${call.tool} in step ${step}`)
      outputs.push(output)
    }),
  )
  return { raw, outputs, modelCalls: model.doStreamCalls.slice(seen) }
}

async function askOnce(client: Client, calls: readonly ScriptedCall[], text = 'Please prepare this.'): Promise<Turn> {
  return ask(client, await newThread(client), text, { steps: [calls] })
}

function proposalOf(output: ProposeOutput | undefined, label: string): AssistantProposal {
  assert.equal(output?.status, 'ok', `${label} answered ${JSON.stringify(output)}`)
  assert.ok(output?.proposal, `${label} has no proposal`)
  return output.proposal
}

/** The tool results the model was given, as text: what the model could read. */
function toolResultsSeen(turn: Turn): string {
  return JSON.stringify(turn.modelCalls.flatMap((call) => call.prompt.filter((message) => message.role === 'tool')))
}

/** The tool names the model was offered in a turn. */
function offered(turn: Turn): Set<string> {
  return new Set(turn.modelCalls.flatMap((call) => (call.tools ?? []).map((entry) => entry.name)))
}

function assertNothingOf(text: string, secrets: readonly string[], label: string): void {
  for (const secret of secrets) assert.ok(!text.includes(secret), `${label} holds ${secret}`)
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
  membership_id: string
  write_request_id: string | null
  outcome: string | null
}

async function proposalRow(proposalId: string): Promise<ProposalRow> {
  const found = await adminPool().query<ProposalRow>(
    'SELECT status, membership_id, write_request_id, outcome FROM assistant_proposals WHERE id = $1',
    [proposalId],
  )
  const row = found.rows[0]
  assert.ok(row, 'the proposal row exists')
  return row
}

/** Asserts a proposal is still open and has written nothing. */
async function assertUnwritten(proposalId: string, label: string): Promise<void> {
  const row = await proposalRow(proposalId)
  assert.equal(row.status, 'open', `${label}: the proposal is ${row.status}`)
  assert.equal(row.write_request_id, null, `${label}: the proposal names a write`)
}

/** How many rows this school holds in each table a change tool could write. */
async function writtenRows(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const table of ['attendance_entries', 'staff_attendance_entries', 'exam_marks', 'report_card_entries']) {
    const found = await adminPool().query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table} WHERE school_id = $1`, [school])
    counts[table] = Number(found.rows[0]?.count)
  }
  return counts
}

async function attendanceRowsIn(sectionId: string): Promise<number> {
  const found = await adminPool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM attendance_entries WHERE school_id = $1 AND section_id = $2',
    [school, sectionId],
  )
  return Number(found.rows[0]?.count)
}

interface AuditRow {
  action: string
  target_type: string
  actor_membership_id: string | null
  request_id: string
  result: string
}

async function auditSince(since: string): Promise<AuditRow[]> {
  const found = await adminPool().query<AuditRow>(
    `SELECT action, target_type, actor_membership_id, request_id, result FROM audit_events
      WHERE school_id = $1 AND created_at >= $2::timestamptz ORDER BY created_at`,
    [school, since],
  )
  return found.rows
}

/** The database clock, so "since" never depends on this process's clock. */
async function now(): Promise<string> {
  const found = await adminPool().query<{ at: string }>('SELECT now()::text AS at')
  return found.rows[0]?.at as string
}

async function markOn(sectionId: string, date: string, studentId: string): Promise<string | undefined> {
  const response = await owner.fetch(`/api/schools/${school}/attendance/sections/${sectionId}/days/${date}`)
  assert.equal(response.status, 200, await response.clone().text())
  const day = await body<{ rows: { student: { id: string }; mark?: string | null }[] }>(response)
  return day.rows.find((row) => row.student.id === studentId)?.mark ?? undefined
}

interface Sheet {
  rows: { student: { id: string }; cells: { component: string; value: unknown }[] }[]
}

async function sheetOf(paperId: string): Promise<Sheet> {
  const response = await owner.fetch(`/api/schools/${school}/exams/papers/${paperId}`)
  assert.equal(response.status, 200, await response.clone().text())
  return body<Sheet>(response)
}

const cellOf = (sheet: Sheet, studentId: string, component: string): unknown =>
  sheet.rows.find((row) => row.student.id === studentId)?.cells.find((cell) => cell.component === component)?.value ?? null

// ---------------------------------------------------------------------------
// Set-up helpers.

function shift(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`)
  moment.setUTCDate(moment.getUTCDate() + days)
  return moment.toISOString().slice(0, 10)
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
      dailyQuestionsStaff: 500,
      dailyQuestionsFamily: current.dailyQuestionsFamily,
      monthlyQuestions: current.monthlyQuestions,
      expectedVersion: current.version,
    }),
  )
  assert.equal(saved.status, 200, await saved.clone().text())
}

async function recordConsent(): Promise<void> {
  const response = await pupilParent.fetch(
    `/api/schools/${school}/students/${pia}/consents`,
    postBody({ guardianId: pupilGuardianId, purpose: 'ai_assistant', status: 'given', method: 'portal' }),
  )
  assert.equal(response.status, 200, await response.clone().text())
}

/** A pupil login with its own session, as /api/student-sign-in makes one. */
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
  const response = await client.fetch('/api/student-sign-in', postBody({ schoolCode: SCHOOL_CODE, admissionNumber, password: PUPIL_PASSWORD }))
  assert.equal(response.status, 200, await response.text())
  return client
}

async function addPupil(pupilId: string, first: string, last: string, sectionId: string, roll: number, admission: string): Promise<void> {
  const pool = adminPool()
  await pool.query(
    `INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,$4,$5,'active')`,
    [pupilId, school, admission, first, last],
  )
  await pool.query(
    `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,roll_number,joined_on) VALUES ($1,$2,$3,$4,$5,$6)`,
    [school, pupilId, year, sectionId, roll, shift(today, -100)],
  )
}

interface ClassTeacher {
  client: Client
  membershipId: string
  sectionId: string
  pupils: string[]
}

/** A fresh teacher with a class of their own (one more 8th section, two pupils), signed in. */
async function classTeacher(sectionName: string): Promise<ClassTeacher> {
  const pool = adminPool()
  const staffId = randomUUID()
  const sectionId = randomUUID()
  await pool.query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status,joining_date)
     VALUES ($1,$2,$3,'Switch Teacher','teaching','Teacher','active',$4)`,
    [staffId, school, `AIPS-${sectionName}-${suffix}`, shift(today, -100)],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [sectionId, school, year, grade8, sectionName, staffId],
  )
  const pupils = [randomUUID(), randomUUID()]
  for (const [index, pupilId] of pupils.entries()) {
    const last = `Switch${sectionName}${index}${suffix}`
    extraSurnames.push(last)
    await addPupil(pupilId, index === 0 ? 'Asha' : 'Bela', last, sectionId, index + 1, `AIPS/${suffix}/${sectionName}${index}`)
  }
  const member = await createMember(school, ['teacher'], `Switch Teacher ${sectionName}`)
  await pool.query('INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)', [
    school,
    member.membershipId,
    staffId,
  ])
  return { client: await signInMember(server, member), membershipId: member.membershipId, sectionId, pupils }
}

/** One open register proposal of a class teacher's own class: everyone present but Asha. */
async function openRegisterProposal(who: ClassTeacher): Promise<AssistantProposal> {
  const turn = await askOnce(who.client, [
    { tool: 'propose_attendance_day', input: { section: who.sectionId, everyone: 'present', except: [{ pupil: 'Asha', mark: 'absent' }] } },
  ])
  const proposal = proposalOf(turn.outputs[0], 'own register')
  assert.equal(proposal.status, 'open')
  return proposal
}

async function paperIn(sectionId: string): Promise<string> {
  const response = await owner.fetch(`/api/schools/${school}/exams/papers?academicYearId=${year}`)
  assert.equal(response.status, 200, await response.clone().text())
  const listed = await body<{ items: { id: string; section: { id: string }; subject: { id: string } }[] }>(response)
  const paper = listed.items.find((item) => item.section.id === sectionId && item.subject.id === maths)
  assert.ok(paper, 'the paper was not created')
  return paper.id
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,'AIPS')`, [
    school,
    SCHOOL_CODE,
    `Assistant Proposals Security School ${suffix}`,
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

  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status) VALUES ($1,$2,$3,$4,$5,'current')`,
    [year, school, `AIPS-${suffix}`, shift(today, -100), shift(today, 200)],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [school, year])
  await pool.query(
    `INSERT INTO grades(id,school_id,name,short_name,sort_order,level) VALUES ($1,$3,'Class 8','8',8,8),($2,$3,'Class 9','9',9,9)`,
    [grade8, grade9, school],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$4,$5,$6,'A'),($2,$4,$5,$6,'B'),($3,$4,$5,$7,'A')`,
    [sectionMine, sectionOther, section9, school, year, grade8, grade9],
  )
  await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,'Maths',$3,'scholastic')`, [maths, school, `M${suffix}`])
  await pool.query(`INSERT INTO grade_subjects(school_id,grade_id,academic_year_id,subject_id) VALUES ($1,$2,$3,$4)`, [
    school,
    grade8,
    year,
    maths,
  ])
  const rolls: [string, string, number][] = [
    [mira, sectionMine, 1],
    [tara, sectionMine, 2],
    [zorawar, sectionOther, 1],
    [kiran, sectionOther, 2],
    [pia, section9, 1],
  ]
  for (const [pupilId, sectionId, roll] of rolls) {
    const [first, last] = NAMES[pupilId]!
    await addPupil(pupilId, first, last, sectionId, roll, pupilId === pia ? PIA_ADMISSION : `AIPS/${suffix}/${first}`)
  }

  // Another school with a class and a paper, written straight into its own rows.
  const otherYear = randomUUID()
  const otherGrade = randomUUID()
  const otherSubject = randomUUID()
  const otherExam = randomUUID()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,'EPS')`, [
    otherSchool,
    `aip-else-${suffix}`,
    OTHER_SCHOOL_NAME,
  ])
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status) VALUES ($1,$2,$3,$4,$5,'current')`,
    [otherYear, otherSchool, `EPS-${suffix}`, shift(today, -100), shift(today, 200)],
  )
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order,level) VALUES ($1,$2,'Class 8','8',8,8)`, [
    otherGrade,
    otherSchool,
  ])
  await pool.query(`INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,'A')`, [
    otherSchoolSection,
    otherSchool,
    otherYear,
    otherGrade,
  ])
  await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,'Maths',$3,'scholastic')`, [
    otherSubject,
    otherSchool,
    `EM${suffix}`,
  ])
  await pool.query(
    `INSERT INTO exams(id,school_id,academic_year_id,kind,starts_on,ends_on,recheck_deadline) VALUES ($1,$2,$3,'half_yearly',$4,$5,$6)`,
    [otherExam, otherSchool, otherYear, shift(today, -2), shift(today, -1), shift(today, 5)],
  )
  await pool.query(
    `INSERT INTO exam_papers(id,school_id,exam_id,academic_year_id,section_id,subject_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [otherSchoolPaper, otherSchool, otherExam, otherYear, otherSchoolSection, otherSubject],
  )

  server = await startServerWith({
    env: { ASSISTANT_ENABLED: 'true', AI_GATEWAY_API_KEY: 'test-only-never-used' },
    // The scripted model only: the read and change tools are the real registries'.
    assistant: { assistantModel: model },
  })

  const ownerMember = await createMember(school, ['owner'], 'Proposals Owner')
  owner = await signInOffice(server, ownerMember)
  principal = await signInOffice(server, await createMember(school, ['principal'], 'Proposals Principal'))
  accountant = await signInOffice(server, await createMember(school, ['accountant'], 'Proposals Accountant'))

  // The teacher teaches 8 A Maths and is its class teacher.
  const teacherMember = await createTeacher({
    schoolId: school,
    academicYearId: year,
    sectionIds: [sectionMine],
    subjectId: maths,
    employeeCode: `AIPS-T-${suffix}`,
  })
  teacherMembershipId = teacherMember.membershipId
  await pool.query('UPDATE sections SET class_teacher_staff_id = $2 WHERE id = $1', [sectionMine, teacherMember.staffId])
  teacher = await signInMember(server, teacherMember)

  // Another teacher, who teaches and is class teacher of 8 B.
  const otherMember = await createTeacher({
    schoolId: school,
    academicYearId: year,
    sectionIds: [sectionOther],
    subjectId: maths,
    employeeCode: `AIPS-O-${suffix}`,
  })
  await pool.query('UPDATE sections SET class_teacher_staff_id = $2 WHERE id = $1', [sectionOther, otherMember.staffId])
  otherTeacher = await signInMember(server, otherMember)

  const familyMember = await createMember(school, ['parent'], 'Proposals Family Parent')
  await grantPortalAccess({ schoolId: school, membershipId: familyMember.membershipId, studentId: mira, approvedBy: ownerMember.membershipId })
  familyParent = await signInMember(server, familyMember)

  const pupilParentMember = await createMember(school, ['parent'], 'Proposals Pupil Parent')
  pupilGuardianId = (
    await grantPortalAccess({ schoolId: school, membershipId: pupilParentMember.membershipId, studentId: pia, approvedBy: ownerMember.membershipId })
  ).guardianId
  pupilParent = await signInMember(server, pupilParentMember)
  pupil = await pupilLogin(pia, PIA_ADMISSION)

  // The school switches the assistant on, and Pia's guardian agrees.
  await switchSchool(true)
  await recordConsent()

  const listed = await body<{ date: string; day: { kind: string } }>(await owner.fetch(`/api/schools/${school}/attendance/sections`))
  assert.equal(listed.date, today)
  assert.equal(listed.day.kind, 'school_day', 'this suite needs today to be a school day')

  // One half-yearly exam, still open to the teacher: a Maths paper in every 8th section.
  const exam = await owner.fetch(
    `/api/schools/${school}/exams`,
    postBody({ academicYearId: year, kind: 'half_yearly', startsOn: shift(today, -2), endsOn: shift(today, -1), recheckDeadline: shift(today, 5) }),
  )
  assert.equal(exam.status, 201, await exam.clone().text())
  minePaper = await paperIn(sectionMine)
  otherPaper = await paperIn(sectionOther)
})

after(async () => {
  await server?.close()
  await closeAdminPool()
})

// ---------------------------------------------------------------------------
// 1. A turn alone never writes.

/** The three changes the teacher may propose for their own class. */
const ownClassCalls = (): ScriptedCall[] => [
  { tool: 'propose_attendance_day', input: { section: '8A', everyone: 'present', except: [{ pupil: 'Tara', mark: 'absent' }] } },
  {
    tool: 'propose_exam_marks',
    input: {
      exam: 'half-yearly',
      subject: 'Maths',
      section: '8A',
      marks: [
        { pupil: 'Mira', value: 62 },
        { pupil: 'Tara', value: 'absent' },
      ],
    },
  },
  {
    tool: 'propose_co_scholastic',
    input: {
      section: '8A',
      card: 'term_1',
      grades: [{ pupil: 'Mira', area: 'discipline', grade: 'A' }],
      remarks: [{ pupil: 'Tara', text: 'Kind to everyone in class.' }],
    },
  },
]

let teacherThread = ''
let registerProposal: AssistantProposal
let marksProposal: AssistantProposal
let gradesProposal: AssistantProposal

test('[proposals] a turn that proposes a register, marks and co-scholastic grades writes nothing, and each proposal is open', async () => {
  const before = await writtenRows()
  teacherThread = await newThread(teacher)
  const turn = await ask(teacher, teacherThread, 'Mark my class, enter the marks and the grades.', { steps: [ownClassCalls()] })
  registerProposal = proposalOf(turn.outputs[0], 'register')
  marksProposal = proposalOf(turn.outputs[1], 'marks')
  gradesProposal = proposalOf(turn.outputs[2], 'co-scholastic')
  assert.deepEqual(
    [registerProposal, marksProposal, gradesProposal].map((proposal) => [proposal.kind, proposal.status]),
    [
      ['attendance_day', 'open'],
      ['exam_marks', 'open'],
      ['co_scholastic', 'open'],
    ],
  )
  // The previews carry what the teacher asked for.
  const register = registerProposal.preview as AttendanceDayPreview
  assert.deepEqual(register.rows.map((row) => [row.studentId, row.proposed]), [
    [mira, 'present'],
    [tara, 'absent'],
  ])
  assert.equal((marksProposal.preview as ExamMarksPreview).paperId, minePaper)
  assert.equal((gradesProposal.preview as CoScholasticPreview).sectionId, sectionMine)

  // Not one row was written in any table a change tool could write.
  assert.deepEqual(await writtenRows(), before)
  for (const proposal of [registerProposal, marksProposal, gradesProposal]) {
    await assertUnwritten(proposal.id, proposal.kind)
    assert.equal((await proposalRow(proposal.id)).membership_id, teacherMembershipId)
  }
  // And the screens agree: the register is not marked and the sheet is empty.
  assert.equal(await markOn(sectionMine, today, tara), undefined)
  assert.equal(cellOf(await sheetOf(minePaper), mira, 'written'), null)
})

// ---------------------------------------------------------------------------
// 2. A teacher and a class they do not teach.

/** The same three changes for 8 B, by id and by name. */
const otherClassCalls = (): ScriptedCall[] => [
  { tool: 'propose_attendance_day', input: { section: sectionOther, everyone: 'present', except: [{ pupil: 'Zorawar', mark: 'absent' }] } },
  { tool: 'propose_attendance_day', input: { section: '8B', everyone: 'present', except: [{ pupil: 'Zorawar', mark: 'absent' }] } },
  { tool: 'propose_exam_marks', input: { paper: otherPaper, marks: [{ pupil: 'Zorawar', value: 40 }] } },
  { tool: 'propose_exam_marks', input: { exam: 'half-yearly', subject: 'Maths', section: '8B', marks: [{ pupil: 'Zorawar', value: 40 }] } },
  { tool: 'propose_co_scholastic', input: { section: sectionOther, card: 'term_1', grades: [{ pupil: 'Zorawar', area: 'discipline', grade: 'C' }] } },
  { tool: 'propose_co_scholastic', input: { section: '8B', card: 'term_1', grades: [{ pupil: 'Zorawar', area: 'discipline', grade: 'C' }] } },
]

test('[proposals] a teacher proposing for a class they do not teach gets not available or a problem, naming nobody in it', async () => {
  // The same calls from the class's own teacher prepare real proposals, so
  // every one of them names a real class the first teacher is kept from.
  const control = await askOnce(otherTeacher, otherClassCalls())
  control.outputs.forEach((output, index) => proposalOf(output, `8 B's teacher: ${otherClassCalls()[index]?.tool}`))
  assert.ok(JSON.stringify(control.outputs).includes(surname(zorawar)))

  const threadId = await newThread(teacher)
  const turn = await ask(teacher, threadId, 'Mark 8B, enter their marks and grades.', { steps: [otherClassCalls()] })
  turn.outputs.forEach((output, index) => {
    const tool = otherClassCalls()[index]?.tool
    assert.ok(output.status === 'not_available' || output.status === 'invalid', `${tool} answered ${output.status}`)
    assert.equal(output.proposal, undefined, `${tool} made a proposal`)
  })
  // Given by id, each is refused exactly like a missing record.
  for (const index of [0, 2, 4]) assert.deepEqual(turn.outputs[index], { status: 'not_available' })

  const secrets = [surname(zorawar), surname(kiran), 'Kiran', zorawar, kiran]
  assertNothingOf(JSON.stringify(turn.outputs), [...secrets, sectionOther, otherPaper], 'a tool output')
  assertNothingOf(toolResultsSeen(turn), [...secrets, sectionOther, otherPaper], "the model's tool results")
  assertNothingOf(turn.raw, secrets, 'the stream')
  const saved = await adminPool().query('SELECT 1 FROM assistant_proposals WHERE thread_id = $1', [threadId])
  assert.equal(saved.rowCount, 0, 'a proposal was saved for another class')
})

test('[proposals] a confirm whose preview was swapped to another class is refused before any write', async () => {
  const since = await now()
  const before = await writtenRows()
  const others = [zorawar, kiran]
  const register = registerProposal.preview as AttendanceDayPreview
  const marks = marksProposal.preview as ExamMarksPreview
  const grades = gradesProposal.preview as CoScholasticPreview

  const attempts: [AssistantProposal, unknown][] = [
    // The whole class swapped: another section, its pupils in the rows.
    [
      registerProposal,
      {
        ...register,
        sectionId: sectionOther,
        sectionName: 'Class 8 B',
        rows: register.rows.map((row, index) => ({ ...row, studentId: others[index], name: fullName(others[index]!) })),
      },
    ],
    [registerProposal, { ...register, sectionId: sectionOther }],
    [registerProposal, { ...register, rows: register.rows.map((row, index) => ({ ...row, studentId: others[index] })) }],
    [
      marksProposal,
      {
        ...marks,
        paperId: otherPaper,
        rows: marks.rows.map((row, index) => ({ ...row, studentId: others[index], name: fullName(others[index]!) })),
      },
    ],
    [marksProposal, { ...marks, paperId: otherPaper }],
    [
      gradesProposal,
      {
        ...grades,
        sectionId: sectionOther,
        rows: grades.rows.map((row, index) => ({ ...row, studentId: others[index], name: fullName(others[index]!) })),
      },
    ],
    [gradesProposal, { ...grades, sectionId: sectionOther }],
  ]
  for (const [proposal, preview] of attempts) {
    const response = await confirm(teacher, proposal.id, preview)
    assert.equal(response.status, 400, `${proposal.kind}: ${await response.clone().text()}`)
    assert.equal(await codeOf(response), 'INVALID_REQUEST')
  }

  assert.deepEqual(await writtenRows(), before)
  for (const proposal of [registerProposal, marksProposal, gradesProposal]) await assertUnwritten(proposal.id, proposal.kind)
  // Nothing was attempted as the teacher: no write route ran, allowed or refused.
  assert.deepEqual(await auditSince(since), [])
})

// ---------------------------------------------------------------------------
// 3. Who is offered a change tool at all.

test('[proposals] parents and pupils are offered no change tool, an accountant none of these four', async () => {
  const offeredTo = async (client: Client): Promise<Set<string>> => offered(await askOnce(client, [], 'Hello'))
  const changeTools = (names: Set<string>) => [...names].filter((name) => name.startsWith('propose_')).sort()

  for (const [label, client] of [
    ['a parent', familyParent],
    ['a pupil', pupil],
  ] as const) {
    const names = await offeredTo(client)
    assert.ok(names.has('student_record'), `${label} was offered no tools at all`)
    assert.deepEqual(changeTools(names), [], `${label} was offered a change tool`)
  }

  const accountantNames = await offeredTo(accountant)
  assert.ok(accountantNames.size > 0, 'the accountant was offered no tools at all')
  assert.deepEqual(changeTools(accountantNames), [], 'the accountant was offered a change tool')
  for (const definition of PROPOSE_TOOLS) assert.ok(!accountantNames.has(definition.name), definition.name)

  // A teacher gets exactly the three their keys allow, the owner all four.
  assert.deepEqual(changeTools(await offeredTo(teacher)), ['propose_attendance_day', 'propose_co_scholastic', 'propose_exam_marks'])
  assert.deepEqual(changeTools(await offeredTo(owner)), PROPOSE_TOOLS.map((definition) => definition.name).sort())
})

// ---------------------------------------------------------------------------
// 4. A proposal is its owner's alone.

test("[proposals] nobody else, the owner and a principal included, can read, confirm or dismiss a teacher's proposal", async () => {
  const before = await writtenRows()
  const missing = randomUUID()
  for (const [label, other] of [
    ['the owner', owner],
    ['a principal', principal],
    ["8 B's teacher", otherTeacher],
    ['a parent', familyParent],
  ] as const) {
    const states = await other.fetch(assistant(`/threads/${teacherThread}/proposals`))
    const noThread = await other.fetch(assistant(`/threads/${missing}/proposals`))
    assert.equal(states.status, noThread.status, `${label}: a real thread differs from a missing one`)
    assert.equal(await codeOf(states), 'RESOURCE_NOT_FOUND', label)
    assert.equal(await codeOf(noThread), 'RESOURCE_NOT_FOUND', label)

    for (const proposal of [registerProposal, marksProposal, gradesProposal]) {
      const confirmOther = await confirm(other, proposal.id, proposal.preview)
      const confirmMissing = await confirm(other, missing, proposal.preview)
      assert.equal(confirmOther.status, confirmMissing.status, `${label}: confirm differs from a missing proposal`)
      assert.equal(await codeOf(confirmOther), 'RESOURCE_NOT_FOUND', `${label} confirming ${proposal.kind}`)
      assert.equal(await codeOf(confirmMissing), 'RESOURCE_NOT_FOUND')
      assert.equal(await codeOf(await dismiss(other, proposal.id)), 'RESOURCE_NOT_FOUND', `${label} dismissing ${proposal.kind}`)
    }
  }
  assert.deepEqual(await writtenRows(), before)
  for (const proposal of [registerProposal, marksProposal, gradesProposal]) await assertUnwritten(proposal.id, proposal.kind)

  // The teacher still sees all three, open. They were made in one step, so
  // they share a time and come back in id order.
  const own = await body<{ items: AssistantProposal[] }>(await teacher.fetch(assistant(`/threads/${teacherThread}/proposals`)))
  assert.deepEqual(
    own.items.map((item) => `${item.id} ${item.status}`).sort(),
    [registerProposal, marksProposal, gradesProposal].map((proposal) => `${proposal.id} open`).sort(),
  )
})

// ---------------------------------------------------------------------------
// 5. Confirm is the person's own write.

test("[proposals] confirming is the teacher's own write: the route's one audit row names the teacher and carries the proposal's request id", async () => {
  for (const proposal of [registerProposal, marksProposal, gradesProposal]) {
    const since = await now()
    const done = await confirmed(teacher, proposal)
    assert.equal(done.status, 'done', `${proposal.kind}: ${done.outcome}`)
    const stored = await proposalRow(proposal.id)
    assert.ok(stored.write_request_id, `${proposal.kind} kept no request id`)

    // Exactly one audit row: the write route's, as the teacher. The
    // assistant wrote none of its own for it.
    const rows = await auditSince(since)
    assert.equal(rows.length, 1, `${proposal.kind}: ${JSON.stringify(rows)}`)
    const [row] = rows
    assert.equal(row?.actor_membership_id, teacherMembershipId)
    assert.equal(row?.result, 'allowed')
    assert.equal(row?.request_id, stored.write_request_id)
    assert.ok(!row?.action.startsWith('ai_assistant'), `${proposal.kind}: the audit row is the assistant's`)
    assert.ok(!row?.target_type.startsWith('assistant'), `${proposal.kind}: the audit row is the assistant's`)

    // The request log has the inner write as the teacher, under the same id.
    const lines = await adminPool().query<{ method: string; route: string; membership_id: string }>(
      'SELECT method, route, membership_id FROM access_log WHERE request_id = $1',
      [stored.write_request_id],
    )
    assert.equal(lines.rowCount, 1)
    assert.equal(lines.rows[0]?.membership_id, teacherMembershipId)
    assert.ok(['PUT', 'POST'].includes(lines.rows[0]?.method as string))
    assert.ok(!lines.rows[0]?.route.includes('/assistant/'), 'the write was logged as the assistant route')
  }

  // What the cards said is what the screens now show.
  assert.equal(await markOn(sectionMine, today, tara), 'absent')
  assert.equal(await markOn(sectionMine, today, mira), 'present')
  const sheet = await sheetOf(minePaper)
  assert.equal(cellOf(sheet, mira, 'written'), 62)
  assert.equal(cellOf(sheet, tara, 'written'), 'absent')
  const entries = await body<{ rows: { student: { id: string }; entry: { grades: Record<string, string | null>; remarks: string | null } | null }[] }>(
    await owner.fetch(`/api/schools/${school}/report-cards/sections/${sectionMine}/terms/term_1/entries`),
  )
  assert.equal(entries.rows.find((row) => row.student.id === mira)?.entry?.grades.discipline, 'A')
  assert.equal(entries.rows.find((row) => row.student.id === tara)?.entry?.remarks, 'Kind to everyone in class.')
})

// ---------------------------------------------------------------------------
// 6. Somebody else's change in between.

test('[proposals] a register or a marks sheet someone else changed after the proposal is stale, and nothing is written', async () => {
  const turn = await askOnce(teacher, [
    { tool: 'propose_attendance_day', input: { section: '8A', except: [{ pupil: 'Mira', mark: 'late' }] } },
    { tool: 'propose_exam_marks', input: { paper: minePaper, component: 'notebook', marks: [{ pupil: 'Mira', value: 4 }] } },
  ])
  const register = proposalOf(turn.outputs[0], 'register')
  const marks = proposalOf(turn.outputs[1], 'marks')
  assert.equal((marks.preview as ExamMarksPreview).mode, 'first_entry')

  // The owner changes both on the screens in between.
  const marked = await owner.fetch(
    `/api/schools/${school}/attendance/sections/${sectionMine}/days/${today}`,
    putBody({ marks: [{ studentId: mira, mark: 'present' }, { studentId: tara, mark: 'leave' }] }),
  )
  assert.equal(marked.status, 200, await marked.clone().text())
  const sheet = await sheetOf(minePaper)
  const entries = sheet.rows.flatMap((row) =>
    row.cells.filter((cell) => cell.value !== null && cell.value !== undefined).map((cell) => ({ studentId: row.student.id, component: cell.component, value: cell.value })),
  )
  const saved = await owner.fetch(
    `/api/schools/${school}/exams/papers/${minePaper}/marks`,
    putBody({ entries: [...entries, { studentId: tara, component: 'notebook', value: 3 }] }),
  )
  assert.equal(saved.status, 200, await saved.clone().text())

  const since = await now()
  for (const proposal of [register, marks]) {
    const stale = await confirmed(teacher, proposal)
    assert.equal(stale.status, 'stale', `${proposal.kind}: ${stale.outcome}`)
    assert.equal(stale.outcome, STALE_OUTCOME)
    assert.equal((await proposalRow(proposal.id)).write_request_id, null)
  }
  // The owner's changes stand, and the teacher's never reached a write route.
  assert.equal(await markOn(sectionMine, today, mira), 'present')
  assert.equal(await markOn(sectionMine, today, tara), 'leave')
  const after = await sheetOf(minePaper)
  assert.equal(cellOf(after, mira, 'notebook'), null)
  assert.equal(cellOf(after, tara, 'notebook'), 3)
  assert.deepEqual(await auditSince(since), [])
})

// ---------------------------------------------------------------------------
// 7. The switches reach Confirm.

/**
 * Found by this suite while 24b was built: confirm checked ai_assistant.use at
 * the route gate and nothing else, so a proposal made before the school
 * switched the assistant off was still written. Confirm now reads the same
 * switches as a question (service, school, a pupil's consent) and refuses.
 */
test(
  '[proposals] switching the school off after a proposal refuses its confirm, and nothing is written',
  async () => {
    const who = await classTeacher('C')
    const proposal = await openRegisterProposal(who)
    await switchSchool(false)
    try {
      const response = await confirm(who.client, proposal.id, proposal.preview)
      const text = await response.clone().text()
      const written = await attendanceRowsIn(who.sectionId)
      const row = await proposalRow(proposal.id)
      assert.equal(written, 0, `the register was written with the assistant off (${response.status} ${text}; proposal ${row.status})`)
      assert.ok(response.status >= 400, `confirm answered ${response.status} ${text}`)
      assert.equal(await codeOf(response), 'FEATURE_DISABLED')
      assert.equal(row.write_request_id, null)
    } finally {
      await switchSchool(true)
    }
  },
)

test('[proposals] restricting the person after a proposal refuses its confirm on the next request, and nothing is written', async () => {
  const who = await classTeacher('D')
  const proposal = await openRegisterProposal(who)
  const version = await adminPool().query<{ access_version: number }>('SELECT access_version FROM school_memberships WHERE id = $1', [
    who.membershipId,
  ])
  const restricted = await owner.fetch(
    `/api/schools/${school}/members/${who.membershipId}/restrictions`,
    postBody({ permission: 'ai_assistant.use', reason: 'Not for this member', expectedAccessVersion: Number(version.rows[0]?.access_version) }),
  )
  assert.equal(restricted.status, 201, await restricted.clone().text())

  const response = await confirm(who.client, proposal.id, proposal.preview)
  assert.equal(response.status, 403, await response.clone().text())
  assert.equal(await codeOf(response), 'ACCESS_DENIED')
  assert.equal(await codeOf(await dismiss(who.client, proposal.id)), 'ACCESS_DENIED')
  assert.equal(await attendanceRowsIn(who.sectionId), 0)
  await assertUnwritten(proposal.id, 'restricted')
})

test('[proposals] suspending the person after a proposal refuses its confirm on the next request, and nothing is written', async () => {
  const who = await classTeacher('E')
  const proposal = await openRegisterProposal(who)
  const suspended = await owner.fetch(
    `/api/schools/${school}/members/${who.membershipId}/suspend`,
    postBody({ expectedVersion: await versionOf(who.membershipId), reason: 'Under review' }),
  )
  assert.equal(suspended.status, 200, await suspended.clone().text())

  const response = await confirm(who.client, proposal.id, proposal.preview)
  assert.equal(response.status, 403, await response.clone().text())
  assert.equal(await codeOf(response), 'SCHOOL_ACCESS_UNAVAILABLE')
  assert.equal(await attendanceRowsIn(who.sectionId), 0)
  await assertUnwritten(proposal.id, 'suspended')
})

/**
 * A proposal left confirming by a crash is settled by the next person to look
 * at it. That must be its owner: to anyone else the states route, confirm and
 * dismiss answer exactly as for a missing proposal, and settle nothing.
 */
test("[proposals] nobody else can read or settle someone's confirming proposal: it is not found, and stays as it was", async () => {
  const who = await classTeacher('F')
  const threadId = await newThread(who.client)
  const turn = await ask(who.client, threadId, 'Mark my class.', {
    steps: [[{ tool: 'propose_attendance_day', input: { section: who.sectionId, everyone: 'present', except: [{ pupil: 'Asha', mark: 'absent' }] } }]],
  })
  const proposal = proposalOf(turn.outputs[0], 'own register')
  // Confirming for longer than the lease, waiting on a write that never happened.
  const operation = randomUUID()
  await adminPool().query(
    `UPDATE assistant_proposals SET status = 'confirming', confirming_at = now() - interval '7 minutes', write_request_id = $2 WHERE id = $1`,
    [proposal.id, operation],
  )
  const stored = async () =>
    (
      await adminPool().query<{ status: string; write_request_id: string | null; confirming_at: string }>(
        'SELECT status, write_request_id, confirming_at::text FROM assistant_proposals WHERE id = $1',
        [proposal.id],
      )
    ).rows[0]
  const before = await stored()

  const missing = randomUUID()
  for (const [label, other] of [
    ['the owner', owner],
    ['a principal', principal],
    ["8 B's teacher", otherTeacher],
    ['the first teacher', teacher],
  ] as const) {
    const states = await other.fetch(assistant(`/threads/${threadId}/proposals`))
    const noThread = await other.fetch(assistant(`/threads/${missing}/proposals`))
    assert.equal(states.status, noThread.status, `${label}: a real thread differs from a missing one`)
    assert.equal(await codeOf(states), 'RESOURCE_NOT_FOUND', label)
    assert.equal(await codeOf(await confirm(other, proposal.id, proposal.preview)), 'RESOURCE_NOT_FOUND', `${label} confirming`)
    assert.equal(await codeOf(await dismiss(other, proposal.id)), 'RESOURCE_NOT_FOUND', `${label} dismissing`)
  }
  assert.deepEqual(await stored(), before)
  assert.equal(before?.status, 'confirming')
  assert.equal(await attendanceRowsIn(who.sectionId), 0)

  // Its owner looking settles it: no audit row carries the id, so it opens again.
  const own = await body<{ items: AssistantProposal[] }>(await who.client.fetch(assistant(`/threads/${threadId}/proposals`)))
  assert.deepEqual(own.items.map((item) => [item.id, item.status]), [[proposal.id, 'open']])
  await assertUnwritten(proposal.id, 'settled by its owner')
})

// ---------------------------------------------------------------------------
// 9. Another school.

test("[proposals] another school's section and paper ids answer not available, exactly like ids that do not exist", async () => {
  const missing = randomUUID()
  const grades = { card: 'term_1', grades: [{ pupil: 'Asha', area: 'discipline', grade: 'A' }] }
  const calls: ScriptedCall[] = [
    { tool: 'propose_attendance_day', input: { section: fixtureSection } },
    { tool: 'propose_attendance_day', input: { section: otherSchoolSection } },
    { tool: 'propose_attendance_day', input: { section: missing } },
    { tool: 'propose_exam_marks', input: { paper: otherSchoolPaper, marks: [{ pupil: 'Asha', value: 5 }] } },
    { tool: 'propose_exam_marks', input: { paper: missing, marks: [{ pupil: 'Asha', value: 5 }] } },
    { tool: 'propose_co_scholastic', input: { section: fixtureSection, ...grades } },
    { tool: 'propose_co_scholastic', input: { section: otherSchoolSection, ...grades } },
    { tool: 'propose_co_scholastic', input: { section: missing, ...grades } },
  ]
  // The owner holds every key there is in this school, and none in the other.
  const threadId = await newThread(owner)
  const turn = await ask(owner, threadId, 'Mark these classes.', { steps: [calls] })
  turn.outputs.forEach((output, index) => assert.deepEqual(output, { status: 'not_available' }, `${calls[index]?.tool} #${index}`))
  assertNothingOf(toolResultsSeen(turn), ['Fixture', OTHER_SCHOOL_NAME], "the model's tool results")
  const saved = await adminPool().query('SELECT 1 FROM assistant_proposals WHERE thread_id = $1', [threadId])
  assert.equal(saved.rowCount, 0)

  // A real proposal of this school, pointed at the other school on the card, is refused before any write.
  const own = await askOnce(owner, [{ tool: 'propose_exam_marks', input: { paper: minePaper, component: 'subject_enrichment', marks: [{ pupil: 'Mira', value: 3 }] } }])
  const proposal = proposalOf(own.outputs[0], "the owner's marks")
  const before = await writtenRows()
  const refused = await confirm(owner, proposal.id, { ...(proposal.preview as ExamMarksPreview), paperId: otherSchoolPaper })
  assert.equal(refused.status, 400, await refused.clone().text())
  assert.equal(await codeOf(refused), 'INVALID_REQUEST')
  assert.deepEqual(await writtenRows(), before)
  await assertUnwritten(proposal.id, 'another school')
  const theirs = await adminPool().query('SELECT 1 FROM exam_marks WHERE school_id = $1', [otherSchool])
  assert.equal(theirs.rowCount, 0)
})

// ---------------------------------------------------------------------------
// 8. Words and names stay sealed. Last, so it sees every proposal above.

test("[proposals] titles and previews are sealed, and the assistant's own audit and request-log rows name no pupil", async () => {
  const pool = adminPool()
  const key = server.config.DATA_ENCRYPTION_KEY
  const surnames = [...Object.keys(NAMES).map(surname), ...extraSurnames]
  const names = [...surnames, ...Object.values(NAMES).map(([first]) => first)]

  const proposals = await pool.query<{
    title_sealed: string
    preview_sealed: string
    confirmed_preview_sealed: string | null
    outcome: string | null
    check_path: string
  }>(
    'SELECT title_sealed, preview_sealed, confirmed_preview_sealed, outcome, check_path FROM assistant_proposals WHERE school_id = $1',
    [school],
  )
  assert.ok(proposals.rows.length >= 10, `only ${proposals.rows.length} proposals were made`)
  let opened = 0
  for (const row of proposals.rows) {
    // Sealed columns: no surname in the clear, no section name, no plain JSON.
    for (const sealed of [row.title_sealed, row.preview_sealed, row.confirmed_preview_sealed ?? '']) {
      assertNothingOf(sealed, [...surnames, 'Class 8', '"rows"', 'attendance_day'], 'a sealed proposal column')
    }
    // Plain columns: no name at all.
    assertNothingOf(`${row.outcome ?? ''} ${row.check_path}`, names, 'a plain proposal column')
    // And the seal is what hides them: opened, the preview names the pupils.
    if (surnames.some((name) => open(row.preview_sealed, key).includes(name))) opened += 1
    assert.ok(open(row.title_sealed, key).length > 0)
  }
  assert.equal(opened, proposals.rows.length, 'a preview did not open to its pupils')

  // Every row the assistant's own routes wrote: their request-log lines and
  // the audit rows under those requests, and every assistant audit row.
  const lines = await pool.query<{ line: string; request_id: string }>(
    `SELECT l::text AS line, request_id FROM access_log l
      WHERE school_id = $1 AND route LIKE '/api/schools/:schoolId/assistant/%'`,
    [school],
  )
  assert.ok(lines.rows.some((row) => row.line.includes('/proposals/:proposalId/confirm')), 'no confirm was logged')
  for (const row of lines.rows) assertNothingOf(row.line, names, 'an assistant request-log line')

  const audit = await pool.query<{ action: string; summary: string; changes: string }>(
    `SELECT action, summary, safe_changes::text AS changes FROM audit_events
      WHERE school_id = $1
        AND (request_id = ANY($2::text[]) OR action LIKE 'ai_assistant%' OR target_type LIKE 'assistant%')`,
    [school, lines.rows.map((row) => row.request_id)],
  )
  assert.ok(audit.rows.some((row) => row.action === 'ai_assistant.use'), 'no turn was audited')
  for (const row of audit.rows) {
    assertNothingOf(row.summary, names, `the ${row.action} audit summary`)
    assertNothingOf(row.changes, names, `the ${row.action} audit changes`)
  }
  // A turn's row names its change tools, and no words.
  const turns = await pool.query<{ tools: string[] }>(
    `SELECT safe_changes->'tools' AS tools FROM audit_events WHERE school_id = $1 AND target_type = 'assistant_turn'`,
    [school],
  )
  assert.ok(turns.rows.some((row) => row.tools.includes('propose_co_scholastic')))
})
