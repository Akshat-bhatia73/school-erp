/**
 * The assistant's change tools (Task 24b).
 *
 * A change tool reads through the same GET routes as the person and builds an
 * editable preview; it never writes. These tests run each tool against the
 * real server through a test context whose `get` is an ordinary signed-in
 * HTTP request, then prove that the request `write` builds is exactly one the
 * real write route accepts, by sending it as the same person and reading the
 * record back.
 *
 * The suite builds a school of its own (roles, a current year, a class with
 * two sections, pupils, staff, subjects and two exams), so nothing it writes
 * is seen by another file.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { z } from 'zod'
import {
  AttendanceDayPreview,
  CoScholasticPreview,
  ExamMarksPreview,
  PERMISSION_CATALOGUE,
  ROLE_TEMPLATES,
  StaffAttendanceDayPreview,
  type AssistantProposalPreview,
  type PermissionKey,
} from '@erp/contracts'
import { PROPOSE_TOOLS, proposeToolNamed, proposeToolsFor } from '../src/assistant/proposals/registry.ts'
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
const grade = randomUUID()
const nineA = randomUUID()
const nineB = randomUUID()
const maths = randomUUID()
const science = randomUUID()

const riyaS = randomUUID()
const riyaP = randomUUID()
const kabir = randomUUID()
const aarav = randomUUID()
const outsider = randomUUID()

const teacherStaff = randomUUID()
const officeStaff = randomUUID()
const anitaRao = randomUUID()
const anitaDesai = randomUUID()

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client
let teacher: Client
let today = ''
let pastDay = ''
const extraUserIds: string[] = []
const exams: Record<string, string> = {}

function shift(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`)
  moment.setUTCDate(moment.getUTCDate() + days)
  return moment.toISOString().slice(0, 10)
}

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

/** Prepare the way the assistant does: the input is checked against the tool's schema first. */
async function prepare(client: Client, name: string, input: Record<string, unknown>): Promise<PrepareOutcome<AssistantProposalPreview>> {
  const definition = tool(name)
  const parsed = definition.input.parse(input)
  return (definition.prepare as (input: unknown, context: ToolCallContext) => Promise<PrepareOutcome<AssistantProposalPreview>>)(
    parsed,
    contextFor(client),
  )
}

function drafted<T extends AssistantProposalPreview>(outcome: PrepareOutcome<AssistantProposalPreview>, schema: z.ZodType<T>): ProposalDraft<T> & { preview: T } {
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

/** Send the built request through the real write route, as the person. */
async function send(client: Client, request: WriteRequest): Promise<Response> {
  return client.fetch(`/api/schools/${school}${request.path}`, json(request.method, request.body))
}

async function readBody<T>(client: Client, path: string): Promise<T> {
  return ok<T>(await client.fetch(`/api/schools/${school}${path}`))
}

const clone = <T>(value: T): T => structuredClone(value)

async function member(input: { roleKeys: readonly string[]; label: string; staffId?: string; withMfa?: boolean }): Promise<Client> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `ai-propose-${input.label}-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, `Propose ${input.label}`, email])
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
  extraUserIds.push(userId)
  return input.withMfa
    ? signInWithMfa(server, { userId, email, password: PASSWORD })
    : signInWithPassword(server, email, PASSWORD)
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,'AIP')`, [
    school,
    `ai-propose-${suffix}`,
    `Propose School ${suffix}`,
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
    [year, school, `AIP-${suffix}`],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [school, year])
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,'Class 9','9',9)`, [grade, school])

  for (const [id, code, first, last, designation] of [
    [teacherStaff, 'T1', 'Meena', 'Iyer', 'Teacher'],
    [officeStaff, 'O1', 'Suresh', 'Kumar', 'Office manager'],
    [anitaRao, 'T2', 'Anita', 'Rao', 'Teacher'],
    [anitaDesai, 'T3', 'Anita', 'Desai', 'Librarian'],
  ] as const) {
    await pool.query(
      `INSERT INTO staff(id,school_id,employee_code,first_name,last_name,staff_type,designation,status,joining_date)
       VALUES ($1,$2,$3,$4,$5,'teaching',$6,'active',current_date - 100)`,
      [id, school, `AIP-${suffix}-${code}`, first, last, designation],
    )
  }
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id) VALUES ($1,$2,$3,$4,'A',$5)`,
    [nineA, school, year, grade, teacherStaff],
  )
  await pool.query(`INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,'B')`, [
    nineB,
    school,
    year,
    grade,
  ])
  for (const [id, name, code] of [
    [maths, 'Mathematics', 'MAT'],
    [science, 'Science', 'SCI'],
  ] as const) {
    await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,$3,$4,'scholastic')`, [id, school, name, code])
    await pool.query(`INSERT INTO grade_subjects(school_id,grade_id,academic_year_id,subject_id) VALUES ($1,$2,$3,$4)`, [
      school,
      grade,
      year,
      id,
    ])
  }
  // The teacher is 9 A's class teacher and teaches it Mathematics, not Science.
  await pool.query(
    `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from)
     VALUES ($1,$2,$3,$4,$5,current_date - 100)`,
    [school, teacherStaff, year, nineA, maths],
  )
  const pupils: [string, string, string, string][] = [
    [riyaS, 'Riya', 'Sharma', nineA],
    [riyaP, 'Riya', 'Patel', nineA],
    [kabir, 'Kabir', 'Mehta', nineA],
    [aarav, 'Aarav', 'Singh', nineA],
    [outsider, 'Other', 'Pupil', nineB],
  ]
  for (const [index, [id, first, last, sectionId]] of pupils.entries()) {
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,$4,$5,'active')`,
      [id, school, `AIP/${suffix}/${index + 1}`, first, last],
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

  const day = await ok<{ date: string; day: { kind: string } }>(await owner.fetch(`/api/schools/${school}/attendance/sections`))
  today = day.date
  assert.equal(day.day.kind, 'school_day', 'the suite needs today to be a school day')
  // The last school day before today: this school has no holidays, so only Sundays are skipped.
  pastDay = shift(today, -1)
  while (new Date(`${pastDay}T00:00:00Z`).getUTCDay() === 0) pastDay = shift(pastDay, -1)

  // One exam still open to the teacher, one past its re-check deadline.
  for (const [kind, startsOn, endsOn, recheckDeadline] of [
    ['periodic_test_1', shift(today, -30), shift(today, -29), shift(today, -20)],
    ['half_yearly', shift(today, -2), shift(today, -1), shift(today, 5)],
  ] as const) {
    const created = await ok<{ id: string }>(
      await owner.fetch(`/api/schools/${school}/exams`, json('POST', { academicYearId: year, kind, startsOn, endsOn, recheckDeadline })),
      201,
    )
    exams[kind] = created.id
  }
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = ANY($1::uuid[])', [extraUserIds])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = ANY($1::uuid[])', [extraUserIds])
  await server.close()
  await closeAdminPool()
})

// ---------------------------------------------------------------------------
// The definitions.

test('the four change tools are registered, each with an active write permission and described inputs', () => {
  assert.deepEqual(
    PROPOSE_TOOLS.map((definition) => definition.name),
    ['propose_attendance_day', 'propose_staff_attendance_day', 'propose_exam_marks', 'propose_co_scholastic'],
  )
  for (const definition of PROPOSE_TOOLS) {
    assert.match(definition.name, /^propose_[a-z0-9_]+$/)
    assert.ok(definition.description.length >= 40 && definition.description.length <= 400, definition.name)
    assert.match(definition.description, /Confirm/)
    assert.equal(PERMISSION_CATALOGUE[definition.permission]?.availability, 'active', definition.name)
    const schema = z.toJSONSchema(definition.input) as { properties?: Record<string, { description?: string }> }
    for (const [key, field] of Object.entries(schema.properties ?? {})) {
      assert.ok(field.description, `${definition.name}.${key} has no description`)
    }
  }
  const teacherKeys = new Set<PermissionKey>(ROLE_TEMPLATES.teacher.grants.map((grant) => grant.permission))
  assert.deepEqual(
    proposeToolsFor(teacherKeys).map((definition) => definition.name),
    ['propose_attendance_day', 'propose_exam_marks', 'propose_co_scholastic'],
  )
  assert.deepEqual(proposeToolsFor(new Set<PermissionKey>(['ai_assistant.use'])), [])
})

// ---------------------------------------------------------------------------
// A class's register.

type DayRow = { student: { id: string }; mark?: string; entry?: { kind: string } }
type Day = { marked: boolean; rows: DayRow[] }
const markOf = (day: Day, studentId: string) => day.rows.find((row) => row.student.id === studentId)?.mark

test('attendance: names resolve, an ambiguous or unknown name is refused, another class is not available', async () => {
  const ambiguous = problemOf(await prepare(teacher, 'propose_attendance_day', { section: '9A', except: [{ pupil: 'Riya', mark: 'absent' }] }))
  assert.match(ambiguous, /Riya Sharma \(roll 1\)/)
  assert.match(ambiguous, /Riya Patel \(roll 2\)/)
  assert.match(ambiguous, /Say which one/)

  const unknown = problemOf(await prepare(teacher, 'propose_attendance_day', { section: '9 A', except: [{ pupil: 'Zed', mark: 'absent' }] }))
  assert.equal(unknown, "Nobody called Zed is on Class 9 A's register.")

  assert.match(problemOf(await prepare(teacher, 'propose_attendance_day', { section: '10C' })), /No class called 10C/)
  // Another class: by name it is not among the classes the teacher can see, and by id the
  // register itself refuses. Neither says whether it exists.
  const other = problemOf(await prepare(teacher, 'propose_attendance_day', { section: 'Class 9 B' }))
  assert.equal(other, 'No class called Class 9 B was found. Classes you can see include Class 9 A.')
  assert.deepEqual(await prepare(teacher, 'propose_attendance_day', { section: nineB }), { status: 'not_available' })

  // A past day is the office's: the teacher is told why, in the register's words.
  assert.match(
    problemOf(await prepare(teacher, 'propose_attendance_day', { section: '9A', date: pastDay })),
    /The office can still correct it/,
  )
})

test('attendance: a first entry proposes the whole roll, and write is exactly the mark the route accepts', async () => {
  // Nobody unnamed and unmarked is given a mark on a guess: the model is told to ask.
  assert.equal(
    problemOf(await prepare(teacher, 'propose_attendance_day', { section: '9A', except: [{ pupil: 'Kabir', mark: 'absent' }] })),
    "3 pupils on Class 9 A's register have no mark yet and were not named. Ask whether everyone else is present, then pass everyone with their mark, or name each one.",
  )
  const draft = drafted(
    await prepare(teacher, 'propose_attendance_day', {
      section: 'Class 9 A',
      everyone: 'present',
      except: [
        { pupil: 'Kabir', mark: 'absent' },
        { pupil: `AIP/${suffix}/1`, mark: 'late' },
      ],
    }),
    AttendanceDayPreview,
  )
  const preview = draft.preview
  assert.equal(preview.mode, 'first_entry')
  assert.equal(preview.sectionId, nineA)
  assert.equal(preview.sectionName, 'Class 9 A')
  assert.equal(preview.date, today)
  assert.match(draft.title, /^Mark Class 9 A for \d{1,2} [A-Z][a-z]{2} \d{4}$/)
  assert.doesNotMatch(draft.title, /Kabir|Riya/)
  assert.equal(draft.checkPath, `/attendance/sections/${nineA}/days/${today}`)
  assert.equal(draft.href, `/attendance/sections/${nineA}?date=${today}`)
  assert.deepEqual(
    preview.rows.map((row) => [row.studentId, row.current, row.proposed, row.revision]),
    [
      [riyaS, null, 'late', 0],
      [riyaP, null, 'present', 0],
      [kabir, null, 'absent', 0],
      [aarav, null, 'present', 0],
    ],
  )
  assert.deepEqual((draft.forModel as { notPresent: unknown[] }).notPresent, [
    { name: 'Riya Sharma', mark: 'late' },
    { name: 'Kabir Mehta', mark: 'absent' },
  ])

  // The person edits one mark on the card: Aarav is on leave.
  const edited = clone(preview)
  edited.rows[3]!.proposed = 'leave'
  assert.equal(sameTarget('propose_attendance_day', preview, edited), true)
  const request = requestOf('propose_attendance_day', edited)
  assert.equal(request.method, 'PUT')
  assert.equal(request.path, `/attendance/sections/${nineA}/days/${today}`)
  assert.deepEqual(
    (request.body as { marks: { expectedRevision?: number }[] }).marks.map((line) => line.expectedRevision),
    [0, 0, 0, 0],
  )

  await ok(await send(teacher, request))
  const day = await readBody<Day>(teacher, `/attendance/sections/${nineA}/days/${today}`)
  assert.equal(day.marked, true)
  assert.equal(markOf(day, riyaS), 'late')
  assert.equal(markOf(day, kabir), 'absent')
  assert.equal(markOf(day, aarav), 'leave')
  assert.match(
    describeDone('propose_attendance_day', edited),
    /^Saved Class 9 A's register for \d{1,2} [A-Z][a-z]{2}: 1 present, 1 absent, 1 late, 1 on leave\.$/,
  )
})

test('attendance: sameTarget refuses another section or day, an added, removed or reordered row, and a changed fixed field', async () => {
  const preview = drafted(
    await prepare(teacher, 'propose_attendance_day', { section: '9A', except: [{ pupil: 'Aarav', mark: 'absent' }] }),
    AttendanceDayPreview,
  ).preview
  const name = 'propose_attendance_day'
  assert.equal(sameTarget(name, preview, clone(preview)), true)
  assert.equal(sameTarget(name, preview, { ...clone(preview), sectionId: nineB }), false)
  assert.equal(sameTarget(name, preview, { ...clone(preview), date: pastDay }), false)
  assert.equal(sameTarget(name, preview, { ...clone(preview), mode: 'correction' }), false)
  assert.equal(sameTarget(name, preview, { ...clone(preview), rows: preview.rows.slice(1) }), false)
  assert.equal(
    sameTarget(name, preview, { ...clone(preview), rows: [...clone(preview.rows), { ...clone(preview.rows[0]!), studentId: outsider }] }),
    false,
  )
  assert.equal(sameTarget(name, preview, { ...clone(preview), rows: [...clone(preview.rows)].reverse() }), false)
  const renamed = clone(preview)
  renamed.rows[0]!.current = 'absent'
  assert.equal(sameTarget(name, preview, renamed), false)
  const revised = clone(preview)
  revised.rows[0]!.revision = (revised.rows[0]!.revision ?? 0) + 1
  assert.equal(sameTarget(name, preview, revised), false)
  const reasoned = clone(preview)
  reasoned.reason = 'Typed on the card'
  assert.equal(sameTarget(name, preview, reasoned), true)

  // Today was marked by the previous test: the teacher's register is still the day's own, so a
  // change is the whole roll again, with only Aarav moved.
  assert.equal(preview.mode, 'first_entry')
  assert.deepEqual(
    preview.rows.filter((row) => row.proposed !== row.current).map((row) => row.studentId),
    [aarav],
  )
  assert.deepEqual(preview.rows.map((row) => row.revision), [1, 1, 1, 1])
  const unchanged = clone(preview)
  unchanged.rows[3]!.proposed = unchanged.rows[3]!.current!
  assert.deepEqual(writeOf(name, unchanged), { problem: 'Nothing has changed.' })
})

test('attendance: the office corrects a past day, changed pupils only, and only with a reason', async () => {
  // The past day is first filled in through the correction route itself: everyone present.
  await ok(
    await owner.fetch(
      `/api/schools/${school}/attendance/sections/${nineA}/days/${pastDay}/corrections`,
      json('POST', { marks: [riyaS, riyaP, kabir, aarav].map((studentId) => ({ studentId, mark: 'present' })), reason: 'Paper register' }),
    ),
    201,
  )
  const draft = drafted(
    await prepare(owner, 'propose_attendance_day', { section: '9A', date: pastDay, except: [{ pupil: 'riya sharma', mark: 'absent' }] }),
    AttendanceDayPreview,
  )
  const preview = draft.preview
  assert.equal(preview.mode, 'correction')
  assert.match(draft.title, /^Correct Class 9 A for /)
  assert.deepEqual(preview.rows.map((row) => row.current), ['present', 'present', 'present', 'present'])
  assert.deepEqual(preview.rows.map((row) => row.proposed), ['absent', 'present', 'present', 'present'])

  assert.deepEqual(writeOf('propose_attendance_day', preview), { problem: 'Add a reason for changing a saved register.' })
  const edited = { ...clone(preview), reason: 'Left at the first period' }
  const request = requestOf('propose_attendance_day', edited)
  assert.equal(request.method, 'POST')
  assert.equal(request.path, `/attendance/sections/${nineA}/days/${pastDay}/corrections`)
  assert.deepEqual(request.body, { marks: [{ studentId: riyaS, mark: 'absent', expectedRevision: 1 }], reason: 'Left at the first period' })

  await ok(await send(owner, request), 201)
  const day = await readBody<Day>(owner, `/attendance/sections/${nineA}/days/${pastDay}`)
  assert.equal(markOf(day, riyaS), 'absent')
  assert.equal(day.rows.find((row) => row.student.id === riyaS)?.entry?.kind, 'correction')
  assert.equal(markOf(day, riyaP), 'present')
  assert.match(describeDone('propose_attendance_day', edited), /^Corrected Class 9 A's register for .*: 1 mark changed\.$/)

  // Asking for what is already saved proposes nothing.
  assert.match(
    problemOf(await prepare(owner, 'propose_attendance_day', { section: '9A', date: pastDay, except: [{ pupil: 'Riya Sharma', mark: 'absent' }] })),
    /already has those marks/,
  )
})

test('attendance: correcting a day nobody marked changes only the pupils named, and leaves the rest unmarked', async () => {
  // The school day before the past day: nothing was ever saved on it.
  let earlier = shift(pastDay, -1)
  while (new Date(`${earlier}T00:00:00Z`).getUTCDay() === 0) earlier = shift(earlier, -1)
  const draft = drafted(
    await prepare(owner, 'propose_attendance_day', { section: '9A', date: earlier, except: [{ pupil: 'Kabir', mark: 'absent' }] }),
    AttendanceDayPreview,
  )
  const preview = draft.preview
  assert.equal(preview.mode, 'correction')
  assert.deepEqual(preview.rows.map((row) => [row.studentId, row.current, row.proposed, row.revision]), [[kabir, null, 'absent', 0]])
  assert.equal((draft.forModel as { leftUnmarked?: number }).leftUnmarked, 3)

  const request = requestOf('propose_attendance_day', { ...preview, reason: 'From the paper register' })
  assert.deepEqual(request.body, { marks: [{ studentId: kabir, mark: 'absent', expectedRevision: 0 }], reason: 'From the paper register' })
  await ok(await send(owner, request), 201)
  const day = await readBody<Day>(owner, `/attendance/sections/${nineA}/days/${earlier}`)
  assert.equal(markOf(day, kabir), 'absent')
  for (const other of [riyaS, riyaP, aarav]) assert.equal(markOf(day, other), undefined)
})

// ---------------------------------------------------------------------------
// The staff register.

type StaffDay = { rows: { staff: { id: string }; mark?: string; self: boolean }[] }

test('staff register: the caller is left out, names resolve, and the whole register is marked', async () => {
  const name = 'propose_staff_attendance_day'
  assert.match(problemOf(await prepare(owner, name, { except: [{ person: 'Anita', mark: 'leave' }] })), /Anita Rao \(AIP-.*\) and Anita Desai/)
  assert.equal(
    problemOf(await prepare(owner, name, { except: [{ person: 'Suresh Kumar', mark: 'absent' }] })),
    'Nobody marks their own attendance. A colleague in the office does it.',
  )
  assert.match(problemOf(await prepare(owner, name, { except: [{ person: 'Nobody Here', mark: 'absent' }] })), /^Nobody called Nobody Here is on the staff register/)
  // A teacher holds no staff register key beyond their own month.
  assert.deepEqual(await prepare(teacher, name, {}), { status: 'not_available' })

  assert.equal(
    problemOf(await prepare(owner, name, { except: [{ person: 'Anita Rao', mark: 'leave' }] })),
    '2 staff members on the staff register have no mark yet and were not named. Ask whether everyone else is present, then pass everyone with their mark, or name each one.',
  )
  const draft = drafted(await prepare(owner, name, { everyone: 'present', except: [{ person: 'Anita Rao', mark: 'leave' }] }), StaffAttendanceDayPreview)
  const preview = draft.preview
  assert.equal(preview.mode, 'first_entry')
  assert.match(draft.title, /^Mark the staff register for /)
  assert.deepEqual(new Set(preview.rows.map((row) => row.staffId)), new Set([teacherStaff, anitaRao, anitaDesai]))
  assert.equal(preview.rows.find((row) => row.staffId === anitaRao)?.proposed, 'leave')
  assert.equal(preview.rows.find((row) => row.staffId === anitaDesai)?.designation, 'Librarian')

  assert.equal(sameTarget(name, preview, { ...clone(preview), date: pastDay }), false)
  assert.equal(sameTarget(name, preview, { ...clone(preview), rows: [...clone(preview.rows)].reverse() }), false)
  assert.equal(sameTarget(name, preview, { ...clone(preview), rows: [...clone(preview.rows), { ...clone(preview.rows[0]!), staffId: officeStaff }] }), false)

  assert.ok(preview.rows.every((row) => row.revision === 0))
  const request = requestOf(name, preview)
  assert.equal(request.method, 'PUT')
  assert.equal(request.path, `/staff-attendance/days/${today}`)
  assert.ok((request.body as { marks: { expectedRevision?: number }[] }).marks.every((line) => line.expectedRevision === 0))
  await ok(await send(owner, request))
  const day = await readBody<StaffDay>(owner, `/staff-attendance/days/${today}`)
  assert.equal(day.rows.find((row) => row.staff.id === anitaRao)?.mark, 'leave')
  assert.equal(day.rows.find((row) => row.staff.id === teacherStaff)?.mark, 'present')
  assert.equal(day.rows.find((row) => row.self)?.mark, undefined)
  assert.match(describeDone(name, preview), /^Saved the staff register for .*: 2 present, 1 on leave\.$/)
})

test('staff register: a past day is a correction with a reason, and only the people named are marked', async () => {
  const name = 'propose_staff_attendance_day'
  const draft = drafted(await prepare(owner, name, { date: pastDay, except: [{ person: 'desai', mark: 'absent' }] }), StaffAttendanceDayPreview)
  const preview = draft.preview
  assert.equal(preview.mode, 'correction')
  // Nothing was saved that day: the two not named are left out, not marked present.
  assert.deepEqual(preview.rows.map((row) => row.staffId), [anitaDesai])
  assert.equal((draft.forModel as { leftUnmarked?: number }).leftUnmarked, 2)
  assert.deepEqual(writeOf(name, preview), { problem: 'Add a reason for changing a saved register.' })
  const request = requestOf(name, { ...preview, reason: 'Filled in from the gate book' })
  assert.equal(request.method, 'POST')
  assert.equal(request.path, `/staff-attendance/days/${pastDay}/corrections`)
  assert.deepEqual((request.body as { marks: unknown[] }).marks, [{ staffId: anitaDesai, mark: 'absent', expectedRevision: 0 }])
  await ok(await send(owner, request), 201)
  const day = await readBody<StaffDay>(owner, `/staff-attendance/days/${pastDay}`)
  assert.equal(day.rows.find((row) => row.staff.id === anitaDesai)?.mark, 'absent')
  assert.equal(day.rows.find((row) => row.staff.id === anitaRao)?.mark, undefined)
  assert.equal(day.rows.find((row) => row.staff.id === teacherStaff)?.mark, undefined)
})

// ---------------------------------------------------------------------------
// Exam marks.

type Sheet = { paper: { id: string; section: { id: string } }; rows: { student: { id: string }; cells: { component: string; value: unknown; kind: string }[] }[] }
const cellOf = (sheet: Sheet, studentId: string, component: string) =>
  sheet.rows.find((row) => row.student.id === studentId)?.cells.find((cell) => cell.component === component)

async function paperOf(kind: string, sectionId: string, subjectId: string): Promise<string> {
  const listed = await readBody<{ items: { id: string; exam: { id: string }; section: { id: string }; subject: { id: string } }[] }>(
    owner,
    `/exams/papers?academicYearId=${year}`,
  )
  const paper = listed.items.find((item) => item.exam.id === exams[kind] && item.section.id === sectionId && item.subject.id === subjectId)
  assert.ok(paper, `no ${kind} paper`)
  return paper.id
}

test('exam marks: the paper is found by name, and a first entry saves through the marks route', async () => {
  const name = 'propose_exam_marks'
  const paperId = await paperOf('half_yearly', nineA, maths)

  assert.match(problemOf(await prepare(teacher, name, { subject: 'maths', section: '9A', marks: [{ pupil: 'Aarav', value: 10 }] })), /More than one paper matches: Periodic test 1, Mathematics, Class 9 A and Half-yearly exam, Mathematics, Class 9 A/)
  assert.match(problemOf(await prepare(teacher, name, { exam: 'olympiad', subject: 'maths', section: '9A', marks: [{ pupil: 'Aarav', value: 10 }] })), /No exam is called olympiad/)
  assert.match(problemOf(await prepare(teacher, name, { exam: 'half-yearly', subject: 'maths', section: '9A', marks: [{ pupil: 'Riya', value: 10 }] })), /Riya Sharma \(roll 1\) and Riya Patel \(roll 2\)/)
  assert.equal(
    problemOf(await prepare(teacher, name, { exam: 'half-yearly', subject: 'maths', section: '9A', marks: [{ pupil: 'Aarav', value: 85 }] })),
    "Aarav Singh's mark of 85 is more than the written exam maximum of 80.",
  )
  assert.match(
    problemOf(await prepare(teacher, name, { exam: 'half-yearly', subject: 'maths', section: '9A', component: 'notebook', marks: [{ pupil: 'Aarav', value: 7 }] })),
    /maximum of 5\.$/,
  )
  // Another section's paper is not the teacher's.
  assert.deepEqual(await prepare(teacher, name, { paper: await paperOf('half_yearly', nineB, maths), marks: [{ pupil: 'Other', value: 5 }] }), {
    status: 'not_available',
  })

  const draft = drafted(
    await prepare(teacher, name, {
      exam: 'Half yearly',
      subject: 'Mathematics',
      section: 'Class 9 A',
      marks: [
        { pupil: 'Riya Sharma', value: 72.5 },
        { pupil: 'Kabir', value: 'absent' },
        { pupil: 'Kabir', value: 4, component: 'notebook' },
      ],
    }),
    ExamMarksPreview,
  )
  const preview = draft.preview
  assert.equal(preview.mode, 'first_entry')
  assert.equal(preview.paperId, paperId)
  assert.equal(preview.title, 'Half-yearly exam, Mathematics, Class 9 A')
  assert.equal(draft.title, 'Enter marks: Half-yearly exam, Mathematics, Class 9 A')
  assert.equal(draft.href, `/exams/papers/${paperId}`)
  assert.deepEqual(preview.components.map((component) => component.component), ['notebook', 'subject_enrichment', 'written'])
  assert.equal(preview.rows.length, 4)
  const riya = preview.rows.find((row) => row.studentId === riyaS)!
  assert.deepEqual(riya.cells.map((cell) => [cell.component, cell.current, cell.proposed]), [
    ['notebook', null, null],
    ['subject_enrichment', null, null],
    ['written', null, 72.5],
  ])

  const request = requestOf(name, preview)
  assert.equal(request.method, 'PUT')
  assert.equal(request.path, `/exams/papers/${paperId}/marks`)
  assert.deepEqual(request.body, {
    entries: [
      { studentId: riyaS, component: 'written', value: 72.5, expectedRevision: 0 },
      { studentId: kabir, component: 'notebook', value: 4, expectedRevision: 0 },
      { studentId: kabir, component: 'written', value: 'absent', expectedRevision: 0 },
    ],
  })
  await ok(await send(teacher, request))
  const sheet = await readBody<Sheet>(teacher, `/exams/papers/${paperId}`)
  assert.equal(cellOf(sheet, riyaS, 'written')?.value, 72.5)
  assert.equal(cellOf(sheet, kabir, 'written')?.value, 'absent')
  assert.equal(describeDone(name, preview), 'Saved 3 marks for Half-yearly exam, Mathematics, Class 9 A.')
})

test('exam marks: changing a saved mark needs a reason, and the whole sheet is saved again', async () => {
  const name = 'propose_exam_marks'
  const paperId = await paperOf('half_yearly', nineA, maths)
  const preview = drafted(await prepare(teacher, name, { paper: paperId, marks: [{ pupil: 'Riya Sharma', value: 75 }] }), ExamMarksPreview).preview
  assert.equal(preview.mode, 'correction')
  assert.deepEqual(writeOf(name, preview), { problem: 'Add a reason for changing saved marks.' })
  assert.deepEqual(writeOf(name, { ...clone(preview), reason: 'Added up wrongly' }), { problem: 'Add a reason for changing saved marks.' })

  // Every saved cell carries its revision, an empty one 0.
  const revisionOf = (studentId: string, component: string) =>
    preview.rows.find((row) => row.studentId === studentId)?.cells.find((cell) => cell.component === component)?.revision
  assert.equal(revisionOf(riyaS, 'written'), 1)
  assert.equal(revisionOf(riyaS, 'notebook'), 0)

  const edited: ExamMarksPreview = { ...clone(preview), reasonKind: 'entry_error', reason: 'Added up wrongly' }
  const request = requestOf(name, edited)
  assert.equal(request.method, 'PUT')
  assert.deepEqual(request.body, {
    entries: [
      { studentId: riyaS, component: 'written', value: 75, expectedRevision: 1 },
      { studentId: kabir, component: 'notebook', value: 4, expectedRevision: 1 },
      { studentId: kabir, component: 'written', value: 'absent', expectedRevision: 1 },
    ],
    change: { reasonKind: 'entry_error', reason: 'Added up wrongly' },
  })
  await ok(await send(teacher, request))
  assert.equal(cellOf(await readBody<Sheet>(teacher, `/exams/papers/${paperId}`), riyaS, 'written')?.value, 75)

  // sameTarget: another paper, a reordered or shorter sheet, or a changed current value is another change.
  assert.equal(sameTarget(name, preview, edited), true)
  assert.equal(sameTarget(name, preview, { ...clone(preview), paperId: await paperOf('half_yearly', nineA, science) }), false)
  assert.equal(sameTarget(name, preview, { ...clone(preview), rows: [...clone(preview.rows)].reverse() }), false)
  assert.equal(sameTarget(name, preview, { ...clone(preview), rows: preview.rows.slice(1) }), false)
  assert.equal(preview.route, 'marks_sheet')
  assert.equal(sameTarget(name, preview, { ...clone(preview), route: 'office_correction' }), false)
  const moved = clone(preview)
  moved.rows[0]!.cells[0]!.current = 3
  assert.equal(sameTarget(name, preview, moved), false)
  const revised = clone(preview)
  revised.rows[0]!.cells[0]!.revision = 7
  assert.equal(sameTarget(name, preview, revised), false)

  // Sent again, the same request is refused: the marks it was read at have moved.
  const again = await send(teacher, request)
  assert.equal(again.status, 409, await again.clone().text())

  // A number over the maximum typed on the card is refused before any write.
  const over = clone(edited)
  over.rows.find((row) => row.studentId === aarav)!.cells[0]!.proposed = 7
  assert.deepEqual(writeOf(name, over), { problem: "Aarav Singh's notebook mark is more than the maximum of 5." })
})

test('exam marks: after the re-check deadline only the office corrects, through the correction route', async () => {
  const name = 'propose_exam_marks'
  const input = { exam: 'PT1', subject: 'Mathematics', section: '9A', marks: [{ pupil: 'Aarav', value: 9 }] }
  assert.match(problemOf(await prepare(teacher, name, input)), /Only the office can change these marks now/)
  // A subject the teacher does not teach offers no control at all.
  assert.deepEqual(await prepare(teacher, name, { ...input, subject: 'Science' }), { status: 'not_available' })

  const draft = drafted(await prepare(owner, name, input), ExamMarksPreview)
  const preview = draft.preview
  assert.equal(preview.mode, 'correction')
  assert.equal(preview.route, 'office_correction')
  assert.equal(preview.title, 'Periodic test 1, Mathematics, Class 9 A')
  assert.equal(draft.title, 'Correct marks: Periodic test 1, Mathematics, Class 9 A')
  assert.deepEqual(preview.components.map((component) => [component.component, component.maxMarks]), [['periodic_test', 10]])
  assert.deepEqual(writeOf(name, preview), { problem: 'Choose why the marks are changing and add a reason.' })

  const edited: ExamMarksPreview = { ...clone(preview), reasonKind: 'recheck', reason: 'Re-check asked by the family' }
  const request = requestOf(name, edited)
  const paperId = await paperOf('periodic_test_1', nineA, maths)
  assert.equal(request.method, 'POST')
  assert.equal(request.path, `/exams/papers/${paperId}/corrections`)
  assert.deepEqual(request.body, {
    entries: [{ studentId: aarav, component: 'periodic_test', value: 9, expectedRevision: 0 }],
    reasonKind: 'recheck',
    reason: 'Re-check asked by the family',
  })
  await ok(await send(owner, request), 201)
  const cell = cellOf(await readBody<Sheet>(owner, `/exams/papers/${paperId}`), aarav, 'periodic_test')
  assert.equal(cell?.value, 9)
  assert.equal(cell?.kind, 'correction')
  assert.equal(describeDone(name, edited), 'Corrected 1 mark for Periodic test 1, Mathematics, Class 9 A.')
})

// ---------------------------------------------------------------------------
// Co-scholastic grades and remarks.

type Entries = { rows: { student: { id: string }; entry: { version: number; grades: Record<string, string | null>; remarks: string | null } | null }[] }

test('co-scholastic: the class teacher proposes grades and remarks, and only changed pupils are sent', async () => {
  const name = 'propose_co_scholastic'
  assert.equal(problemOf(await prepare(teacher, name, { section: '9A', card: 'term_1' })), 'Say which grades or remarks to set.')
  assert.deepEqual(
    await prepare(teacher, name, { section: nineB, card: 'term_1', grades: [{ pupil: 'Other', area: 'discipline', grade: 'A' }] }),
    { status: 'not_available' },
  )
  assert.match(
    problemOf(await prepare(teacher, name, { section: '9A', card: 'term_1', grades: [{ pupil: 'Riya', area: 'discipline', grade: 'A' }] })),
    /Riya Sharma \(roll 1\) and Riya Patel \(roll 2\)/,
  )

  const draft = drafted(
    await prepare(teacher, name, {
      section: '9A',
      card: 'term_1',
      grades: [
        { pupil: 'Aarav', area: 'discipline', grade: 'A' },
        { pupil: 'Aarav', area: 'art_education', grade: 'B' },
      ],
      remarks: [{ pupil: 'Kabir', text: '  Helpful and kind.  ' }],
    }),
    CoScholasticPreview,
  )
  const preview = draft.preview
  assert.equal(preview.card, 'term_1')
  assert.equal(draft.title, 'Co-scholastic grades and remarks, Class 9 A, Term 1 report card')
  assert.equal(draft.href, `/exams/report-cards/sections/${nineA}?tab=entries&term=term_1`)
  assert.equal(preview.rows.length, 4)
  const aaravRow = preview.rows.find((row) => row.studentId === aarav)!
  assert.deepEqual(aaravRow.proposed, { work_education: null, art_education: 'B', health_physical_education: null, discipline: 'A' })

  assert.equal(sameTarget(name, preview, { ...clone(preview), card: 'final' }), false)
  assert.equal(sameTarget(name, preview, { ...clone(preview), sectionId: nineB }), false)
  assert.equal(sameTarget(name, preview, { ...clone(preview), rows: [...clone(preview.rows)].reverse() }), false)
  const edited = clone(preview)
  edited.rows.find((row) => row.studentId === kabir)!.proposed.work_education = 'C'
  assert.equal(sameTarget(name, preview, edited), true)

  const request = requestOf(name, edited)
  assert.equal(request.method, 'PUT')
  assert.equal(request.path, `/report-cards/sections/${nineA}/terms/term_1/entries`)
  assert.deepEqual(request.body, {
    rows: [
      {
        studentId: kabir,
        expectedVersion: 0,
        grades: { work_education: 'C', art_education: null, health_physical_education: null, discipline: null },
        remarks: 'Helpful and kind.',
      },
      {
        studentId: aarav,
        expectedVersion: 0,
        grades: { work_education: null, art_education: 'B', health_physical_education: null, discipline: 'A' },
        remarks: null,
      },
    ],
  })
  await ok(await send(teacher, request))
  const entries = await readBody<Entries>(teacher, `/report-cards/sections/${nineA}/terms/term_1/entries`)
  assert.equal(entries.rows.find((row) => row.student.id === kabir)?.entry?.remarks, 'Helpful and kind.')
  assert.equal(entries.rows.find((row) => row.student.id === aarav)?.entry?.grades.discipline, 'A')
  assert.equal(entries.rows.find((row) => row.student.id === riyaS)?.entry, null)
  assert.equal(describeDone(name, edited), 'Saved co-scholastic grades and remarks for 2 pupils of Class 9 A, Term 1 report card.')

  const unchanged = clone(preview)
  for (const row of unchanged.rows) {
    row.proposed = row.current
    row.proposedRemarks = row.currentRemarks
  }
  assert.deepEqual(writeOf(name, unchanged), { problem: 'Nothing has changed.' })
})

test("co-scholastic: a pupil's saved entry is changed with its version, like the report cards screen", async () => {
  const name = 'propose_co_scholastic'
  const preview = drafted(
    await prepare(teacher, name, { section: '9A', card: 'term_1', grades: [{ pupil: 'Aarav', area: 'discipline', grade: 'B' }] }),
    CoScholasticPreview,
  ).preview
  const row = preview.rows.find((entry) => entry.studentId === aarav)!
  assert.ok(row.version > 0, 'a saved entry carries its version')
  assert.equal(row.proposed.discipline, 'B')
  const request = requestOf(name, preview)
  const line = (request.body as { rows: { studentId: string; expectedVersion: number }[] }).rows.find((entry) => entry.studentId === aarav)
  assert.equal(line?.expectedVersion, row.version)
  await ok(await send(teacher, request))
  // The same proposal again is stale at the route: the version moved.
  const again = await send(teacher, request)
  assert.notEqual(again.status, 200)
})
