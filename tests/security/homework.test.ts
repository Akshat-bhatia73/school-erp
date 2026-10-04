/**
 * Matrix rows: homework (Task 25).
 *
 * The adversarial half of the homework module. The module's own suite proves
 * the figures and the windows; this file asks who may read an item, a file
 * or a pupil's check-off, and who may set or check one. A teacher reaches
 * their own section and subject (or, as class teacher, their own class's
 * general items) and nothing beside it; a family reads its own child's items
 * and status in every year, never another family's; a pupil reads their own;
 * the accountant reads nothing; a removed item is gone for families; a file
 * downloads only after a fresh decision; and an id from the school next door
 * answers exactly like an id that was never real.
 *
 * Every refusal is measured twice: the answer it gave, and a fingerprint of
 * the homework tables, which a refusal may never change. Every date is worked
 * out from the school's own today, so the file passes on any day of the week.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  clientFor,
  closeAdminPool,
  closeRateLimitPool,
  resetRateLimits,
  seedDatabaseFixtures,
  setFixturePassword,
  startTestServer,
  type TestServer,
} from '../../apps/api/tests/harness.ts'
import {
  PASSWORD,
  bumpAccessVersion,
  body,
  codeOf,
  createMember,
  forgetTwoFactor,
  grantPortalAccess,
  signInMember,
  signInOffice,
  type Client,
} from './support.ts'

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const ownerA = fixtureIds.ownerA as string
const ownerBMembership = fixtureIds.ownerB as string
const studentB = fixtureIds.studentB as string
const SCHOOL_CODE = 'fixture-a'

const suffix = randomUUID().slice(0, 8)
/** Every word a person types in this file carries this marker, so the audit sweep can find it. */
const MARK = `HWSEC${suffix}`

// School A: this year, and last year the children were promoted out of.
const year = randomUUID()
const lastYear = randomUUID()
const grade = randomUUID()
const sectionOne = randomUUID()
const sectionTwo = randomUUID()
const lastSection = randomUUID()
const maths = randomUUID()
const science = randomUUID()

const child = randomUUID()
const stranger = randomUUID()
const otherPupil = randomUUID()
const lateJoiner = randomUUID()
const admission: Record<string, string> = {}

// Items. Past ones are written with the migrator: the API only sets today.
const item = {
  lastMaths: randomUUID(),
  oldMaths: randomUUID(),
  general: randomUUID(),
  scienceTwo: randomUUID(),
  mathsTwo: randomUUID(),
  removed: randomUUID(),
  afterLate: '',
}
const files: Record<string, string> = {}

// School B's rows. None of them is ever reachable through school A's paths.
const yearB = randomUUID()
const gradeB = randomUUID()
const sectionB = randomUUID()
const subjectB = randomUUID()
const itemB = randomUUID()
const fileB = randomUUID()

let server: TestServer
let office: Client
let ownerB: Client
let accountant: Client
let subjectTeacher: Client
let classTeacher: Client
let otherTeacher: Client
let parent: Client
let strangerParent: Client
let lateParent: Client
let pupil: Client
let accountantMembershipId = ''
let parentMembershipId = ''
let parentGuardianId = ''
let subjectTeacherMembershipId = ''
let subjectStaffId = ''
const mfaUserIds: string[] = []

let today = ''
let yearStart = ''
let lastStart = ''
let lastEnd = ''

interface Ref {
  id: string
  name: string
}
interface ChildStatus {
  student: Ref
  status: string
  remark?: string
}
interface Item {
  id: string
  version: number
  section: Ref
  subject?: Ref
  removedAt?: string
  progress?: unknown
  child?: ChildStatus
  allowedActions: string[]
}
interface Detail extends Item {
  attachments: { id: string }[]
  checkWindow?: unknown
  children?: ChildStatus[]
}
interface ListResponse {
  items: Item[]
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')

function shift(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`)
  moment.setUTCDate(moment.getUTCDate() + days)
  return moment.toISOString().slice(0, 10)
}

function send(method: string, value: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
}

const at = (schoolId: string) => `/api/schools/${schoolId}/homework`

function uploadInit(bytes: Uint8Array = PDF): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: new Blob([Buffer.from(bytes)]) }
}

/** A response with its request id taken out, so two answers can be compared. */
async function answer(response: Response): Promise<string> {
  const text = await response.text()
  return `${response.status} ${text.replace(/"requestId":"[^"]*"/g, '')}`
}

/** Every homework table of a school, as one fingerprint. */
async function fingerprint(schoolId: string): Promise<string> {
  const found = await adminPool().query<{ fingerprint: string }>(
    `SELECT concat_ws('/',
       (SELECT count(*) FROM homework WHERE school_id = $1),
       (SELECT COALESCE(sum(version), 0) FROM homework WHERE school_id = $1),
       (SELECT count(*) FROM homework WHERE school_id = $1 AND removed_at IS NOT NULL),
       (SELECT count(*) FROM homework_attachments WHERE school_id = $1),
       (SELECT count(*) FROM homework_checks WHERE school_id = $1),
       (SELECT COALESCE(sum(version), 0) FROM homework_checks WHERE school_id = $1),
       (SELECT count(*) FROM export_jobs WHERE school_id = $1)) AS fingerprint`,
    [schoolId],
  )
  return found.rows[0]?.fingerprint ?? ''
}

async function deniedRows(membershipId: string): Promise<number> {
  const found = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events
      WHERE school_id = $1 AND actor_membership_id = $2 AND result = 'denied' AND action LIKE 'homework.%'`,
    [schoolA, membershipId],
  )
  return Number(found.rows[0]?.count)
}

async function insertItem(input: {
  id: string
  schoolId?: string
  yearId: string
  sectionId: string
  subjectId: string | null
  setOn: string
  dueOn: string
  title: string
  author?: string
}): Promise<void> {
  await adminPool().query(
    `INSERT INTO homework (id, school_id, academic_year_id, section_id, subject_id, title, instructions, set_on, due_on,
                           created_by_membership_id, updated_by_membership_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    [
      input.id,
      input.schoolId ?? schoolA,
      input.yearId,
      input.sectionId,
      input.subjectId,
      input.title,
      `${MARK} instructions for ${input.title}`,
      input.setOn,
      input.dueOn,
      input.author ?? ownerA,
    ],
  )
}

async function insertCheck(
  itemId: string,
  studentId: string,
  status: string,
  remark: string | null,
  schoolId = schoolA,
  author = ownerA,
): Promise<void> {
  await adminPool().query(
    `INSERT INTO homework_checks (school_id, homework_id, student_id, academic_year_id, section_id, subject_id, status,
                                  remark, checked_by_membership_id)
     SELECT school_id, id, $3, academic_year_id, section_id, subject_id, $4, $5, $6
       FROM homework WHERE school_id = $1 AND id = $2`,
    [schoolId, itemId, studentId, status, remark, author],
  )
}

async function staffRow(label: string): Promise<string> {
  const id = randomUUID()
  await adminPool().query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status,joining_date)
     VALUES ($1,$2,$3,$4,'teaching','Teacher','active',$5)`,
    [id, schoolA, `SEC-HW-${suffix}-${label}`, `Security ${label}`, lastStart],
  )
  return id
}

async function teacherWith(
  label: string,
  assignments: readonly { sectionId: string; subjectId: string }[],
  classOf?: string,
): Promise<{ client: Client; membershipId: string; staffId: string }> {
  const pool = adminPool()
  const member = await createMember(schoolA, ['teacher'], `Homework ${label}`)
  const staffId = await staffRow(label)
  await pool.query('INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)', [
    schoolA,
    member.membershipId,
    staffId,
  ])
  for (const assignment of assignments) {
    await pool.query(
      `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [schoolA, staffId, year, assignment.sectionId, assignment.subjectId, yearStart],
    )
  }
  if (classOf !== undefined) {
    await pool.query('UPDATE sections SET class_teacher_staff_id = $2 WHERE id = $1', [classOf, staffId])
  }
  await resetRateLimits()
  return { client: await signInMember(server, member), membershipId: member.membershipId, staffId }
}

async function parentOf(studentId: string, label: string) {
  const member = await createMember(schoolA, ['parent'], `Homework ${label}`)
  const { guardianId } = await grantPortalAccess({
    schoolId: schoolA,
    membershipId: member.membershipId,
    studentId,
    approvedBy: ownerA,
  })
  await resetRateLimits()
  return { client: await signInMember(server, member), membershipId: member.membershipId, guardianId }
}

async function officeMember(schoolId: string, roles: readonly string[], label: string) {
  const member = await createMember(schoolId, roles, label)
  await setFixturePassword(server, member.userId, PASSWORD)
  mfaUserIds.push(member.userId)
  await resetRateLimits()
  return { client: await signInOffice(server, member), membershipId: member.membershipId }
}

/** A pupil's own login, made as issuance makes it, signed in through the pupil's door. */
async function pupilLogin(studentId: string): Promise<Client> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  await pool.query(`INSERT INTO auth_user(id,name,email) VALUES ($1::uuid,'Pupil',$1::text || '@student.invalid')`, [
    userId,
  ])
  await setFixturePassword(server, userId, PASSWORD)
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'student','active')`,
    [membershipId, schoolA, userId],
  )
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = 'student'`,
    [schoolA, membershipId],
  )
  await pool.query(`INSERT INTO membership_student_links(school_id,membership_id,student_id) VALUES ($1,$2,$3)`, [
    schoolA,
    membershipId,
    studentId,
  ])
  await resetRateLimits()
  const client = clientFor(server)
  const response = await client.fetch(
    '/api/student-sign-in',
    send('POST', { schoolCode: SCHOOL_CODE, admissionNumber: admission[studentId], password: PASSWORD }),
  )
  assert.equal(response.status, 200, await response.text())
  return client as unknown as Client
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()
  const found = await pool.query<{ today: string }>(
    `SELECT to_char((now() AT TIME ZONE COALESCE(NULLIF(timezone, ''), 'Asia/Kolkata'))::date, 'YYYY-MM-DD') AS today
       FROM schools WHERE id = $1`,
    [schoolA],
  )
  today = found.rows[0]?.today ?? ''
  yearStart = shift(today, -300)
  lastStart = shift(today, -665)
  lastEnd = shift(today, -301)

  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,$4,$5,'upcoming'),($6,$2,$7,$8,$9,'closed')`,
    [year, schoolA, `SEC-HW-${suffix}`, yearStart, shift(today, 200), lastYear, `SEC-HW-OLD-${suffix}`, lastStart, lastEnd],
  )
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,13)`, [
    grade,
    schoolA,
    `Sec homework ${suffix}`,
    `SH${suffix.slice(0, 3)}`,
  ])
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name)
     VALUES ($1,$2,$3,$4,$5),($6,$2,$3,$4,$7),($8,$2,$9,$4,$10)`,
    [
      sectionOne, schoolA, year, grade, `HA-${suffix.slice(0, 4)}`,
      sectionTwo, `HB-${suffix.slice(0, 4)}`,
      lastSection, lastYear, `HO-${suffix.slice(0, 4)}`,
    ],
  )
  for (const [id, name] of [
    [maths, 'Maths'],
    [science, 'Science'],
  ] as const) {
    await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,$3,$4,'scholastic')`, [
      id,
      schoolA,
      `${name} ${suffix}`,
      `SH${name.slice(0, 2)}${suffix}`,
    ])
    await pool.query(`INSERT INTO grade_subjects(school_id,grade_id,academic_year_id,subject_id) VALUES ($1,$2,$3,$4)`, [
      schoolA,
      grade,
      year,
      id,
    ])
  }
  await pool.query(`INSERT INTO grade_subjects(school_id,grade_id,academic_year_id,subject_id) VALUES ($1,$2,$3,$4)`, [
    schoolA,
    grade,
    lastYear,
    maths,
  ])

  // The child and the stranger sat last year's class together and were both
  // promoted into section one. The other pupil sits in section two; the late
  // joiner came to section one five days ago.
  for (const [index, [pupilId, name]] of ([
    [child, 'Sec Hw Child'],
    [stranger, 'Sec Hw Stranger'],
    [otherPupil, 'Sec Hw Other'],
    [lateJoiner, 'Sec Hw Late'],
  ] as const).entries()) {
    admission[pupilId] = `SH/${suffix}/${index + 1}`
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,status) VALUES ($1,$2,$3,$4,'active')`,
      [pupilId, schoolA, admission[pupilId], name],
    )
  }
  for (const [index, pupilId] of [child, stranger].entries()) {
    await pool.query(
      `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on,left_on,outcome)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'promoted'),
              (gen_random_uuid(),$1,$2,$8,$9,$5,$10,NULL,'ongoing')`,
      [schoolA, pupilId, lastYear, lastSection, index + 1, lastStart, lastEnd, year, sectionOne, yearStart],
    )
  }
  await pool.query(
    `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,1,$5),(gen_random_uuid(),$1,$6,$3,$7,3,$8)`,
    [schoolA, otherPupil, year, sectionTwo, yearStart, lateJoiner, sectionOne, shift(today, -5)],
  )

  // Last year's maths, checked off then, for both promoted pupils.
  await insertItem({
    id: item.lastMaths,
    yearId: lastYear,
    sectionId: lastSection,
    subjectId: maths,
    setOn: shift(lastStart, 10),
    dueOn: shift(lastStart, 12),
    title: `${MARK} last year maths`,
  })
  await insertCheck(item.lastMaths, child, 'not_done', `${MARK} last child remark`)
  await insertCheck(item.lastMaths, stranger, 'done', `${MARK} last stranger remark`)
  // This year's: maths in section one due eight days ago (the teacher may still check it).
  await insertItem({
    id: item.oldMaths,
    yearId: year,
    sectionId: sectionOne,
    subjectId: maths,
    setOn: shift(today, -10),
    dueOn: shift(today, -8),
    title: `${MARK} old maths`,
  })
  // General homework in section one, set before the late joiner came, due today.
  await insertItem({
    id: item.general,
    yearId: year,
    sectionId: sectionOne,
    subjectId: null,
    setOn: shift(today, -10),
    dueOn: today,
    title: `${MARK} general`,
  })
  await insertItem({
    id: item.scienceTwo,
    yearId: year,
    sectionId: sectionTwo,
    subjectId: science,
    setOn: shift(today, -3),
    dueOn: shift(today, 2),
    title: `${MARK} science two`,
  })
  await insertItem({
    id: item.mathsTwo,
    yearId: year,
    sectionId: sectionTwo,
    subjectId: maths,
    setOn: shift(today, -3),
    dueOn: today,
    title: `${MARK} maths two`,
  })
  // Maths in section one, removed later in this file.
  await insertItem({
    id: item.removed,
    yearId: year,
    sectionId: sectionOne,
    subjectId: maths,
    setOn: shift(today, -6),
    dueOn: shift(today, -1),
    title: `${MARK} to be removed`,
  })

  // School B: a class, a pupil, an item, a file and a check-off.
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status) VALUES ($1,$2,$3,$4,$5,'upcoming')`,
    [yearB, schoolB, `SEC-HW-B-${suffix}`, yearStart, shift(today, 200)],
  )
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,13)`, [
    gradeB,
    schoolB,
    `Sec homework B ${suffix}`,
    `SI${suffix.slice(0, 3)}`,
  ])
  await pool.query(`INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,$5)`, [
    sectionB,
    schoolB,
    yearB,
    gradeB,
    `HB-${suffix.slice(0, 4)}`,
  ])
  await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,$3,$4,'scholastic')`, [
    subjectB,
    schoolB,
    `B maths ${suffix}`,
    `SHB${suffix}`,
  ])
  await pool.query(`INSERT INTO grade_subjects(school_id,grade_id,academic_year_id,subject_id) VALUES ($1,$2,$3,$4)`, [
    schoolB,
    gradeB,
    yearB,
    subjectB,
  ])
  await pool.query(
    `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,1,$5)`,
    [schoolB, studentB, yearB, sectionB, yearStart],
  )
  await insertItem({
    id: itemB,
    schoolId: schoolB,
    yearId: yearB,
    sectionId: sectionB,
    subjectId: subjectB,
    setOn: shift(today, -10),
    dueOn: shift(today, -8),
    title: `${MARK} school B`,
    author: ownerBMembership,
  })
  await pool.query(
    `INSERT INTO homework_attachments(id,school_id,homework_id,file_name,content_type,size_bytes,storage_key,
                                      created_by_membership_id)
     VALUES ($1,$2,$3,'b.pdf','application/pdf',$4,$5,$6)`,
    [fileB, schoolB, itemB, PDF.length, `homework/${schoolB}/${itemB}/security${suffix}`, ownerBMembership],
  )
  await insertCheck(itemB, studentB, 'not_done', `${MARK} school B remark`, schoolB, ownerBMembership)

  // The people. The subject teacher teaches maths in section one; the class
  // teacher of section one teaches nothing; the other teacher teaches science
  // in section two.
  const subject = await teacherWith('subject', [{ sectionId: sectionOne, subjectId: maths }])
  subjectTeacher = subject.client
  subjectTeacherMembershipId = subject.membershipId
  subjectStaffId = subject.staffId
  classTeacher = (await teacherWith('class', [], sectionOne)).client
  otherTeacher = (await teacherWith('other', [{ sectionId: sectionTwo, subjectId: science }])).client

  office = (await officeMember(schoolA, ['principal'], 'Homework Office')).client
  const accountantMember = await officeMember(schoolA, ['accountant'], 'Homework Accountant')
  accountant = accountantMember.client
  accountantMembershipId = accountantMember.membershipId
  ownerB = (await officeMember(schoolB, ['owner'], 'Homework Owner B')).client

  const parentMember = await parentOf(child, 'Parent')
  parent = parentMember.client
  parentMembershipId = parentMember.membershipId
  parentGuardianId = parentMember.guardianId
  strangerParent = (await parentOf(stranger, 'Other Parent')).client
  lateParent = (await parentOf(lateJoiner, 'Late Parent')).client
  pupil = await pupilLogin(stranger)

  // Files, uploaded through the route: one on the old maths item, one on the
  // item that will be removed.
  for (const key of ['oldMaths', 'removed'] as const) {
    const response = await office.fetch(`${at(schoolA)}/${item[key]}/attachments?expectedVersion=1&fileName=sheet.pdf`, uploadInit())
    assert.equal(response.status, 200, await response.clone().text())
    files[key] = (await body<Detail>(response)).attachments[0]!.id
  }
  // General homework set today by the office, after the late joiner came.
  const set = await office.fetch(
    at(schoolA),
    send('POST', { sectionId: sectionOne, title: `${MARK} after late`, dueOn: shift(today, 1) }),
  )
  assert.equal(set.status, 201, await set.clone().text())
  item.afterLate = (await body<Detail>(set)).id
})

after(async () => {
  await forgetTwoFactor(mfaUserIds)
  await server.close()
  await closeRateLimitPool()
  await closeAdminPool()
})

interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  init?: RequestInit
}

/** Every route that names one item, with the given item and file ids. */
function itemRoutes(id: string, fileId: string, studentId = child): Route[] {
  return [
    { method: 'GET', path: `/${id}` },
    { method: 'PATCH', path: `/${id}`, init: send('PATCH', { expectedVersion: 1, title: `${MARK} changed` }) },
    { method: 'POST', path: `/${id}/remove`, init: send('POST', { expectedVersion: 1, reason: `${MARK} reason` }) },
    { method: 'POST', path: `/${id}/attachments?expectedVersion=1&fileName=x.pdf`, init: uploadInit() },
    { method: 'GET', path: `/${id}/attachments/${fileId}` },
    { method: 'DELETE', path: `/${id}/attachments/${fileId}?expectedVersion=1`, init: { method: 'DELETE' } },
    { method: 'GET', path: `/${id}/checks` },
    {
      method: 'PUT',
      path: `/${id}/checks`,
      init: send('PUT', { entries: [{ studentId, status: 'done', expectedVersion: 0 }] }),
    },
  ]
}

/** The routes that name no item. */
function schoolRoutes(): Route[] {
  return [
    { method: 'GET', path: '' },
    { method: 'GET', path: `/report?from=${shift(today, -30)}&to=${today}` },
    {
      method: 'POST',
      path: '',
      init: send('POST', { sectionId: sectionOne, subjectId: maths, title: `${MARK} set`, dueOn: today }),
    },
  ]
}

function call(client: Client, schoolId: string, route: Route): Promise<Response> {
  return client.fetch(`${at(schoolId)}${route.path}`, route.init ?? {})
}

// ---------------------------------------------------------------------------
// Another school.

test('[homework] the owner of school B is refused on every homework route of school A', async () => {
  const beforeA = await fingerprint(schoolA)
  const beforeB = await fingerprint(schoolB)
  const routes = [...schoolRoutes(), ...itemRoutes(item.oldMaths, files.oldMaths!)]
  for (const route of routes) {
    const response = await call(ownerB, schoolA, route)
    assert.equal(response.status, 403, `${route.method} ${route.path}: ${await response.clone().text()}`)
    assert.equal(await codeOf(response), 'SCHOOL_ACCESS_UNAVAILABLE', `${route.method} ${route.path}`)
  }
  // The permitted half: the same owner reads school B's own homework.
  const own = await ownerB.fetch(`${at(schoolB)}/${itemB}`)
  assert.equal(own.status, 200, await own.clone().text())
  assert.equal(await fingerprint(schoolA), beforeA, 'nothing of school A moved')
  assert.equal(await fingerprint(schoolB), beforeB, 'nothing of school B moved')
})

test('[homework] school A’s ids, named in school B, answer exactly like ids that were never real', async () => {
  const beforeA = await fingerprint(schoolA)
  const beforeB = await fingerprint(schoolB)
  const invented = randomUUID()
  const inventedAnswers: string[] = []
  for (const route of itemRoutes(invented, invented, invented)) inventedAnswers.push(await answer(await call(ownerB, schoolB, route)))
  for (const [id, fileId] of [
    [item.oldMaths, files.oldMaths!],
    [item.removed, files.removed!],
    [item.lastMaths, files.oldMaths!],
  ] as const) {
    for (const [index, route] of itemRoutes(id, fileId, invented).entries()) {
      const text = await answer(await call(ownerB, schoolB, route))
      assert.equal(
        text.replaceAll(id, invented).replaceAll(fileId, invented),
        inventedAnswers[index],
        `${route.method} ${route.path} told school A’s id apart from an invented one`,
      )
      assert.ok(!text.includes(MARK), `${route.method} ${route.path} leaked school A’s words`)
    }
  }
  // School B's own item, with school A's file: the file is simply not there.
  assert.equal(
    await answer(await ownerB.fetch(`${at(schoolB)}/${itemB}/attachments/${files.oldMaths}`)),
    await answer(await ownerB.fetch(`${at(schoolB)}/${itemB}/attachments/${invented}`)),
  )
  // School A's section, subject, pupil and year in school B's list.
  const filters = [`sectionId=${sectionOne}`, `subjectId=${maths}`, `studentId=${child}`, `academicYearId=${year}`]
  for (const filter of filters) {
    const theirs = await answer(await ownerB.fetch(`${at(schoolB)}?${filter}`))
    const none = await answer(await ownerB.fetch(`${at(schoolB)}?${filter.split('=')[0]}=${invented}`))
    assert.equal(theirs, none, filter)
    assert.ok(!theirs.includes(item.oldMaths), filter)
  }
  for (const filter of [`sectionId=${sectionOne}`, `subjectId=${maths}`, `academicYearId=${year}`]) {
    const report = `/report?from=${shift(today, -30)}&to=${today}`
    const theirs = await answer(await ownerB.fetch(`${at(schoolB)}${report}&${filter}`))
    const none = await answer(await ownerB.fetch(`${at(schoolB)}${report}&${filter.split('=')[0]}=${invented}`))
    assert.equal(theirs, none, filter)
  }
  const setForeign = await answer(
    await ownerB.fetch(at(schoolB), send('POST', { sectionId: sectionOne, title: `${MARK} x`, dueOn: today })),
  )
  const setInvented = await answer(
    await ownerB.fetch(at(schoolB), send('POST', { sectionId: invented, title: `${MARK} x`, dueOn: today })),
  )
  assert.equal(setForeign, setInvented)
  const subjectForeign = await answer(
    await ownerB.fetch(at(schoolB), send('POST', { sectionId: sectionB, subjectId: maths, title: `${MARK} x`, dueOn: today })),
  )
  const subjectInvented = await answer(
    await ownerB.fetch(at(schoolB), send('POST', { sectionId: sectionB, subjectId: invented, title: `${MARK} x`, dueOn: today })),
  )
  assert.equal(subjectForeign, subjectInvented)
  // School A's pupil on school B's own sheet is not on the roster, like anyone invented.
  const pupilForeign = await answer(
    await ownerB.fetch(
      `${at(schoolB)}/${itemB}/checks`,
      send('PUT', { entries: [{ studentId: child, status: 'done', expectedVersion: 0 }] }),
    ),
  )
  const pupilInvented = await answer(
    await ownerB.fetch(
      `${at(schoolB)}/${itemB}/checks`,
      send('PUT', { entries: [{ studentId: invented, status: 'done', expectedVersion: 0 }] }),
    ),
  )
  assert.equal(pupilForeign, pupilInvented)
  assert.match(pupilForeign, /homework_pupil_not_on_roster/)

  assert.equal(await fingerprint(schoolA), beforeA, 'nothing of school A moved')
  assert.equal(await fingerprint(schoolB), beforeB, 'nothing of school B moved')
})

test('[homework] school B’s ids, named in school A by its office, answer like ids that were never real', async () => {
  const beforeA = await fingerprint(schoolA)
  const beforeB = await fingerprint(schoolB)
  const invented = randomUUID()
  const inventedAnswers: string[] = []
  for (const route of itemRoutes(invented, invented, invented)) inventedAnswers.push(await answer(await call(office, schoolA, route)))
  for (const [index, route] of itemRoutes(itemB, fileB, invented).entries()) {
    const text = await answer(await call(office, schoolA, route))
    assert.equal(text, inventedAnswers[index], `${route.method} ${route.path} told school B’s item apart`)
    assert.ok(!text.includes(`${MARK} school B`), `${route.method} ${route.path} leaked school B’s words`)
  }
  // School B's file named on school A's own item.
  const ownItemForeignFile = await answer(await office.fetch(`${at(schoolA)}/${item.oldMaths}/attachments/${fileB}`))
  const ownItemInventedFile = await answer(await office.fetch(`${at(schoolA)}/${item.oldMaths}/attachments/${invented}`))
  assert.equal(ownItemForeignFile, ownItemInventedFile)
  // School B's pupil on school A's sheet.
  const pupilForeign = await answer(
    await office.fetch(
      `${at(schoolA)}/${item.oldMaths}/checks`,
      send('PUT', { entries: [{ studentId: studentB, status: 'done', expectedVersion: 0 }] }),
    ),
  )
  const pupilInvented = await answer(
    await office.fetch(
      `${at(schoolA)}/${item.oldMaths}/checks`,
      send('PUT', { entries: [{ studentId: invented, status: 'done', expectedVersion: 0 }] }),
    ),
  )
  assert.equal(pupilForeign, pupilInvented)
  // School B's section and subject in school A's list.
  for (const key of ['sectionId', 'subjectId', 'studentId', 'academicYearId'] as const) {
    const foreign = { sectionId: sectionB, subjectId: subjectB, studentId: studentB, academicYearId: yearB }[key]
    assert.equal(
      await answer(await office.fetch(`${at(schoolA)}?${key}=${foreign}`)),
      await answer(await office.fetch(`${at(schoolA)}?${key}=${invented}`)),
      key,
    )
  }
  assert.equal(await fingerprint(schoolA), beforeA)
  assert.equal(await fingerprint(schoolB), beforeB)
})

// ---------------------------------------------------------------------------
// The accountant.

test('[homework] the accountant is refused on every homework route', async () => {
  const before = await fingerprint(schoolA)
  const denials = await deniedRows(accountantMembershipId)
  const routes = [...schoolRoutes(), ...itemRoutes(item.oldMaths, files.oldMaths!)]
  for (const route of routes) {
    const response = await call(accountant, schoolA, route)
    assert.equal(response.status, 403, `${route.method} ${route.path}: ${await response.clone().text()}`)
    assert.equal(await codeOf(response), 'ACCESS_DENIED', `${route.method} ${route.path}`)
  }
  assert.equal(await fingerprint(schoolA), before)
  assert.ok((await deniedRows(accountantMembershipId)) > denials, 'the refusals are on the record')
})

// ---------------------------------------------------------------------------
// The wrong teacher.

test('[homework] a teacher of another class reaches nothing of section one', async () => {
  const before = await fingerprint(schoolA)
  for (const id of [item.oldMaths, item.general, item.removed, item.afterLate]) {
    for (const route of itemRoutes(id, id === item.oldMaths ? files.oldMaths! : files.removed!)) {
      const response = await call(otherTeacher, schoolA, route)
      assert.equal(response.status, 404, `${route.method} ${route.path}: ${await response.clone().text()}`)
      assert.equal(await codeOf(response), 'RESOURCE_NOT_FOUND')
    }
  }
  const set = await otherTeacher.fetch(
    at(schoolA),
    send('POST', { sectionId: sectionOne, subjectId: science, title: `${MARK} not mine`, dueOn: today }),
  )
  assert.equal(set.status, 403, await set.clone().text())
  const general = await otherTeacher.fetch(at(schoolA), send('POST', { sectionId: sectionTwo, title: `${MARK} g`, dueOn: today }))
  assert.equal(general.status, 403, 'a subject teacher is no class teacher')
  const report = await body<{ sets: { section: Ref }[]; repeatedNotDone: { student: Ref }[] }>(
    await otherTeacher.fetch(`${at(schoolA)}/report?from=${shift(today, -30)}&to=${shift(today, 30)}`),
  )
  assert.ok(report.sets.every((row) => row.section.id !== sectionOne), 'the report holds only their own scope')
  assert.equal(await fingerprint(schoolA), before)
})

test('[homework] a subject teacher reaches their subject in their section, and no general item or other section', async () => {
  const before = await fingerprint(schoolA)
  // The general item of their section, and maths in the section next door.
  for (const id of [item.general, item.afterLate, item.mathsTwo]) {
    for (const route of itemRoutes(id, files.oldMaths!)) {
      const response = await call(subjectTeacher, schoolA, route)
      assert.equal(response.status, 404, `${route.method} ${route.path}: ${await response.clone().text()}`)
    }
  }
  const general = await subjectTeacher.fetch(at(schoolA), send('POST', { sectionId: sectionOne, title: `${MARK} g`, dueOn: today }))
  assert.equal(general.status, 403, await general.clone().text())
  assert.equal(await codeOf(general), 'ACCESS_DENIED')
  const nextDoor = await subjectTeacher.fetch(
    at(schoolA),
    send('POST', { sectionId: sectionTwo, subjectId: maths, title: `${MARK} next door`, dueOn: today }),
  )
  assert.equal(nextDoor.status, 403, await nextDoor.clone().text())
  const otherSubject = await subjectTeacher.fetch(
    at(schoolA),
    send('POST', { sectionId: sectionOne, subjectId: science, title: `${MARK} science`, dueOn: today }),
  )
  assert.equal(otherSubject.status, 403, await otherSubject.clone().text())
  assert.equal(await fingerprint(schoolA), before)

  // The permitted half: their own maths.
  const mine = await subjectTeacher.fetch(`${at(schoolA)}/${item.oldMaths}`)
  assert.equal(mine.status, 200, await mine.clone().text())
})

test('[homework] the class teacher reads every item of the class but sets and checks no subject item', async () => {
  const before = await fingerprint(schoolA)
  const read = await body<Detail>(await classTeacher.fetch(`${at(schoolA)}/${item.oldMaths}`))
  assert.equal(read.id, item.oldMaths)
  assert.deepEqual(read.allowedActions, ['homework.read'])
  assert.equal(read.checkWindow, undefined)
  const set = await classTeacher.fetch(
    at(schoolA),
    send('POST', { sectionId: sectionOne, subjectId: maths, title: `${MARK} subject`, dueOn: today }),
  )
  assert.equal(set.status, 403, await set.clone().text())
  for (const route of itemRoutes(item.oldMaths, files.oldMaths!).filter((entry) => entry.method !== 'GET')) {
    const response = await call(classTeacher, schoolA, route)
    assert.equal(response.status, 403, `${route.method} ${route.path}: ${await response.clone().text()}`)
    assert.equal(await codeOf(response), 'ACCESS_DENIED')
  }
  // Their file download and sheet are reads, which they hold.
  assert.equal((await classTeacher.fetch(`${at(schoolA)}/${item.oldMaths}/attachments/${files.oldMaths}`)).status, 200)
  const sheet = await classTeacher.fetch(`${at(schoolA)}/${item.oldMaths}/checks`)
  assert.equal(sheet.status, 200, await sheet.clone().text())
  // Section two is not their class at all.
  assert.equal((await classTeacher.fetch(`${at(schoolA)}/${item.mathsTwo}`)).status, 404)
  assert.equal(await fingerprint(schoolA), before)
})

// ---------------------------------------------------------------------------
// Check-offs, and what is written about them.

test('[homework] check-offs are saved by the right teacher, and no remark reaches safe_changes', async () => {
  const saved = await subjectTeacher.fetch(
    `${at(schoolA)}/${item.oldMaths}/checks`,
    send('PUT', {
      entries: [
        { studentId: child, status: 'not_done', remark: `${MARK} child remark`, expectedVersion: 0 },
        { studentId: stranger, status: 'done', remark: `${MARK} stranger remark`, expectedVersion: 0 },
      ],
    }),
  )
  assert.equal(saved.status, 200, await saved.clone().text())
  const general = await classTeacher.fetch(
    `${at(schoolA)}/${item.general}/checks`,
    send('PUT', {
      entries: [
        { studentId: lateJoiner, status: 'done', remark: `${MARK} late remark`, expectedVersion: 0 },
        { studentId: child, status: 'partly_done', remark: `${MARK} child general remark`, expectedVersion: 0 },
      ],
    }),
  )
  assert.equal(general.status, 200, await general.clone().text())
  // A family cannot tick anything, and neither can a pupil.
  for (const client of [parent, pupil]) {
    const response = await client.fetch(
      `${at(schoolA)}/${item.oldMaths}/checks`,
      send('PUT', { entries: [{ studentId: child, status: 'done', expectedVersion: 1 }] }),
    )
    assert.equal(response.status, 403, await response.clone().text())
  }

  const rows = await adminPool().query<{ action: string; safe: string; summary: string; note: string | null }>(
    `SELECT e.action, e.safe_changes::text AS safe, e.summary, n.note FROM audit_events e
       LEFT JOIN audit_event_notes n ON n.school_id = e.school_id AND n.audit_event_id = e.id
      WHERE e.school_id = $1 AND e.action = 'homework.check' AND e.target_id = ANY($2::uuid[]) AND e.result = 'allowed'`,
    [schoolA, [item.oldMaths, item.general]],
  )
  assert.equal(rows.rows.length, 2, 'one audit row per save')
  for (const row of rows.rows) {
    assert.ok(!row.safe.includes(MARK), `a remark reached safe_changes: ${row.safe}`)
    assert.ok(!row.summary.includes(MARK))
    assert.ok(row.note?.includes(MARK), 'the remarks are in the note')
  }
})

// ---------------------------------------------------------------------------
// Families and pupils.

/** Everything a family client may receive about the given item, as one text. */
async function familyView(client: Client, id: string): Promise<string> {
  const parts = [
    await (await client.fetch(at(schoolA))).text(),
    await (await client.fetch(`${at(schoolA)}?academicYearId=${year}`)).text(),
    await (await client.fetch(`${at(schoolA)}?academicYearId=${lastYear}`)).text(),
    await (await client.fetch(`${at(schoolA)}?status=past`)).text(),
    await (await client.fetch(`${at(schoolA)}/${id}`)).text(),
    await (await client.fetch(`${at(schoolA)}/${id}/checks`)).text(),
  ]
  return parts.join('\n')
}

test('[homework] a parent reads their own child’s status, never the classmate’s, and has no sheet', async () => {
  const detail = await body<Detail>(await parent.fetch(`${at(schoolA)}/${item.oldMaths}`))
  assert.deepEqual(
    detail.children?.map((entry) => [entry.student.id, entry.status, entry.remark]),
    [[child, 'not_done', `${MARK} child remark`]],
  )
  assert.equal(detail.progress, undefined, 'a family sees no class figures')
  assert.equal(detail.checkWindow, undefined)
  const sheet = await parent.fetch(`${at(schoolA)}/${item.oldMaths}/checks`)
  assert.equal(sheet.status, 403, await sheet.clone().text())

  for (const [client, mine, theirs] of [
    [parent, child, stranger],
    [strangerParent, stranger, child],
    [pupil, stranger, child],
  ] as const) {
    const seen = await familyView(client, item.oldMaths)
    assert.ok(seen.includes(mine), 'their own child is there')
    assert.ok(!seen.includes(theirs), 'another pupil’s id is never in a family’s answer')
    assert.ok(!seen.includes(admission[theirs]!), 'nor their admission number')
    for (const remark of theirs === child
      ? [`${MARK} child remark`, `${MARK} child general remark`, `${MARK} last child remark`]
      : [`${MARK} stranger remark`, `${MARK} last stranger remark`]) {
      assert.ok(!seen.includes(remark), `another pupil’s remark leaked: ${remark}`)
    }
    assert.ok(!seen.includes(otherPupil) && !seen.includes(lateJoiner), 'nor any other pupil')
    // Asking for the other pupil by name gives nothing.
    const asked = await body<ListResponse>(await client.fetch(`${at(schoolA)}?studentId=${theirs}`))
    assert.deepEqual(asked.items, [])
    for (const pupilId of [otherPupil, lateJoiner]) {
      assert.deepEqual((await body<ListResponse>(await client.fetch(`${at(schoolA)}?studentId=${pupilId}`))).items, [])
    }
  }
  // A pupil with a login reads their own items with their own status only.
  const own = await body<ListResponse>(await pupil.fetch(`${at(schoolA)}?academicYearId=${year}`))
  const oldMaths = own.items.find((entry) => entry.id === item.oldMaths)
  assert.equal(oldMaths?.child?.student.id, stranger)
  assert.equal(oldMaths?.child?.status, 'done')
  assert.ok(own.items.every((entry) => entry.child?.student.id === stranger))
  assert.equal((await pupil.fetch(`${at(schoolA)}/report?from=${shift(today, -30)}&to=${today}`)).status, 403)
  assert.equal((await parent.fetch(`${at(schoolA)}/report?from=${shift(today, -30)}&to=${today}`)).status, 403)
})

test('[homework] the promoted child’s last year stays readable to their family, and never to another', async () => {
  for (const [client, mine, theirs, myRemark, theirRemark] of [
    [parent, child, stranger, `${MARK} last child remark`, `${MARK} last stranger remark`],
    [strangerParent, stranger, child, `${MARK} last stranger remark`, `${MARK} last child remark`],
    [pupil, stranger, child, `${MARK} last stranger remark`, `${MARK} last child remark`],
  ] as const) {
    const listed = await body<ListResponse>(await client.fetch(`${at(schoolA)}?academicYearId=${lastYear}`))
    assert.deepEqual(
      listed.items.map((entry) => [entry.id, entry.child?.student.id, entry.child?.remark]),
      [[item.lastMaths, mine, myRemark]],
    )
    const everyYear = await body<ListResponse>(await client.fetch(at(schoolA)))
    assert.ok(everyYear.items.some((entry) => entry.id === item.lastMaths), 'every year without a filter')
    const detail = await client.fetch(`${at(schoolA)}/${item.lastMaths}`)
    assert.equal(detail.status, 200, await detail.clone().text())
    const text = await detail.text()
    assert.ok(text.includes(myRemark))
    assert.ok(!text.includes(theirs) && !text.includes(theirRemark), 'nothing of the other family')
    const sheet = await client.fetch(`${at(schoolA)}/${item.lastMaths}/checks`)
    assert.equal(sheet.status, 403)
    const seen = await familyView(client, item.lastMaths)
    assert.ok(!seen.includes(theirs) && !seen.includes(theirRemark), 'in either year')
  }
  // This year's teachers do not inherit last year's class.
  for (const client of [subjectTeacher, classTeacher, otherTeacher]) {
    assert.equal((await client.fetch(`${at(schoolA)}/${item.lastMaths}`)).status, 404)
  }
  // The late joiner's family was never in last year's class.
  assert.equal((await lateParent.fetch(`${at(schoolA)}/${item.lastMaths}`)).status, 404)
})

test('[homework] the late joiner’s family reads only what was set after they came', async () => {
  const listed = await body<ListResponse>(await lateParent.fetch(at(schoolA)))
  const ids = listed.items.map((entry) => entry.id)
  assert.ok(ids.includes(item.afterLate), 'set after they joined')
  for (const id of [item.general, item.oldMaths, item.lastMaths, item.removed, item.mathsTwo, item.scienceTwo]) {
    assert.ok(!ids.includes(id), `${id} was set before they came or elsewhere`)
    const detail = await lateParent.fetch(`${at(schoolA)}/${id}`)
    assert.equal(detail.status, 404, await detail.clone().text())
    assert.equal(await codeOf(detail), 'RESOURCE_NOT_FOUND')
  }
  // Even with a check-off of their own on the general item (they are on its
  // due-date roster), the item set before they came is not theirs to read.
  const text = await familyView(lateParent, item.general)
  assert.ok(!text.includes(`${MARK} late remark`))
  assert.ok(!text.includes(child) && !text.includes(stranger))
  const after = await body<Detail>(await lateParent.fetch(`${at(schoolA)}/${item.afterLate}`))
  assert.deepEqual(
    after.children?.map((entry) => [entry.student.id, entry.status]),
    [[lateJoiner, 'not_due']],
  )
})

// ---------------------------------------------------------------------------
// Removed items.

test('[homework] a removed item and its file are gone for families, and kept for staff', async () => {
  // Before: the family reads it and downloads its file.
  for (const client of [parent, strangerParent, pupil]) {
    assert.equal((await client.fetch(`${at(schoolA)}/${item.removed}`)).status, 200)
    const file = await client.fetch(`${at(schoolA)}/${item.removed}/attachments/${files.removed}`)
    assert.equal(file.status, 200, await file.clone().text())
  }
  const current = await body<Detail>(await office.fetch(`${at(schoolA)}/${item.removed}`))
  const removed = await subjectTeacher.fetch(
    `${at(schoolA)}/${item.removed}/remove`,
    send('POST', { expectedVersion: current.version, reason: `${MARK} removal reason` }),
  )
  assert.equal(removed.status, 200, await removed.clone().text())

  const invented = randomUUID()
  for (const client of [parent, strangerParent, pupil]) {
    for (const query of ['', '?status=removed', '?status=past', '?status=upcoming', `?academicYearId=${year}`, `?studentId=${child}`]) {
      const listed = await body<ListResponse>(await client.fetch(`${at(schoolA)}${query}`))
      assert.ok(!listed.items.some((entry) => entry.id === item.removed), `listed with ${query}`)
    }
    assert.equal(
      await answer(await client.fetch(`${at(schoolA)}/${item.removed}`)),
      (await answer(await client.fetch(`${at(schoolA)}/${invented}`))).replaceAll(invented, item.removed),
      'a removed item reads like one that was never there',
    )
    const file = await client.fetch(`${at(schoolA)}/${item.removed}/attachments/${files.removed}`)
    assert.equal(file.status, 404, await file.clone().text())
    assert.equal((await client.fetch(`${at(schoolA)}/${item.removed}/checks`)).status, 404)
  }
  // Staff keep it, as a record.
  for (const client of [office, subjectTeacher, classTeacher]) {
    const detail = await body<Detail>(await client.fetch(`${at(schoolA)}/${item.removed}`))
    assert.ok(detail.removedAt, 'staff see when it was removed')
    const listed = await body<ListResponse>(await client.fetch(`${at(schoolA)}?status=removed`))
    assert.ok(listed.items.some((entry) => entry.id === item.removed))
  }
  assert.equal((await office.fetch(`${at(schoolA)}/${item.removed}/attachments/${files.removed}`)).status, 200)

  const audit = await adminPool().query<{ safe: string; note: string | null }>(
    `SELECT e.safe_changes::text AS safe, n.note FROM audit_events e
       LEFT JOIN audit_event_notes n ON n.school_id = e.school_id AND n.audit_event_id = e.id
      WHERE e.school_id = $1 AND e.target_id = $2 AND e.summary = 'Removed homework.' AND e.result = 'allowed'`,
    [schoolA, item.removed],
  )
  assert.equal(audit.rows.length, 1)
  assert.ok(!audit.rows[0]!.safe.includes(MARK))
  assert.equal(audit.rows[0]!.note, `${MARK} removal reason`)
})

// ---------------------------------------------------------------------------
// The list and the detail agree.

test('[homework] for every person, the list holds an item exactly when its detail read answers', async () => {
  const fixture = Object.values(item)
  const people: [string, Client, string[], 'staff' | 'family'][] = [
    ['office', office, fixture, 'staff'],
    ['subject teacher', subjectTeacher, [item.oldMaths, item.removed], 'staff'],
    ['class teacher', classTeacher, [item.oldMaths, item.general, item.removed, item.afterLate], 'staff'],
    ['other teacher', otherTeacher, [item.scienceTwo], 'staff'],
    ['parent', parent, [item.lastMaths, item.oldMaths, item.general, item.afterLate], 'family'],
    ['other parent', strangerParent, [item.lastMaths, item.oldMaths, item.general, item.afterLate], 'family'],
    ['pupil', pupil, [item.lastMaths, item.oldMaths, item.general, item.afterLate], 'family'],
    ['late parent', lateParent, [item.afterLate], 'family'],
  ]
  for (const [label, client, expected, kind] of people) {
    const listed = new Set<string>()
    for (const query of ['', '?status=removed', '?status=to_check']) {
      for (const entry of (await body<ListResponse>(await client.fetch(`${at(schoolA)}${query}`))).items) {
        if (fixture.includes(entry.id)) listed.add(entry.id)
        if (kind === 'family') {
          assert.equal(entry.progress, undefined, `${label} got class figures`)
          assert.equal(entry.removedAt, undefined, `${label} got a removed item`)
        }
      }
    }
    const opened = new Set<string>()
    for (const id of fixture) {
      const detail = await client.fetch(`${at(schoolA)}/${id}`)
      if (detail.status === 200) {
        opened.add(id)
        const read = await body<Detail>(detail)
        const sheet = await client.fetch(`${at(schoolA)}/${id}/checks`)
        assert.equal(sheet.status, kind === 'staff' ? 200 : 403, `${label} sheet of ${id}`)
        if (kind === 'family') {
          // Every child the detail names is one the list names for this item.
          const fromList = (await body<ListResponse>(await client.fetch(at(schoolA)))).items
            .filter((entry) => entry.id === id)
            .map((entry) => entry.child?.student.id)
          assert.deepEqual(read.children?.map((entry) => entry.student.id).sort(), fromList.sort(), `${label} ${id}`)
        }
      } else {
        assert.equal(detail.status, 404, `${label} on ${id}: ${await detail.clone().text()}`)
        assert.equal((await client.fetch(`${at(schoolA)}/${id}/checks`)).status, 404, `${label} sheet of ${id}`)
      }
    }
    assert.deepEqual([...listed].sort(), [...opened].sort(), `${label}: the list and the detail disagree`)
    assert.deepEqual([...opened].sort(), [...expected].sort(), `${label} reads the wrong items`)
    // The files follow the item.
    for (const [key, fileId] of Object.entries(files)) {
      const id = item[key as keyof typeof item]
      const file = await client.fetch(`${at(schoolA)}/${id}/attachments/${fileId}`)
      assert.equal(file.status, opened.has(id) ? 200 : 404, `${label} file of ${key}`)
    }
  }
})

// ---------------------------------------------------------------------------
// Fresh decisions.

test('[homework] a file downloads only after a fresh decision: ended access takes it away at once', async () => {
  const path = `${at(schoolA)}/${item.oldMaths}/attachments/${files.oldMaths}`
  // Both keep homework somewhere else, so the route gate still lets them in
  // and only the decision on this one item can refuse them.
  await adminPool().query(
    `INSERT INTO student_guardians (school_id, student_id, guardian_id, relation) VALUES ($1, $2, $3, 'guardian')`,
    [schoolA, otherPupil, parentGuardianId],
  )
  await adminPool().query(
    `INSERT INTO guardian_student_access
       (school_id, guardian_id, student_id, status, areas, approved_by_membership_id, approved_at)
     VALUES ($1, $2, $3, 'approved', ARRAY['basic'], $4, now())`,
    [schoolA, parentGuardianId, otherPupil, ownerA],
  )
  await bumpAccessVersion(parentMembershipId)
  await adminPool().query(
    `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [schoolA, subjectStaffId, year, sectionTwo, science, yearStart],
  )
  await bumpAccessVersion(subjectTeacherMembershipId)
  assert.equal((await parent.fetch(path)).status, 200)
  assert.equal((await subjectTeacher.fetch(path)).status, 200)
  assert.equal((await parent.fetch(`${at(schoolA)}/${item.scienceTwo}`)).status, 200, 'the second child’s item')

  // The family's portal access to the child is withdrawn; the same session asks again.
  await adminPool().query(
    `UPDATE guardian_student_access SET status = 'revoked', revoked_at = now()
      WHERE school_id = $1 AND guardian_id = $2 AND student_id = $3`,
    [schoolA, parentGuardianId, child],
  )
  await bumpAccessVersion(parentMembershipId)
  for (const route of [path, `${at(schoolA)}/${item.oldMaths}`, `${at(schoolA)}/${item.lastMaths}`]) {
    const response = await parent.fetch(route)
    assert.equal(response.status, 404, `${route}: ${await response.clone().text()}`)
    assert.equal(await codeOf(response), 'RESOURCE_NOT_FOUND')
  }
  const listed = await body<ListResponse>(await parent.fetch(at(schoolA)))
  assert.ok(listed.items.length > 0, 'the other child’s items are still there')
  assert.ok(listed.items.every((entry) => entry.child?.student.id === otherPupil), 'and only theirs')
  assert.equal((await parent.fetch(`${at(schoolA)}/${item.scienceTwo}`)).status, 200)

  // The maths assignment ends yesterday; the same session asks again.
  await adminPool().query(
    `UPDATE teaching_assignments SET effective_to = $3
      WHERE school_id = $1 AND staff_id = $2 AND subject_id = $4`,
    [schoolA, subjectStaffId, shift(today, -1), maths],
  )
  await bumpAccessVersion(subjectTeacherMembershipId)
  const before = await fingerprint(schoolA)
  for (const route of itemRoutes(item.oldMaths, files.oldMaths!)) {
    const response = await call(subjectTeacher, schoolA, route)
    assert.equal(response.status, 404, `${route.method} ${route.path}: ${await response.clone().text()}`)
    assert.equal(await codeOf(response), 'RESOURCE_NOT_FOUND')
  }
  assert.equal(await fingerprint(schoolA), before)
  assert.equal((await subjectTeacher.fetch(`${at(schoolA)}/${item.scienceTwo}`)).status, 200)
  // The office still downloads it: the file is there, the decision is what changed.
  assert.equal((await office.fetch(path)).status, 200)
})

test('[homework] nothing a person typed is in safe_changes, anywhere in the homework audit', async () => {
  const rows = await adminPool().query<{ action: string; safe: string }>(
    `SELECT action, safe_changes::text AS safe FROM audit_events
      WHERE school_id = ANY($1::uuid[]) AND action LIKE 'homework.%' AND safe_changes::text LIKE '%' || $2 || '%'`,
    [[schoolA, schoolB], MARK],
  )
  assert.deepEqual(rows.rows, [])
})
