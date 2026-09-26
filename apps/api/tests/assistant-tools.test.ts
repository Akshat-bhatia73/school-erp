/**
 * The assistant's read tools (Task 24a).
 *
 * A tool is only ever a call to one of our own routes as the person asking, so
 * these tests run every tool against the real server through a test context
 * whose `get` is an ordinary signed-in HTTP request. They prove the tools are
 * well formed, that none of them reaches a route the assistant must never
 * use, that their cards and sources are what the browser can draw, and that a
 * teacher or a parent gets no more through a tool than through a screen.
 *
 * The suite builds a school of its own (roles, a current year, a class, three
 * sections, staff, pupils and the people who sign in), so nothing it writes is
 * seen by another file. Fixture school A is only ever read, as the other school.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import test, { after, before } from 'node:test'
import { z } from 'zod'
import {
  ASSISTANT_MAX_ROWS,
  AppPath,
  AssistantCard,
  AssistantSource,
  PERMISSION_CATALOGUE,
  ROLE_TEMPLATES,
  type PermissionKey,
} from '@erp/contracts'
import { fixtureIds } from '@erp/db/fixtures'
import { READ_TOOLS, isOffered, toolsFor } from '../src/assistant/tools/registry.ts'
import { suggestionsFor } from '../src/assistant/prompt.ts'
import type { AnyReadTool, ReadToolOutcome, RouteAnswer, ToolCallContext } from '../src/assistant/tools/types.ts'
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
const mySection = randomUUID()
const otherSection = randomUUID()
const bigSection = randomUUID()
const p1 = randomUUID()
const p2 = randomUUID()
const outsider = randomUUID()
const BIG = ASSISTANT_MAX_ROWS + 10

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client
let teacher: Client
let parent: Client
let teacherStaffId = ''
let today = ''
const extraUserIds: string[] = []
let ownerMembershipId = ''

/** Every path any tool asked for during the run, relative to the school. */
const calledPaths = new Set<string>()

/**
 * The route calls the assistant must never make, even for a person who may
 * make them on a screen: whole identity numbers, files and photos, the audit
 * log, exports, pupil logins, message delivery records, the promotion
 * preview and the message settings.
 */
const FORBIDDEN: readonly RegExp[] = [
  /\/aadhaar(\/|$)/,
  /\/apaar(\/|$)/,
  /\/guardians\/[^/]+\/identity(\/|$)/,
  /\/documents(\/|$)/,
  /\/photo(\/|$)/,
  /\/logo(\/|$)/,
  /\/subject-access(\/|$)/,
  /^\/audit-events(\/|$)/,
  /(^|\/)exports?(\/|$)/,
  /\/export-profile(\/|$)/,
  /^\/students\/[^/]+\/login(\/|$)/,
  /\/recipients(\/|$)/,
  /\/promote\/preview(\/|$)/,
  /^\/messages\/settings(\/|$)/,
  /\/attachments(\/|$)/,
]

/** A tool context whose `get` is a real HTTP GET as the signed-in client. */
function contextFor(client: Client, now?: string): ToolCallContext {
  return {
    schoolId: school,
    today,
    ...(now === undefined ? {} : { now }),
    academicYearId: year,
    async get(path, query): Promise<RouteAnswer> {
      calledPaths.add(path)
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

function toolNamed(name: string): AnyReadTool {
  const tool = READ_TOOLS.find((candidate) => candidate.name === name)
  assert.ok(tool, `no tool named ${name}`)
  return tool
}

/** Run a tool the way the assistant does: the input is checked against the tool's schema first. */
async function run(client: Client, name: string, input: Record<string, unknown>, now?: string): Promise<ReadToolOutcome> {
  const tool = toolNamed(name)
  const parsed = tool.input.parse(input)
  return tool.run(parsed as never, contextFor(client, now))
}

/** An `ok` outcome whose card and source are what the browser can draw. */
function assertDrawable(outcome: ReadToolOutcome, label: string): Extract<ReadToolOutcome, { status: 'ok' }> {
  assert.equal(outcome.status, 'ok', `${label} answered ${outcome.status}`)
  if (outcome.status !== 'ok') throw new Error('unreachable')
  if (outcome.card !== undefined) AssistantCard.parse(outcome.card)
  if (outcome.source !== undefined) {
    AssistantSource.parse(outcome.source)
    assert.ok(AppPath.safeParse(outcome.source.href).success, `${label} source is not an app path`)
  }
  JSON.stringify(outcome.forModel)
  return outcome
}

function rowsOf(outcome: Extract<ReadToolOutcome, { status: 'ok' }>) {
  assert.equal(outcome.card?.kind, 'table')
  if (outcome.card?.kind !== 'table') throw new Error('unreachable')
  return outcome.card
}

async function member(input: {
  roleKeys: readonly string[]
  label: string
  staffId?: string
  childId?: string
  withMfa?: boolean
}): Promise<Client> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `ai-tools-${input.label}-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, `Tools ${input.label}`, email])
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')`,
    [membershipId, school, userId],
  )
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
  if (input.childId !== undefined) {
    const guardianId = randomUUID()
    await pool.query('INSERT INTO guardians(id,school_id,first_name) VALUES ($1,$2,$3)', [
      guardianId,
      school,
      `Tools guardian ${input.label}`,
    ])
    await pool.query(
      `INSERT INTO membership_guardian_links(school_id,membership_id,guardian_id,verified_at) VALUES ($1,$2,$3,now())`,
      [school, membershipId, guardianId],
    )
    await pool.query(
      `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation) VALUES ($1,$2,$3,'guardian')`,
      [school, input.childId, guardianId],
    )
    await pool.query(
      `INSERT INTO guardian_student_access
         (school_id,guardian_id,student_id,status,areas,approved_by_membership_id,approved_at)
       VALUES ($1,$2,$3,'approved',ARRAY['basic'],$4,now())`,
      [school, guardianId, input.childId, ownerMembershipId],
    )
  }
  await setFixturePassword(server, userId, PASSWORD)
  extraUserIds.push(userId)
  if (input.roleKeys.includes('owner')) ownerMembershipId = membershipId
  return input.withMfa
    ? signInWithMfa(server, { userId, email, password: PASSWORD })
    : signInWithPassword(server, email, PASSWORD)
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,'AIT')`, [
    school,
    `ai-tools-${suffix}`,
    `Tools School ${suffix}`,
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
    [year, school, `AIT-${suffix}`],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [school, year])

  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,9)`, [
    grade,
    school,
    `Tools ${suffix}`,
    `T${suffix.slice(0, 3)}`,
  ])
  teacherStaffId = randomUUID()
  await pool.query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status,joining_date)
     VALUES ($1,$2,$3,'Tools Teacher','teaching','Teacher','active',current_date - 100)`,
    [teacherStaffId, school, `AIT-${suffix}`],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id) VALUES ($1,$2,$3,$4,'A',$5)`,
    [mySection, school, year, grade, teacherStaffId],
  )
  await pool.query(`INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,'B')`, [
    otherSection,
    school,
    year,
    grade,
  ])
  await pool.query(`INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,'C')`, [
    bigSection,
    school,
    year,
    grade,
  ])
  const pupils: [string, string, string][] = [
    [p1, 'Riya Tools', mySection],
    [p2, 'Kabir Tools', mySection],
    [outsider, 'Other Family', otherSection],
    ...Array.from({ length: BIG }, (_, index): [string, string, string] => [randomUUID(), `Bulkpupil ${index + 1}`, bigSection]),
  ]
  for (const [index, [id, name, sectionId]] of pupils.entries()) {
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,status) VALUES ($1,$2,$3,$4,'active')`,
      [id, school, `AIT/${suffix}/${index + 1}`, name],
    )
    await pool.query(
      `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,$5,$6,current_date - 100)`,
      [randomUUID(), school, id, year, sectionId, index + 1],
    )
  }
  // Riya has every restricted block filled in, so a tool that leaks one shows it.
  await pool.query(
    `UPDATE students SET date_of_birth = '2012-05-14', gender = 'female', admission_date = '2018-04-02',
       category = 'General', address = to_jsonb('12 Tools Lane, Pune'::text), aadhaar_last4 = '1357',
       blood_group = 'B+', medical_notes = 'Peanut allergy'
     WHERE id = $1`,
    [p1],
  )
  const phoned = randomUUID()
  await pool.query(`INSERT INTO guardians(id,school_id,first_name,phone) VALUES ($1,$2,'Meera Tools','9876543210')`, [
    phoned,
    school,
  ])
  await pool.query(`INSERT INTO student_guardians(school_id,student_id,guardian_id,relation) VALUES ($1,$2,$3,'mother')`, [
    school,
    p1,
    phoned,
  ])

  server = await startTestServer()
  owner = await member({ roleKeys: ['owner'], label: 'owner', withMfa: true })
  teacher = await member({ roleKeys: ['teacher'], label: 'teacher', staffId: teacherStaffId })
  parent = await member({ roleKeys: ['parent'], label: 'parent', childId: p1 })

  const day = await owner.fetch(`/api/schools/${school}/attendance/sections`)
  assert.equal(day.status, 200, await day.clone().text())
  today = ((await day.json()) as { date: string }).date
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

test('every tool has a unique stable name, an active permission, a description and an input schema', () => {
  assert.ok(READ_TOOLS.length >= 35, `only ${READ_TOOLS.length} tools`)
  const names = READ_TOOLS.map((tool) => tool.name)
  assert.equal(new Set(names).size, names.length, 'tool names must be unique')
  for (const tool of READ_TOOLS) {
    assert.match(tool.name, /^[a-z][a-z0-9_]{2,63}$/, tool.name)
    assert.ok(tool.description.length >= 20 && tool.description.length <= 400, `${tool.name} description`)
    for (const key of [tool.permission, ...(tool.alsoRequires ?? [])]) {
      const entry = PERMISSION_CATALOGUE[key]
      assert.ok(entry, `${tool.name} names an unknown permission`)
      assert.equal(entry.availability, 'active', `${tool.name} names an inactive permission`)
    }
    assert.ok(tool.input instanceof z.ZodObject, `${tool.name} input is not an object schema`)
    // The model is sent JSON schema, and every field in it says what it is for.
    const schema = z.toJSONSchema(tool.input) as { properties?: Record<string, { description?: string }> }
    for (const [key, field] of Object.entries(schema.properties ?? {})) {
      assert.ok(field.description, `${tool.name}.${key} has no description`)
    }
  }
})

test('no tool reads a route the assistant must never use', async () => {
  // The source of every tool: no forbidden path is even written down.
  const dir = new URL('../src/assistant/tools/', import.meta.url)
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.ts')) continue
    const source = await readFile(new URL(file, dir), 'utf8')
    for (const path of source.matchAll(/[`'](\/[^`'\s]*)[`']/g)) {
      const written = path[1]!.replace(/\$\{[^}]*\}/g, 'x')
      for (const pattern of FORBIDDEN) assert.doesNotMatch(written, pattern, `${file} names ${written}`)
    }
    assert.doesNotMatch(source, /audit-events|subject-access|\/identity|\/aadhaar|\/apaar/, file)
  }
})

// ---------------------------------------------------------------------------
// Every tool against the real routes.

/** A value for each required field, from this suite's own rows; unknown record ids are new uuids. */
function inputFor(tool: AnyReadTool): Record<string, unknown> {
  const known: Record<string, unknown> = {
    studentId: p1,
    sectionId: mySection,
    staffId: teacherStaffId,
    gradeId: grade,
    query: 'Tools',
    periodIndex: 0,
  }
  const input: Record<string, unknown> = {}
  for (const [key, field] of Object.entries((tool.input as unknown as z.ZodObject).shape)) {
    if ((field as z.ZodType).safeParse(undefined).success) continue
    input[key] = key in known ? known[key] : randomUUID()
  }
  return input
}

test('the owner can run every tool: each answers ok or not available, never a broken body', async () => {
  for (const tool of READ_TOOLS) {
    const outcome = await run(owner, tool.name, inputFor(tool))
    assert.notEqual(outcome.status, 'failed', `${tool.name} failed`)
    if (outcome.status === 'ok') assertDrawable(outcome, tool.name)
  }
  for (const path of calledPaths) {
    for (const pattern of FORBIDDEN) assert.doesNotMatch(path, pattern, `a tool called ${path}`)
  }
})

test('one tool from each module answers the owner with a card and a source', async () => {
  const cases: [string, Record<string, unknown>][] = [
    ['school_profile', {}],
    ['dashboard', {}],
    ['search_school', { query: 'Riya' }],
    ['find_sections', { name: `T${suffix.slice(0, 3)}A` }],
    ['find_students', { query: 'Riya' }],
    ['student_record', { studentId: p1 }],
    ['student_enrolments', { studentId: p1 }],
    ['staff_record', { staffId: teacherStaffId }],
    ['section_timetable', { sectionId: mySection }],
    ['section_attendance_day', { sectionId: mySection }],
    ['student_attendance_month', { studentId: p1 }],
    ['fee_dues', {}],
    ['student_fee_statement', { studentId: p1 }],
    ['list_exams', {}],
    ['report_card_sections', {}],
    ['my_inbox', {}],
  ]
  for (const [name, input] of cases) {
    const outcome = assertDrawable(await run(owner, name, input), name)
    assert.ok(outcome.card, `${name} drew no card`)
    assert.ok(outcome.source, `${name} named no source`)
  }

  const record = assertDrawable(await run(owner, 'student_record', { studentId: p1 }), 'student_record')
  assert.equal(record.card?.kind, 'record')
  assert.equal(record.source?.href, `/students/${p1}`)
  assert.equal((record.forModel as { name: string }).name, 'Riya Tools')

  const sections = assertDrawable(await run(owner, 'find_sections', { name: `T${suffix.slice(0, 3)} A` }), 'find_sections')
  const found = (sections.forModel as { sections: { id: string }[] }).sections
  assert.deepEqual(found.map((row) => row.id), [mySection])
})

test('a list never carries more than 50 rows, and says how many there are', async () => {
  const listed = assertDrawable(await run(owner, 'list_students', { sectionId: bigSection }), 'list_students')
  const table = rowsOf(listed)
  assert.equal(table.rows.length, ASSISTANT_MAX_ROWS)
  assert.equal(table.total, BIG)
  assert.equal((listed.forModel as { pupils: unknown[] }).pupils.length, ASSISTANT_MAX_ROWS)

  const register = assertDrawable(await run(owner, 'section_attendance_day', { sectionId: bigSection }), 'register')
  assert.equal(rowsOf(register).rows.length, ASSISTANT_MAX_ROWS)
  assert.equal(rowsOf(register).total, BIG)
  assert.ok((register.forModel as { pupils: unknown[] }).pupils.length <= ASSISTANT_MAX_ROWS)

  const found = assertDrawable(await run(owner, 'find_students', { query: 'Bulkpupil' }), 'find_students')
  assert.ok(rowsOf(found).rows.length <= ASSISTANT_MAX_ROWS)
  assert.ok((found.forModel as { pupils: unknown[] }).pupils.length <= ASSISTANT_MAX_ROWS)

  const month = assertDrawable(await run(owner, 'section_attendance_month', { sectionId: bigSection }), 'month')
  assert.equal(rowsOf(month).rows.length, ASSISTANT_MAX_ROWS)
  assert.equal(rowsOf(month).total, BIG)

  const dues = assertDrawable(await run(owner, 'fee_dues', { sectionId: bigSection, onlyWithDues: false }), 'fee_dues')
  assert.ok(rowsOf(dues).rows.length <= ASSISTANT_MAX_ROWS)
})

async function created(response: Response): Promise<string> {
  const text = await response.text()
  assert.ok(response.status === 200 || response.status === 201, text)
  return (JSON.parse(text) as { id: string }).id
}

function shift(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`)
  moment.setUTCDate(moment.getUTCDate() + days)
  return moment.toISOString().slice(0, 10)
}

function post(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
}

test('the detail tools read real records: a receipt, an exam, a marks sheet and a message', async () => {
  const base = `/api/schools/${school}`
  // A fee, its amount for the class and one payment.
  const headId = await created(
    await owner.fetch(`${base}/fees/heads`, post({ name: `Tuition ${suffix}`, category: 'tuition', appliesTo: 'class', frequency: 'monthly' })),
  )
  await created(
    await owner.fetch(`${base}/fees/structures`, post({ academicYearId: year, feeHeadId: headId, gradeId: grade, amountPaise: 150_000 })),
  )
  const receiptId = await created(
    await owner.fetch(
      `${base}/fees/students/${p1}/collect`,
      post({ academicYearId: year, lines: [{ feeHeadId: headId, amountPaise: 150_000 }], mode: 'upi', receivedOn: today }),
    ),
  )
  const receipt = assertDrawable(await run(owner, 'fee_receipt', { receiptId }), 'fee_receipt')
  assert.equal(receipt.card?.kind, 'record')
  assert.equal((receipt.forModel as { amountRupees: number }).amountRupees, 1500)
  const statement = assertDrawable(await run(owner, 'student_fee_statement', { studentId: p1 }), 'statement')
  assert.equal((statement.forModel as { totals: { paidRupees: number } }).totals.paidRupees, 1500)
  const receipts = assertDrawable(await run(owner, 'fee_receipts', { studentId: p1 }), 'fee_receipts')
  assert.equal(rowsOf(receipts).rows.length, 1)
  assertDrawable(await run(owner, 'fee_structures', { gradeId: grade }), 'fee_structures')

  // A subject the class studies, then an exam, which lays out its papers.
  const subjectId = randomUUID()
  await adminPool().query(
    `INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,$3,$4,'scholastic')`,
    [subjectId, school, `Science ${suffix}`, `SC${suffix.slice(0, 4)}`],
  )
  await adminPool().query(
    `INSERT INTO grade_subjects(school_id,grade_id,academic_year_id,subject_id) VALUES ($1,$2,$3,$4)`,
    [school, grade, year, subjectId],
  )
  const examId = await created(
    await owner.fetch(
      `${base}/exams`,
      post({ academicYearId: year, kind: 'half_yearly', startsOn: shift(today, -30), endsOn: shift(today, -25), recheckDeadline: shift(today, -20) }),
    ),
  )
  assertDrawable(await run(owner, 'exam_overview', { examId }), 'exam_overview')
  const papers = assertDrawable(await run(owner, 'exam_papers', { examId, sectionId: mySection }), 'exam_papers')
  const paperId = (papers.forModel as { papers: { paperId: string }[] }).papers[0]?.paperId
  assert.ok(paperId, 'the exam laid out no paper for the section')
  const sheet = assertDrawable(await run(owner, 'paper_marks', { paperId }), 'paper_marks')
  assert.equal(rowsOf(sheet).rows.length, 2)
  // A paper of a class the teacher does not teach is not theirs to read.
  const otherPaper = assertDrawable(await run(owner, 'exam_papers', { examId, sectionId: otherSection }), 'exam_papers')
  const otherPaperId = (otherPaper.forModel as { papers: { paperId: string }[] }).papers[0]?.paperId
  assert.ok(otherPaperId)
  assert.equal((await run(teacher, 'paper_marks', { paperId: otherPaperId })).status, 'not_available')

  // A draft notice to the class, read back by its author.
  const messageId = await created(
    await owner.fetch(
      `${base}/messages`,
      post({ audience: { kind: 'section', sectionId: mySection }, title: 'Sports day', body: 'Sports day is on Friday. Wear the house T-shirt.' }),
    ),
  )
  const read = assertDrawable(await run(owner, 'message', { messageId }), 'message')
  assert.equal(read.card?.kind, 'record')
  assert.equal((read.forModel as { title: string }).title, 'Sports day')
  const mine = assertDrawable(await run(owner, 'list_messages', { mine: true }), 'list_messages')
  assert.ok(rowsOf(mine).rows.length >= 1)
  // A parent is not its audience until it is sent, and never its author.
  assert.equal((await run(parent, 'message', { messageId })).status, 'not_available')
})

// ---------------------------------------------------------------------------
// No more than the screen.

test('a teacher gets their own class and nothing about a class they do not teach', async () => {
  const own = assertDrawable(await run(teacher, 'section_attendance_day', { sectionId: mySection }), 'own register')
  const names = (own.forModel as { pupils: { name: string }[] }).pupils.map((row) => row.name).sort()
  assert.deepEqual(names, ['Kabir Tools', 'Riya Tools'])

  for (const [name, input] of [
    ['section_attendance_day', { sectionId: otherSection }],
    ['section_attendance_month', { sectionId: otherSection }],
    ['student_record', { studentId: outsider }],
    ['student_attendance_month', { studentId: outsider }],
    ['section_details', { sectionId: otherSection }],
  ] as const) {
    const outcome = await run(teacher, name, input)
    assert.equal(outcome.status, 'not_available', `${name} for another class answered ${outcome.status}`)
  }

  const search = assertDrawable(await run(teacher, 'find_students', { query: 'Other Family' }), 'teacher search')
  assert.equal((search.forModel as { pupils: unknown[] }).pupils.length, 0)
})

test("a parent gets their own child and nothing about another family's child", async () => {
  const own = assertDrawable(await run(parent, 'student_record', { studentId: p1 }), 'own child')
  assert.equal((own.forModel as { id: string }).id, p1)
  assertDrawable(await run(parent, 'student_attendance_month', { studentId: p1 }), 'own child month')

  for (const [name, input] of [
    ['student_record', { studentId: p2 }],
    ['student_record', { studentId: outsider }],
    ['student_guardian_contacts', { studentId: p2 }],
    ['student_attendance_month', { studentId: p2 }],
    ['student_fee_statement', { studentId: p2 }],
    ['student_results', { studentId: p2 }],
    ['student_report_cards', { studentId: p2 }],
    ['section_attendance_day', { sectionId: otherSection }],
  ] as const) {
    const outcome = await run(parent, name, input)
    assert.equal(outcome.status, 'not_available', `${name} for another child answered ${outcome.status}`)
  }

  // The child's own class register shows the child and no classmate, as the screen does.
  const register = await run(parent, 'section_attendance_day', { sectionId: mySection })
  if (register.status === 'ok') {
    const ids = (register.forModel as { pupils: { studentId: string }[] }).pupils.map((row) => row.studentId)
    assert.ok(!ids.includes(p2), 'a parent saw a classmate on the register')
  } else {
    assert.equal(register.status, 'not_available')
  }
})

test('another school looks like a missing record', async () => {
  // Fixture school A is another school: its pupil is only ever asked about, never written.
  const outcome = await run(owner, 'student_record', { studentId: fixtureIds.studentA as string })
  assert.equal(outcome.status, 'not_available')
})

// ---------------------------------------------------------------------------
// What each person is offered.

function capabilitiesOf(role: keyof typeof ROLE_TEMPLATES): ReadonlySet<PermissionKey> {
  return new Set(ROLE_TEMPLATES[role].grants.map((grant) => grant.permission))
}

test('a teacher is offered no fee tools and a parent no staff register or staff tools', () => {
  const teacherTools = toolsFor(capabilitiesOf('teacher'))
  assert.ok(teacherTools.some((tool) => tool.name === 'section_attendance_day'))
  assert.deepEqual(teacherTools.filter((tool) => tool.permission.startsWith('fees.')).map((tool) => tool.name), [])

  const parentTools = toolsFor(capabilitiesOf('parent'))
  assert.ok(parentTools.some((tool) => tool.name === 'student_fee_statement'))
  assert.deepEqual(
    parentTools.filter((tool) => tool.permission.startsWith('staff_attendance.') || tool.permission.startsWith('staff.')).map((tool) => tool.name),
    [],
  )

  const pupilTools = toolsFor(capabilitiesOf('student'))
  assert.deepEqual(pupilTools.filter((tool) => tool.permission.startsWith('fees.')).map((tool) => tool.name), [])
  assert.ok(toolsFor(capabilitiesOf('owner')).length === READ_TOOLS.length)
})

test('a teacher without the guardian contact key, a parent and a pupil are offered only the pupil detail tools their keys allow', () => {
  const DETAIL = ['student_personal_details', 'student_health', 'student_guardian_contacts']
  const detailNames = (capabilities: ReadonlySet<PermissionKey>) =>
    toolsFor(capabilities).map((tool) => tool.name).filter((name) => DETAIL.includes(name)).sort()

  assert.deepEqual(detailNames(capabilitiesOf('owner')), [...DETAIL].sort())
  assert.deepEqual(detailNames(capabilitiesOf('teacher')), ['student_guardian_contacts'])
  const restricted = new Set(capabilitiesOf('teacher'))
  restricted.delete('students.read_guardian_contact')
  assert.deepEqual(detailNames(restricted), [])
  assert.deepEqual(detailNames(capabilitiesOf('parent')), ['student_guardian_contacts'])
  assert.deepEqual(detailNames(capabilitiesOf('student')), [])
  // The block's key alone is not enough: the route behind it needs read_basic too.
  assert.equal(isOffered(toolNamed('student_health'), new Set<PermissionKey>(['students.read_medical'])), false)
})

test('the starters are only questions the person is offered a tool for', () => {
  for (const role of Object.keys(ROLE_TEMPLATES) as (keyof typeof ROLE_TEMPLATES)[]) {
    const starters = suggestionsFor([role], capabilitiesOf(role))
    if (role !== 'student') assert.ok(starters.length > 0, `${role} has no starters`)
    // Only the office, who may arrange cover, is asked who is free now.
    const office = ['owner', 'principal', 'admin'].includes(role)
    assert.equal(starters.includes('Which teachers are free now?'), office, role)
  }
  const owner = suggestionsFor(['owner'], capabilitiesOf('owner'))
  assert.ok(owner.includes('Which fees are due this month?'))
  // An owner whose fee keys were taken away is not shown the fee question.
  const noFees = new Set([...capabilitiesOf('owner')].filter((key) => !key.startsWith('fees.')))
  assert.ok(!suggestionsFor(['owner'], noFees).includes('Which fees are due this month?'))
  assert.ok(suggestionsFor(['owner'], noFees).includes('Who is absent today?'))
  assert.deepEqual(suggestionsFor(['teacher'], new Set<PermissionKey>()), [])
})

// ---------------------------------------------------------------------------
// The least the model needs.

test('student_record carries the basic record only, even for a person who may read every block', async () => {
  const record = assertDrawable(await run(owner, 'student_record', { studentId: p1 }), 'student_record')
  const forModel = record.forModel as Record<string, unknown>
  assert.equal(forModel.admissionDate, '2018-04-02')
  assert.equal(forModel.gender, 'female')
  for (const key of ['dateOfBirth', 'category', 'admissionType', 'address', 'aadhaarEnding', 'bloodGroup', 'medicalNotes', 'guardians']) {
    assert.ok(!(key in forModel), `student_record gave the model ${key}`)
  }
  const shown = JSON.stringify(record)
  for (const value of ['2012-05-14', 'Pune', '1357', 'B+', 'Peanut', '9876543210', 'Meera']) {
    assert.ok(!shown.includes(value), `student_record carried ${value}`)
  }
})

test('each pupil detail tool returns its own fields and nothing else', async () => {
  const personal = assertDrawable(await run(owner, 'student_personal_details', { studentId: p1 }), 'personal')
  assert.equal(personal.card?.kind, 'record')
  const details = personal.forModel as Record<string, unknown>
  assert.equal(details.dateOfBirth, '2012-05-14')
  assert.equal(details.address, '12 Tools Lane, Pune')
  assert.equal(details.aadhaarEnding, '1357')
  assert.equal(details.category, 'General')
  for (const value of ['B+', 'Peanut', '9876543210', 'Meera']) assert.ok(!JSON.stringify(personal).includes(value), `personal carried ${value}`)

  const health = assertDrawable(await run(owner, 'student_health', { studentId: p1 }), 'health')
  assert.deepEqual(
    Object.keys(health.forModel as object).sort(),
    ['bloodGroup', 'medicalNotes', 'name', 'studentId'],
  )
  assert.equal((health.forModel as { medicalNotes: string }).medicalNotes, 'Peanut allergy')
  for (const value of ['2012-05-14', 'Pune', '1357', '9876543210']) assert.ok(!JSON.stringify(health).includes(value), `health carried ${value}`)

  const contacts = assertDrawable(await run(owner, 'student_guardian_contacts', { studentId: p1 }), 'contacts')
  const guardians = (contacts.forModel as { guardians: { name: string; relation: string; phone: string }[] }).guardians
  assert.ok(guardians.some((row) => row.name === 'Meera Tools' && row.relation === 'mother' && row.phone.endsWith('9876543210')))
  for (const value of ['2012-05-14', 'Pune', '1357', 'B+', 'Peanut']) assert.ok(!JSON.stringify(contacts).includes(value), `contacts carried ${value}`)

  // The route decides: a parent asking for their own child's health block gets nothing from it.
  const parentHealth = assertDrawable(await run(parent, 'student_health', { studentId: p1 }), 'parent health')
  assert.equal((parentHealth.forModel as { health: string }).health, 'not_available')
  assert.equal(parentHealth.card, undefined)
  const parentPersonal = assertDrawable(await run(parent, 'student_personal_details', { studentId: p1 }), 'parent personal')
  assert.equal((parentPersonal.forModel as { personalDetails: string }).personalDetails, 'not_available')
})

// ---------------------------------------------------------------------------
// Answer quality: names, the time now, and saying when a list is not whole.

test('absent_pupils_day names who is not present and the registers not marked, within what the person may read', async (t) => {
  if (new Date(`${today}T00:00:00Z`).getUTCDay() === 0) return t.skip('there is no register on a Sunday')
  const marked = await owner.fetch(
    `/api/schools/${school}/attendance/sections/${mySection}/days/${today}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marks: [{ studentId: p1, mark: 'absent' }, { studentId: p2, mark: 'present' }] }),
    },
  )
  assert.equal(marked.status, 200, await marked.clone().text())

  type Absent = {
    totals: { sections: number; markedSections: number; unmarkedSections: number; notPresent: number }
    unmarkedSections: string[]
    pupils: { studentId: string; name: string; mark: string }[]
    shown: number
    total: number
  }
  const office = assertDrawable(await run(owner, 'absent_pupils_day', {}), 'absent_pupils_day')
  const seen = office.forModel as Absent
  assert.deepEqual(seen.pupils.map((row) => [row.name, row.mark]), [['Riya Tools', 'absent']])
  assert.equal(seen.totals.unmarkedSections, 2, 'the two classes nobody has marked')
  assert.equal(seen.totals.markedSections, 1)
  assert.equal(seen.shown, 1)
  assert.equal(seen.total, 1)
  const card = rowsOf(office)
  assert.equal(card.rows.length, 2, 'one pupil and one line for the registers not marked')
  assert.deepEqual(card.rows.at(-1)?.cells.mark, { type: 'tag', value: 'Not marked' })

  const own = assertDrawable(await run(teacher, 'absent_pupils_day', {}), 'teacher absent_pupils_day')
  const mine = own.forModel as Absent
  assert.deepEqual(mine.pupils.map((row) => row.studentId), [p1])
  assert.deepEqual(mine.unmarkedSections, [], 'a teacher is not told about classes they do not teach')

  // The per-class counts say how many registers are not marked, in so many words.
  const counts = assertDrawable(await run(owner, 'attendance_sections_day', {}), 'attendance_sections_day')
  assert.equal((counts.forModel as { totals: { unmarkedSections: number } }).totals.unmarkedSections, 2)
})

test('free_teachers without a period reads the period running now from the bell schedule', async (t) => {
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay()
  if (weekday === 0) return t.skip('there are no lessons on a Sunday')
  await adminPool().query(
    `INSERT INTO bell_schedules(id,school_id,academic_year_id,name,grade_ids,working_days,periods)
     VALUES ($1,$2,$3,$4,'{}'::uuid[],ARRAY[1,2,3,4,5,6]::smallint[],$5::jsonb)`,
    [
      randomUUID(),
      school,
      year,
      `Bell ${suffix}`,
      JSON.stringify([
        { index: 0, name: 'Assembly', startTime: '08:00', endTime: '08:15', type: 'assembly' },
        { index: 1, name: 'Period 1', startTime: '08:15', endTime: '09:00', type: 'period' },
        { index: 2, name: 'Period 2', startTime: '09:00', endTime: '09:45', type: 'period' },
        { index: 3, name: 'Break', startTime: '09:45', endTime: '10:00', type: 'break' },
        { index: 4, name: 'Period 3', startTime: '10:00', endTime: '10:45', type: 'period' },
      ]),
    ],
  )

  const during = assertDrawable(await run(owner, 'free_teachers', {}, '09:10'), 'free now')
  const found = during.forModel as { periodIndex: number; now: string; teachers: unknown[] }
  assert.equal(found.periodIndex, 2, 'at 09:10 it is Period 2')
  assert.equal(found.now, '09:10')
  assert.equal(during.card?.kind, 'table')

  const breakTime = assertDrawable(await run(owner, 'free_teachers', {}, '09:50'), 'at break')
  const onBreak = breakTime.forModel as { noPeriodNow: boolean; note: string; nextPeriod: { periodIndex: number; startsAt: string } }
  assert.equal(onBreak.noPeriodNow, true)
  assert.match(onBreak.note, /Break/)
  assert.deepEqual([onBreak.nextPeriod.periodIndex, onBreak.nextPeriod.startsAt], [4, '10:00'])

  const early = (assertDrawable(await run(owner, 'free_teachers', {}, '07:30'), 'early').forModel as { note: string; nextPeriod: { periodIndex: number } })
  assert.match(early.note, /not started/)
  assert.equal(early.nextPeriod.periodIndex, 1)
  const late = assertDrawable(await run(owner, 'free_teachers', {}, '16:00'), 'late').forModel as { note: string; nextPeriod?: unknown }
  assert.match(late.note, /over for the day/)
  assert.equal(late.nextPeriod, undefined)

  // Another day, or no clock: the tool asks which period rather than guess.
  const otherDay = assertDrawable(await run(owner, 'free_teachers', { date: shift(today, -7) }, '09:10'), 'another day')
  assert.equal((otherDay.forModel as { needs: string }).needs, 'periodIndex')
  const noClock = assertDrawable(await run(owner, 'free_teachers', {}), 'no clock')
  assert.equal((noClock.forModel as { needs: string }).needs, 'periodIndex')
})

test('a name written in Devanagari is answered with a request for English letters, not an empty search', async () => {
  for (const name of ['find_students', 'find_staff', 'search_school']) {
    const outcome = assertDrawable(await run(owner, name, { query: 'रिया' }), name)
    const told = outcome.forModel as { found: string; hint: string }
    assert.equal(told.found, 'nothing')
    assert.match(told.hint, /English letters/)
    assert.equal(outcome.card, undefined)
  }
})

test('fee_dues tells the model its rows are sorted by balance, highest first', async () => {
  const dues = assertDrawable(await run(owner, 'fee_dues', { onlyWithDues: false }), 'fee_dues')
  const told = dues.forModel as { sortedBy: string; shown: number; total: number; pupils: { balanceRupees: number }[] }
  assert.equal(told.sortedBy, 'balance, highest first')
  assert.equal(told.shown, told.pupils.length)
  const balances = told.pupils.map((row) => row.balanceRupees)
  assert.deepEqual(balances, [...balances].sort((a, b) => b - a))
})
