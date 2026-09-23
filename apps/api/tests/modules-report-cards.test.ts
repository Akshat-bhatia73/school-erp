/**
 * The report cards module (Task 21).
 *
 * The exams module's routes are written alongside this one, so the suite
 * seeds exams, papers, marks and publications straight into the tables as
 * the migrator, exactly as the exams routes would leave them, and then drives
 * the report card routes over HTTP.
 *
 * The suite owns its own year, class, sections, subjects and pupils. The year
 * runs April to March around today; periodic test 1 and the half-yearly exam
 * are in the past, so the term 1 card can be published.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { deflateSync } from 'node:zlib'
import { fixtureIds } from '@erp/db/fixtures'
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
const OWNER_EMAIL = `rc-owner-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const ownerUserId = fixtureIds.ownerAUser as string
const ownerMembershipId = fixtureIds.ownerA as string

const suffix = randomUUID().slice(0, 8)

const rcYear = randomUUID()
const YEAR_START = '2026-04-01'
const YEAR_END = '2027-03-31'
const rcGrade = randomUUID()
const rcSection = randomUUID()
const otherSection = randomUUID()
const maths = randomUUID()
const english = randomUUID()
const pt1 = randomUUID()
const halfYearly = randomUUID()

const p1 = randomUUID()
const p2 = randomUUID()
const outsider = randomUUID()

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client
let teacher: Client
let otherTeacher: Client
let parent: Client
let otherParent: Client
const extraUserIds: string[] = []

interface ErrorBody {
  error: { code: string; requestId: string; reason?: string; message?: string }
}
interface Settings {
  displayMode: 'marks' | 'grades'
  gradeBands: { label: string; min: number; max: number }[]
  layout: {
    showLogo: boolean
    headerLines: Record<string, boolean>
    blocks: string[]
    signatures: string[]
    footerNote: string
  }
  version: number
  hasLogo: boolean
  allowedActions: string[]
}
interface EntriesResponse {
  rows: {
    student: { id: string }
    entry: { id: string; version: number; grades: Record<string, string | null>; remarks: string | null } | null
  }[]
  allowedActions: string[]
}
interface SectionView {
  exams: { kind: string; published: boolean; changedSincePublished: boolean }[]
  readyToPublish: boolean
  blockedBy?: string
  rows: {
    student: { id: string }
    latest: { versionId: string; versionNumber: number; changedSince: boolean } | null
  }[]
}
interface SectionsList {
  items: {
    section: { id: string }
    pupils: number
    coScholasticEntered: number
    published: number
    changedSincePublished: number
    examsReady: boolean
  }[]
}
interface CardTerm {
  term: string
  components: { exam: string; component: string; value: number | string | null }[]
  percentage: number | null
  grade: string | null
}
interface CardView {
  id: string
  versionNumber: number
  latest: boolean
  view: 'staff' | 'family'
  content: {
    displayMode: string
    scholastic: { subject: { id: string; name: string }; terms: CardTerm[] }[]
    coScholastic: { term: string; grades: Record<string, string | null> }[]
    attendance: { term: string; workingDays: number }[]
    school: Record<string, string>
    student: { id: string; rollNumber?: number }
  }
  remarks: { term_1?: string }
}
interface StudentCards {
  cards: { id: string; card: string; versionNumber: number; latest: boolean }[]
}

function body(method: string, value: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
}

async function ok<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text()
  assert.equal(response.status, status, text)
  return JSON.parse(text) as T
}

async function failure(response: Response, status: number, reason?: string): Promise<ErrorBody> {
  const text = await response.text()
  assert.equal(response.status, status, text)
  const parsed = JSON.parse(text) as ErrorBody
  if (reason !== undefined) assert.equal(parsed.error.reason, reason, text)
  return parsed
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const found = await adminPool().query<{ count: string }>(sql, params)
  return Number(found.rows[0]?.count)
}

async function auditRows(action: string): Promise<
  { safe_changes: Record<string, unknown>; note: string | null; target_id: string | null; summary: string }[]
> {
  const found = await adminPool().query<{
    safe_changes: Record<string, unknown>
    note: string | null
    target_id: string | null
    summary: string
  }>(
    `SELECT e.safe_changes, n.note, e.target_id, e.summary FROM audit_events e
       LEFT JOIN audit_event_notes n ON n.school_id = e.school_id AND n.audit_event_id = e.id
      WHERE e.school_id = $1 AND e.action = $2 AND e.result = 'allowed' ORDER BY e.created_at`,
    [schoolA, action],
  )
  return found.rows
}

const settingsPath = `/api/schools/${schoolA}/report-cards/settings`
const entriesPath = (sectionId: string) =>
  `/api/schools/${schoolA}/report-cards/sections/${sectionId}/terms/term_1/entries`
const sectionPath = (sectionId: string) => `/api/schools/${schoolA}/report-cards/sections/${sectionId}/cards/term_1`
const publishPath = `${sectionPath(rcSection)}/publish`

/** A brand new member of school A with the roles named, signed in. */
async function member(input: {
  roleKeys: readonly string[]
  label: string
  withMfa: boolean
  staffId?: string
  childId?: string
}): Promise<Client> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `rc-${input.label}-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, `Cards ${input.label}`, email])
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')`,
    [membershipId, schoolA, userId],
  )
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = ANY($3::text[])`,
    [schoolA, membershipId, [...input.roleKeys]],
  )
  if (input.staffId !== undefined) {
    await pool.query('INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)', [
      schoolA,
      membershipId,
      input.staffId,
    ])
  }
  if (input.childId !== undefined) {
    const guardianId = randomUUID()
    await pool.query('INSERT INTO guardians(id,school_id,first_name) VALUES ($1,$2,$3)', [
      guardianId,
      schoolA,
      `Cards guardian ${input.label}`,
    ])
    await pool.query(
      `INSERT INTO membership_guardian_links(school_id,membership_id,guardian_id,verified_at) VALUES ($1,$2,$3,now())`,
      [schoolA, membershipId, guardianId],
    )
    await pool.query(
      `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation) VALUES ($1,$2,$3,'guardian')`,
      [schoolA, input.childId, guardianId],
    )
    await pool.query(
      `INSERT INTO guardian_student_access
         (school_id,guardian_id,student_id,status,areas,approved_by_membership_id,approved_at)
       VALUES ($1,$2,$3,'approved',ARRAY['basic'],$4,now())`,
      [schoolA, guardianId, input.childId, ownerMembershipId],
    )
  }
  await setFixturePassword(server, userId, PASSWORD)
  extraUserIds.push(userId)
  return input.withMfa
    ? signInWithMfa(server, { userId, email, password: PASSWORD })
    : signInWithPassword(server, email, PASSWORD)
}

async function insertStaff(label: string): Promise<string> {
  const id = randomUUID()
  await adminPool().query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status,joining_date)
     VALUES ($1,$2,$3,$4,'teaching','Teacher','active',$5)`,
    [id, schoolA, `RC-${suffix}-${label}`, `Cards ${label}`, YEAR_START],
  )
  return id
}

/** The paper of one exam and subject in the suite's section. */
const papers = new Map<string, string>()

/** One mark appended the way insertMark would, as the next revision of its cell. */
async function mark(
  examId: string,
  subjectId: string,
  studentId: string,
  component: string,
  value: number | 'absent' | 'medical' | 'exempt',
): Promise<void> {
  const pool = adminPool()
  const paperId = papers.get(`${examId}:${subjectId}`)
  assert.ok(paperId)
  const previous = await pool.query<{ id: string; revision: number }>(
    `SELECT id, revision FROM exam_marks WHERE school_id = $1 AND paper_id = $2 AND student_id = $3 AND component = $4
      ORDER BY revision DESC LIMIT 1`,
    [schoolA, paperId, studentId, component],
  )
  const last = previous.rows[0]
  await pool.query(
    `INSERT INTO exam_marks (school_id, paper_id, exam_id, academic_year_id, section_id, subject_id, student_id,
                             component, status, marks_tenths, revision, supersedes_mark_id, kind, reason_kind,
                             recorded_by_membership_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      schoolA,
      paperId,
      examId,
      rcYear,
      rcSection,
      subjectId,
      studentId,
      component,
      typeof value === 'number' ? 'marked' : value,
      typeof value === 'number' ? Math.round(value * 10) : null,
      (last?.revision ?? 0) + 1,
      last?.id ?? null,
      last ? 'correction' : 'entry',
      last ? 'entry_error' : null,
      ownerMembershipId,
    ],
  )
}

async function publishExam(examId: string): Promise<void> {
  await adminPool().query(
    `INSERT INTO exam_publications (school_id, exam_id, academic_year_id, section_id, published_by_membership_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [schoolA, examId, rcYear, rcSection, ownerMembershipId],
  )
}

async function versionsOf(studentId: string): Promise<{ id: string; version_number: number; content: string; content_hash: string }[]> {
  const found = await adminPool().query<{ id: string; version_number: number; content: string; content_hash: string }>(
    `SELECT id, version_number, content::text AS content, content_hash FROM report_card_versions
      WHERE school_id = $1 AND student_id = $2 ORDER BY version_number`,
    [schoolA, studentId],
  )
  return found.rows
}

async function readSettings(): Promise<Settings> {
  return ok<Settings>(await owner.fetch(settingsPath))
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])
  // The school starts every run without settings of its own.
  await pool.query('DELETE FROM exam_settings WHERE school_id = $1', [schoolA])

  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status) VALUES ($1,$2,$3,$4,$5,'upcoming')`,
    [rcYear, schoolA, `RC-${suffix}`, YEAR_START, YEAR_END],
  )
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,12)`, [
    rcGrade,
    schoolA,
    `Cards ${suffix}`,
    `R${suffix.slice(0, 3)}`,
  ])
  const teacherStaff = await insertStaff('teacher')
  const otherStaff = await insertStaff('other')
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [rcSection, schoolA, rcYear, rcGrade, `RS-${suffix.slice(0, 4)}`, teacherStaff],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [otherSection, schoolA, rcYear, rcGrade, `RX-${suffix.slice(0, 4)}`, otherStaff],
  )
  for (const [id, name] of [
    [maths, 'Mathematics'],
    [english, 'English'],
  ] as const) {
    await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,$3,$4,'scholastic')`, [
      id,
      schoolA,
      `${name} ${suffix}`,
      `RC${suffix}${name.slice(0, 2)}`,
    ])
  }
  const pupils: [string, string, string][] = [
    [p1, 'First Pupil', rcSection],
    [p2, 'Second Pupil', rcSection],
    [outsider, 'Other Class', otherSection],
  ]
  for (const [index, [id, name, sectionId]] of pupils.entries()) {
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,status) VALUES ($1,$2,$3,$4,'active')`,
      [id, schoolA, `RC/${suffix}/${index + 1}`, name],
    )
    await pool.query(
      `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), schoolA, id, rcYear, sectionId, index + 1, YEAR_START],
    )
  }

  // Periodic test 1 and the half-yearly exam, both past their deadlines.
  await pool.query(
    `INSERT INTO exams(id,school_id,academic_year_id,kind,starts_on,ends_on,recheck_deadline) VALUES
       ($1,$3,$4,'periodic_test_1','2026-05-04','2026-05-06','2026-05-10'),
       ($2,$3,$4,'half_yearly','2026-09-01','2026-09-10','2026-09-15')`,
    [pt1, halfYearly, schoolA, rcYear],
  )
  for (const examId of [pt1, halfYearly]) {
    for (const subjectId of [maths, english]) {
      const id = randomUUID()
      papers.set(`${examId}:${subjectId}`, id)
      await pool.query(
        `INSERT INTO exam_papers(id,school_id,exam_id,academic_year_id,section_id,subject_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, schoolA, examId, rcYear, rcSection, subjectId],
      )
    }
  }
  // p1: maths 8 + 4 + 5 + 60 = 77; p2 absent from the written maths paper.
  for (const subjectId of [maths, english]) {
    await mark(pt1, subjectId, p1, 'periodic_test', 8)
    await mark(halfYearly, subjectId, p1, 'notebook', 4)
    await mark(halfYearly, subjectId, p1, 'subject_enrichment', 5)
    await mark(halfYearly, subjectId, p1, 'written', 60)
    await mark(pt1, subjectId, p2, 'periodic_test', 6)
    await mark(halfYearly, subjectId, p2, 'notebook', 3)
    await mark(halfYearly, subjectId, p2, 'subject_enrichment', 3)
    await mark(halfYearly, subjectId, p2, 'written', subjectId === maths ? 'absent' : 50)
  }

  server = await startTestServer()
  await setFixturePassword(server, ownerUserId, PASSWORD)
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })
  teacher = await member({ roleKeys: ['teacher'], label: 'teacher', withMfa: false, staffId: teacherStaff })
  otherTeacher = await member({ roleKeys: ['teacher'], label: 'other', withMfa: false, staffId: otherStaff })
  parent = await member({ roleKeys: ['parent'], label: 'parent', withMfa: false, childId: p1 })
  otherParent = await member({ roleKeys: ['parent'], label: 'otherparent', withMfa: false, childId: outsider })
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = ANY($1::uuid[])', [[ownerUserId, ...extraUserIds]])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = ANY($1::uuid[])', [
    [ownerUserId, ...extraUserIds],
  ])
  await server.close()
  await closeAdminPool()
})

// ---------------------------------------------------------------------------
// Settings.

const GOOD_BANDS = [
  { label: 'A', min: 75, max: 100 },
  { label: 'B', min: 50, max: 74 },
  { label: 'C', min: 0, max: 49 },
]

test('settings start as the defaults at version 0, and a teacher may read but not change them', async () => {
  const settings = await readSettings()
  assert.equal(settings.version, 0)
  assert.equal(settings.displayMode, 'marks')
  assert.equal(settings.gradeBands.length, 8)
  assert.equal(settings.gradeBands[0]?.label, 'A1')
  assert.equal(settings.hasLogo, false)
  assert.deepEqual(settings.allowedActions, ['exams.manage'])

  const seen = await ok<Settings>(await teacher.fetch(settingsPath))
  assert.deepEqual(seen.allowedActions, [])
  await failure(
    await teacher.fetch(
      settingsPath,
      body('PUT', { expectedVersion: 0, displayMode: 'marks', gradeBands: GOOD_BANDS, layout: settings.layout }),
    ),
    403,
  )
  assert.equal(await count('SELECT count(*) FROM exam_settings WHERE school_id = $1', [schoolA]), 0)
})

test('bands that overlap, leave a gap or miss 0 to 100 are refused and nothing is written', async () => {
  const layout = (await readSettings()).layout
  const cases: [typeof GOOD_BANDS, string][] = [
    [
      [
        { label: 'A', min: 70, max: 100 },
        { label: 'B', min: 0, max: 70 },
      ],
      'grade_bands_overlap',
    ],
    [
      [
        { label: 'A', min: 71, max: 100 },
        { label: 'B', min: 0, max: 60 },
      ],
      'grade_bands_gap',
    ],
    [
      [
        { label: 'A', min: 50, max: 90 },
        { label: 'B', min: 0, max: 49 },
      ],
      'grade_bands_out_of_range',
    ],
  ]
  const audits = (await auditRows('exams.manage')).length
  for (const [gradeBands, reason] of cases) {
    await failure(
      await owner.fetch(settingsPath, body('PUT', { expectedVersion: 0, displayMode: 'marks', gradeBands, layout })),
      400,
      reason,
    )
  }
  assert.equal(await count('SELECT count(*) FROM exam_settings WHERE school_id = $1', [schoolA]), 0)
  assert.equal((await auditRows('exams.manage')).length, audits)
})

test('the first save writes version 1, and a stale version is a conflict', async () => {
  const current = await readSettings()
  const saved = await ok<Settings>(
    await owner.fetch(
      settingsPath,
      body('PUT', {
        expectedVersion: 0,
        displayMode: 'marks',
        gradeBands: current.gradeBands,
        layout: { ...current.layout, footerNote: 'Keep reading.' },
      }),
    ),
  )
  assert.equal(saved.version, 1)
  assert.equal(saved.layout.footerNote, 'Keep reading.')
  const audit = (await auditRows('exams.manage')).at(-1)
  assert.deepEqual(audit?.safe_changes.changed, ['layout'])
  assert.equal(audit?.safe_changes.bands, 8)

  for (const expectedVersion of [0, 5]) {
    await failure(
      await owner.fetch(
        settingsPath,
        body('PUT', { expectedVersion, displayMode: 'grades', gradeBands: GOOD_BANDS, layout: saved.layout }),
      ),
      409,
    )
  }
  assert.equal((await readSettings()).displayMode, 'marks')
})

// ---------------------------------------------------------------------------
// Entries.

const GRADES = { work_education: 'A', art_education: 'B', health_physical_education: 'A', discipline: 'A' }
const REMARK = 'A thoughtful and kind pupil who helps others.'

test('the class teacher saves grades and remarks, and the audit row carries neither the text nor a note', async () => {
  const empty = await ok<EntriesResponse>(await teacher.fetch(entriesPath(rcSection)))
  assert.deepEqual(
    empty.rows.map((row) => row.student.id),
    [p1, p2],
  )
  assert.ok(empty.rows.every((row) => row.entry === null))
  assert.ok(empty.allowedActions.includes('report_cards.manage'))

  const saved = await ok<EntriesResponse>(
    await teacher.fetch(
      entriesPath(rcSection),
      body('PUT', {
        rows: [
          { studentId: p1, expectedVersion: 0, grades: GRADES, remarks: REMARK },
          { studentId: p2, expectedVersion: 0, grades: { ...GRADES, discipline: null }, remarks: null },
        ],
      }),
    ),
  )
  const first = saved.rows.find((row) => row.student.id === p1)
  assert.equal(first?.entry?.remarks, REMARK)
  assert.equal(first?.entry?.version, 1)

  const audit = (await auditRows('report_cards.manage')).at(-1)
  assert.ok(audit)
  assert.equal(audit.note, null)
  assert.equal(audit.target_id, rcSection)
  assert.ok(!JSON.stringify(audit.safe_changes).includes('thoughtful'))
  assert.equal(audit.safe_changes.rows, 2)
  assert.equal(audit.safe_changes.remarksChanged, 1)

  // A stale version refuses the whole save.
  await failure(
    await teacher.fetch(
      entriesPath(rcSection),
      body('PUT', { rows: [{ studentId: p1, expectedVersion: 0, grades: GRADES, remarks: 'Changed.' }] }),
    ),
    409,
  )
})

test('a teacher who is not the class teacher gets not found, and a pupil off the roster writes nothing', async () => {
  await failure(await otherTeacher.fetch(entriesPath(rcSection)), 404)
  await failure(
    await otherTeacher.fetch(
      entriesPath(rcSection),
      body('PUT', { rows: [{ studentId: p1, expectedVersion: 1, grades: GRADES, remarks: null }] }),
    ),
    404,
  )
  const before = await count('SELECT count(*) FROM report_card_entries WHERE school_id = $1', [schoolA])
  await failure(
    await teacher.fetch(
      entriesPath(rcSection),
      body('PUT', {
        rows: [
          { studentId: p2, expectedVersion: 1, grades: GRADES, remarks: null },
          { studentId: outsider, expectedVersion: 0, grades: GRADES, remarks: null },
        ],
      }),
    ),
    400,
    'report_card_pupil_not_on_roster',
  )
  assert.equal(await count('SELECT count(*) FROM report_card_entries WHERE school_id = $1', [schoolA]), before)
  assert.equal(
    await count(`SELECT count(*) FROM report_card_entries WHERE school_id = $1 AND student_id = $2 AND discipline IS NULL`, [
      schoolA,
      p2,
    ]),
    1,
  )
})

// ---------------------------------------------------------------------------
// Publishing.

test('publishing is refused before the exams are published and after a change since', async () => {
  await failure(await owner.fetch(publishPath, body('POST', {})), 400, 'report_card_exams_not_published')
  const view = await ok<SectionView>(await owner.fetch(sectionPath(rcSection)))
  assert.equal(view.readyToPublish, false)
  assert.equal(view.blockedBy, 'report_card_exams_not_published')

  await publishExam(pt1)
  await publishExam(halfYearly)
  await mark(halfYearly, english, p2, 'written', 52)
  await failure(await owner.fetch(publishPath, body('POST', {})), 400, 'report_card_exams_changed')
  await failure(await teacher.fetch(publishPath, body('POST', {})), 403)
  assert.equal(await count('SELECT count(*) FROM report_card_versions WHERE school_id = $1', [schoolA]), 0)

  // A parent sees no card before one is published.
  const none = await ok<StudentCards>(
    await parent.fetch(`/api/schools/${schoolA}/report-cards/students/${p1}?academicYearId=${rcYear}`),
  )
  assert.deepEqual(none.cards, [])
})

let firstVersion = ''

test('publishing writes version 1 for every pupil, and again with nothing changed is refused', async () => {
  await publishExam(halfYearly)
  const published = await ok<{ published: number; unchanged: number }>(
    await owner.fetch(publishPath, body('POST', {})),
    201,
  )
  assert.deepEqual(published, { published: 2, unchanged: 0 })
  const audit = (await auditRows('report_cards.publish')).at(-1)
  assert.deepEqual(audit?.safe_changes, {
    sectionId: rcSection,
    academicYearId: rcYear,
    card: 'term_1',
    published: 2,
    unchanged: 0,
  })
  assert.ok(!JSON.stringify(audit).includes('thoughtful'))
  const versions = await versionsOf(p1)
  assert.equal(versions.length, 1)
  firstVersion = versions[0]!.id

  await failure(await owner.fetch(publishPath, body('POST', {})), 400, 'report_card_nothing_to_publish')
  await failure(
    await owner.fetch(publishPath, body('POST', { studentIds: [outsider] })),
    400,
    'report_card_pupil_not_on_roster',
  )

  const view = await ok<SectionView>(await teacher.fetch(sectionPath(rcSection)))
  assert.equal(view.readyToPublish, true)
  assert.ok(view.rows.every((row) => row.latest?.versionNumber === 1 && row.latest.changedSince === false))

  const list = await ok<SectionsList>(
    await teacher.fetch(`/api/schools/${schoolA}/report-cards/sections?academicYearId=${rcYear}&card=term_1`),
  )
  assert.deepEqual(
    list.items.map((item) => item.section.id),
    [rcSection],
  )
  assert.deepEqual(
    { ...list.items[0], section: undefined, grade: undefined, allowedActions: undefined },
    {
      section: undefined,
      grade: undefined,
      allowedActions: undefined,
      pupils: 2,
      coScholasticEntered: 1,
      published: 2,
      changedSincePublished: 0,
      examsReady: true,
    },
  )
})

test('the staff view of a card carries the marks, the grades, the remarks and the attendance', async () => {
  const card = await ok<CardView>(await teacher.fetch(`/api/schools/${schoolA}/report-cards/versions/${firstVersion}`))
  assert.equal(card.view, 'staff')
  assert.equal(card.latest, true)
  const mathsRow = card.content.scholastic.find((row) => row.subject.id === maths)
  assert.equal(mathsRow?.terms[0]?.percentage, 77)
  assert.equal(mathsRow?.terms[0]?.grade, 'B1')
  assert.equal(mathsRow?.terms[0]?.components.length, 4)
  assert.equal(card.remarks.term_1, REMARK)
  assert.deepEqual(card.content.coScholastic[0]?.grades, GRADES)
  assert.equal(card.content.attendance[0]?.term, 'term_1')
  assert.equal(card.content.student.rollNumber, 1)
})

test('a parent reads their own child once published, and another family gets not found', async () => {
  const cards = await ok<StudentCards>(
    await parent.fetch(`/api/schools/${schoolA}/report-cards/students/${p1}?academicYearId=${rcYear}`),
  )
  assert.equal(cards.cards.length, 1)
  const card = await ok<CardView>(await parent.fetch(`/api/schools/${schoolA}/report-cards/versions/${firstVersion}`))
  assert.equal(card.view, 'family')
  assert.equal(card.content.scholastic[0]?.terms[0]?.components.length, 4)

  const p2Version = (await versionsOf(p2))[0]!.id
  await failure(await parent.fetch(`/api/schools/${schoolA}/report-cards/versions/${p2Version}`), 404)
  await failure(await otherParent.fetch(`/api/schools/${schoolA}/report-cards/versions/${firstVersion}`), 404)
  await failure(
    await otherParent.fetch(`/api/schools/${schoolA}/report-cards/students/${p1}?academicYearId=${rcYear}`),
    404,
  )
})

test('later changes never alter a published card, and republishing writes version 2 and keeps version 1', async () => {
  const [before] = await versionsOf(p1)
  assert.ok(before)

  const current = await readSettings()
  await ok<Settings>(
    await owner.fetch(
      settingsPath,
      body('PUT', {
        expectedVersion: current.version,
        displayMode: 'grades',
        gradeBands: GOOD_BANDS,
        layout: { ...current.layout, signatures: ['Principal'] },
      }),
    ),
  )
  await mark(halfYearly, maths, p1, 'written', 70)
  await publishExam(halfYearly)

  const [after] = await versionsOf(p1)
  assert.equal(after?.content, before.content)
  assert.equal(after?.content_hash, before.content_hash)

  const view = await ok<SectionView>(await owner.fetch(sectionPath(rcSection)))
  assert.ok(view.rows.every((row) => row.latest?.changedSince === true))

  const again = await ok<{ published: number; unchanged: number }>(
    await owner.fetch(publishPath, body('POST', {})),
    201,
  )
  assert.deepEqual(again, { published: 2, unchanged: 0 })
  const versions = await versionsOf(p1)
  assert.deepEqual(
    versions.map((row) => row.version_number),
    [1, 2],
  )
  assert.equal(versions[0]?.content, before.content)

  // The family sees grades only on the card published under grades.
  const latest = await ok<CardView>(await parent.fetch(`/api/schools/${schoolA}/report-cards/versions/${versions[1]!.id}`))
  assert.equal(latest.content.displayMode, 'grades')
  const mathsRow = latest.content.scholastic.find((row) => row.subject.id === maths)
  assert.deepEqual(mathsRow?.terms[0]?.components, [])
  assert.equal(mathsRow?.terms[0]?.percentage, null)
  assert.equal(mathsRow?.terms[0]?.grade, 'A')
  // Staff still see the marks on the same card.
  const staff = await ok<CardView>(await owner.fetch(`/api/schools/${schoolA}/report-cards/versions/${versions[1]!.id}`))
  assert.equal(staff.content.scholastic.find((row) => row.subject.id === maths)?.terms[0]?.percentage, 87)
  // The first version is kept, no longer the latest, and still in marks.
  const old = await ok<CardView>(await parent.fetch(`/api/schools/${schoolA}/report-cards/versions/${versions[0]!.id}`))
  assert.equal(old.latest, false)
  assert.equal(old.content.scholastic[0]?.terms[0]?.components.length, 4)
  const cards = await ok<StudentCards>(
    await parent.fetch(`/api/schools/${schoolA}/report-cards/students/${p1}?academicYearId=${rcYear}`),
  )
  assert.deepEqual(
    cards.cards.map((card) => [card.versionNumber, card.latest]),
    [
      [2, true],
      [1, false],
    ],
  )
})

// ---------------------------------------------------------------------------
// The logo.

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, data, Buffer.alloc(4)])
}

function png(): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0x00, 0x00]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function webp(): Buffer {
  const data = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05])
  const head = Buffer.alloc(8)
  head.write('VP8 ', 0, 'latin1')
  head.writeUInt32LE(data.length, 4)
  const chunk = Buffer.concat([head, data, Buffer.alloc(1)])
  const inner = Buffer.concat([Buffer.from('WEBP', 'latin1'), chunk])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'latin1')
  riff.writeUInt32LE(inner.length, 4)
  return Buffer.concat([riff, inner])
}

async function schoolVersion(): Promise<number> {
  const found = await adminPool().query<{ version: number }>('SELECT version FROM schools WHERE id = $1', [schoolA])
  return Number(found.rows[0]?.version)
}

function upload(client: Client, bytes: Buffer, version: number, contentType = 'image/png'): Promise<Response> {
  return client.fetch(`/api/schools/${schoolA}/school/logo?expectedVersion=${version}`, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: new Uint8Array(bytes),
  })
}

test('the logo: a PNG is kept, a WebP and an oversize file are refused, and a teacher can see it', async () => {
  await failure(await teacher.fetch(`/api/schools/${schoolA}/school/logo`), 404)
  await failure(await upload(owner, webp(), await schoolVersion(), 'image/webp'), 400)
  const big = await upload(owner, Buffer.concat([png(), Buffer.alloc(600_000)]), await schoolVersion())
  assert.equal(big.status, 413)
  assert.equal(((await big.json()) as ErrorBody).error.message, 'Choose a logo smaller than 512 KB.')

  const saved = await upload(owner, png(), await schoolVersion())
  assert.equal(saved.status, 204, await saved.text())
  const row = await adminPool().query<{ logo_storage_key: string; logo_content_type: string }>(
    'SELECT logo_storage_key, logo_content_type FROM schools WHERE id = $1',
    [schoolA],
  )
  assert.match(row.rows[0]?.logo_storage_key ?? '', new RegExp(`^logos/${schoolA}-[0-9a-f]{32}$`))
  const audit = (await auditRows('school.update')).at(-1)
  assert.equal(audit?.summary, 'Set the school logo.')

  const profile = await ok<{ logo?: { contentType: string; updatedAt: string } }>(
    await owner.fetch(`/api/schools/${schoolA}/school`),
  )
  assert.equal(profile.logo?.contentType, 'image/png')
  assert.equal((await readSettings()).hasLogo, true)

  const served = await teacher.fetch(`/api/schools/${schoolA}/school/logo`)
  assert.equal(served.status, 200)
  assert.equal(served.headers.get('content-type'), 'image/png')
  assert.equal(served.headers.get('content-disposition'), 'inline; filename="logo"')
  assert.ok((await served.arrayBuffer()).byteLength > 0)

  const removed = await owner.fetch(`/api/schools/${schoolA}/school/logo?expectedVersion=${await schoolVersion()}`, {
    method: 'DELETE',
  })
  assert.equal(removed.status, 204)
  const gone = await ok<{ logo?: unknown }>(await owner.fetch(`/api/schools/${schoolA}/school`))
  assert.equal(gone.logo, undefined)
})
