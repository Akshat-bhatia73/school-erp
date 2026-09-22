/**
 * Matrix rows: fees.
 *
 * The adversarial half of Task 19. The module's own suite proves the money is
 * right; this file asks who may see it and who may move it. A teacher is
 * turned away from every fee route, a parent sees their own children and
 * nothing else, the office counter takes money but does not set fees, and an
 * id from the school next door reads exactly like an id that was never real.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import { withTenantTransaction } from '@erp/db'
import { createRequestContext } from '../../apps/api/src/auth/request-context.ts'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
  startTestServer,
  type TestServer,
} from '../../apps/api/tests/harness.ts'
import {
  body,
  codeOf,
  createMember,
  postBody,
  putBody,
  signInMember,
  signInOffice,
  type Client,
  type ErrorBody,
} from './support.ts'

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const ownerA = fixtureIds.ownerA as string
const ownerB = fixtureIds.ownerB as string
const studentB = fixtureIds.studentB as string

const suffix = randomUUID().slice(0, 8)

// School A's own rows for this file: a year the child sits now and the year
// they were promoted out of, so a closed year can be read back.
const year = randomUUID()
const closedYear = randomUUID()
const grade = randomUUID()
const section = randomUUID()
const closedSection = randomUUID()
const child = randomUUID()
const stranger = randomUUID()
const head = randomUUID()
const optInHead = randomUUID()

// School B's rows. None of them is ever reachable through school A's paths.
const yearB = randomUUID()
const gradeB = randomUUID()
const headB = randomUUID()
const structureB = randomUUID()
const optInB = randomUUID()
const concessionB = randomUUID()
const receiptB = randomUUID()

let server: TestServer
let teacher: Client
let parent: Client
let admin: Client
let accountant: Client
let singleFactorOwner: Client
let teacherMembershipId = ''

// Made through the API by the accountant, so every id below is one the
// module itself minted.
let structure = ''
let optIn = ''
let concession = ''
let childReceipt = ''
let closedReceipt = ''
let strangerReceipt = ''

const YEAR_START = '2026-04-01'
/** Today in the school's timezone, as the server works it out. */
let today = ''

interface Statement {
  student: { id: string }
  asOf: string
  lines: { head: { id: string } }[]
  receipts: { id: string }[]
  totals: { paidPaise: number }
}
interface Page<T> {
  items: T[]
  total: number
}
interface ReceiptPage extends Page<{ id: string; student: { id: string } }> {
  totals: { collectedPaise: number }
}
interface DuesPage extends Page<{ student: { id: string }; balancePaise: number }> {
  totals: { paidPaise: number }
}
interface Job {
  id: string
}

/** Every fee route, with the smallest body the contract accepts. */
interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: unknown
  /** A write, so a refusal must also leave the record untouched. */
  write: boolean
}

function routeTable(): Route[] {
  const lines = [{ feeHeadId: head, amountPaise: 1000 }]
  return [
    { method: 'GET', path: `/fees/heads`, write: false },
    {
      method: 'POST',
      path: `/fees/heads`,
      body: { name: `Denied ${suffix}`, category: 'other', appliesTo: 'class', frequency: 'yearly' },
      write: true,
    },
    {
      method: 'PUT',
      path: `/fees/heads/${head}`,
      body: { name: `Renamed ${suffix}`, category: 'other', active: false, expectedVersion: 1 },
      write: true,
    },
    { method: 'DELETE', path: `/fees/heads/${head}?expectedVersion=1`, write: true },
    { method: 'GET', path: `/fees/structures?academicYearId=${year}`, write: false },
    {
      method: 'POST',
      path: `/fees/structures`,
      body: { academicYearId: year, feeHeadId: head, amountPaise: 1000 },
      write: true,
    },
    {
      method: 'PUT',
      path: `/fees/structures/${structure}`,
      body: { amountPaise: 2000, expectedVersion: 1 },
      write: true,
    },
    { method: 'DELETE', path: `/fees/structures/${structure}?expectedVersion=1`, write: true },
    {
      method: 'POST',
      path: `/fees/students/${child}/opt-ins`,
      body: { academicYearId: year, feeHeadId: head, startsOn: YEAR_START },
      write: true,
    },
    {
      method: 'PUT',
      path: `/fees/opt-ins/${optIn}`,
      body: { amountPaise: null, endsOn: null, expectedVersion: 1 },
      write: true,
    },
    { method: 'DELETE', path: `/fees/opt-ins/${optIn}?expectedVersion=1`, write: true },
    {
      method: 'POST',
      path: `/fees/students/${child}/concessions`,
      body: {
        academicYearId: year,
        category: 'other',
        kind: 'percent',
        percentBp: 1000,
        reason: 'security suite',
      },
      write: true,
    },
    {
      method: 'POST',
      path: `/fees/concessions/${concession}/remove`,
      body: { reason: 'security suite', expectedVersion: 1 },
      write: true,
    },
    { method: 'GET', path: `/fees/receipts`, write: false },
    { method: 'GET', path: `/fees/receipts/${childReceipt}`, write: false },
    {
      method: 'POST',
      path: `/fees/students/${child}/collect`,
      body: { academicYearId: year, lines, mode: 'cash', receivedOn: YEAR_START },
      write: true,
    },
    {
      method: 'POST',
      path: `/fees/receipts/${childReceipt}/refund`,
      body: { lines, mode: 'cash', refundedOn: YEAR_START, reason: 'security suite' },
      write: true,
    },
    {
      method: 'POST',
      path: `/fees/receipts/${childReceipt}/cancel`,
      body: { reason: 'security suite' },
      write: true,
    },
    {
      method: 'POST',
      path: `/fees/students/${child}/adjustments`,
      body: { academicYearId: year, direction: 'debit', lines, reason: 'security suite' },
      write: true,
    },
    { method: 'GET', path: `/fees/students/${child}/statement?academicYearId=${year}`, write: false },
    { method: 'GET', path: `/fees/dues?academicYearId=${year}`, write: false },
    { method: 'POST', path: `/fees/receipts/${childReceipt}/export`, body: {}, write: true },
    {
      method: 'POST',
      path: `/fees/dues/export`,
      body: { academicYearId: year, format: 'xlsx' },
      write: true,
    },
    {
      method: 'POST',
      path: `/fees/receipts/export`,
      body: { from: YEAR_START, to: YEAR_START, format: 'xlsx' },
      write: true,
    },
  ]
}

function call(client: Client, route: Route): Promise<Response> {
  const path = `/api/schools/${schoolA}${route.path}`
  if (route.method === 'GET') return client.fetch(path)
  if (route.method === 'DELETE') return client.fetch(path, { method: 'DELETE' })
  const init = route.method === 'PUT' ? putBody(route.body ?? {}) : postBody(route.body ?? {})
  return client.fetch(path, init)
}

/** A bare tenant context of school A, for a statement run as the runtime login. */
function runtimeContext() {
  return createRequestContext({
    schoolId: schoolA,
    requestId: randomUUID(),
    userId: randomUUID(),
    sessionId: randomUUID(),
    membershipId: randomUUID(),
    membershipKind: 'adult' as const,
    accessVersion: 1,
    roleKeys: [],
    assurance: 'single_factor' as const,
    mfaVerifiedAt: null,
  })
}

async function ledgerRows(schoolId: string): Promise<number> {
  const found = await adminPool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM fee_receipts WHERE school_id = $1',
    [schoolId],
  )
  return Number(found.rows[0]?.count)
}

/** Every fee row of a school, as one fingerprint a refusal must not change. */
async function feeFingerprint(schoolId: string): Promise<string> {
  const found = await adminPool().query<{ fingerprint: string }>(
    `SELECT
       (SELECT count(*)::text FROM fee_heads WHERE school_id = $1) || '/' ||
       (SELECT count(*)::text FROM fee_structures WHERE school_id = $1) || '/' ||
       (SELECT count(*)::text FROM fee_student_heads WHERE school_id = $1) || '/' ||
       (SELECT count(*)::text FROM fee_concessions WHERE school_id = $1) || '/' ||
       (SELECT count(*)::text FROM fee_receipts WHERE school_id = $1) || '/' ||
       (SELECT COALESCE(sum(amount_paise), 0)::text FROM fee_receipts WHERE school_id = $1)
       AS fingerprint`,
    [schoolId],
  )
  return found.rows[0]?.fingerprint ?? ''
}

async function deniedRows(membershipId: string): Promise<number> {
  const found = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events
      WHERE school_id = $1 AND actor_membership_id = $2 AND result = 'denied'
        AND action LIKE 'fees.%'`,
    [schoolA, membershipId],
  )
  return Number(found.rows[0]?.count)
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()

  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,'2026-04-01','2027-03-31','upcoming'),
            ($4,$2,$5,'2025-04-01','2026-03-31','closed')`,
    [year, schoolA, `SEC-FEE-${suffix}`, closedYear, `SEC-OLD-${suffix}`],
  )
  await pool.query(
    `INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,700)`,
    [grade, schoolA, `Sec fees ${suffix}`, `SF${suffix.slice(0, 3)}`],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name)
     VALUES ($1,$2,$3,$4,$5),($6,$2,$7,$4,$8)`,
    [
      section, schoolA, year, grade, `SF-${suffix.slice(0, 4)}`,
      closedSection, closedYear, `SO-${suffix.slice(0, 4)}`,
    ],
  )
  // Both children sat the closed year and were promoted into this one.
  for (const [index, [pupil, name]] of [
    [child, 'Sec Child'],
    [stranger, 'Sec Stranger'],
  ].entries()) {
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,status)
       VALUES ($1,$2,$3,$4,'active')`,
      [pupil, schoolA, `SF/${suffix}/${index + 1}`, name],
    )
    await pool.query(
      `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'2025-04-01'),
              (gen_random_uuid(),$1,$2,$6,$7,$5,'2026-04-01')`,
      [schoolA, pupil, closedYear, closedSection, index + 1, year, section],
    )
  }
  await pool.query(
    `INSERT INTO fee_heads(id,school_id,name,category,applies_to,frequency)
     VALUES ($1,$2,$3,'tuition','class','yearly'),($4,$2,$5,'transport','opt_in','yearly')`,
    [head, schoolA, `Sec tuition ${suffix}`, optInHead, `Sec bus ${suffix}`],
  )

  // School B: a whole fee setup of its own, none of it ever visible here.
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,'2026-04-01','2027-03-31','current')`,
    [yearB, schoolB, `SEC-B-${suffix}`],
  )
  await pool.query(
    `INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,700)`,
    [gradeB, schoolB, `Sec B ${suffix}`, `SB${suffix.slice(0, 3)}`],
  )
  await pool.query(
    `INSERT INTO fee_heads(id,school_id,name,category,applies_to,frequency)
     VALUES ($1,$2,$3,'transport','opt_in','yearly')`,
    [headB, schoolB, `Sec B bus ${suffix}`],
  )
  await pool.query(
    `INSERT INTO fee_structures(id,school_id,academic_year_id,fee_head_id,amount_paise)
     VALUES ($1,$2,$3,$4,400000)`,
    [structureB, schoolB, yearB, headB],
  )
  await pool.query(
    `INSERT INTO fee_student_heads(id,school_id,student_id,academic_year_id,fee_head_id,starts_on)
     VALUES ($1,$2,$3,$4,$5,'2026-04-01')`,
    [optInB, schoolB, studentB, yearB, headB],
  )
  await pool.query(
    `INSERT INTO fee_concessions(id,school_id,student_id,academic_year_id,category,kind,percent_bp)
     VALUES ($1,$2,$3,$4,'sibling','percent',1000)`,
    [concessionB, schoolB, studentB, yearB],
  )
  await pool.query(
    `INSERT INTO fee_receipts(id,school_id,student_id,academic_year_id,kind,receipt_number,
                              amount_paise,mode,received_on,recorded_by_membership_id)
     VALUES ($1,$2,$3,$4,'payment',$5,300000,'cash','2026-04-10',$6)`,
    [receiptB, schoolB, studentB, yearB, `SB/${suffix}/R0001`, ownerB],
  )
  await pool.query(
    `INSERT INTO fee_receipt_lines(school_id,receipt_id,fee_head_id,amount_paise)
     VALUES ($1,$2,$3,300000)`,
    [schoolB, receiptB, headB],
  )

  // A non-fee event of school A, so the accountant's trail can be asked to
  // leave something out as well as to carry the fee actions.
  await pool.query(
    `INSERT INTO audit_events(school_id,actor_membership_id,action,target_type,target_id,
                              result,summary,request_id)
     VALUES ($1,$2,'students.create','student',$3,'allowed','A pupil was admitted.',$4)`,
    [schoolA, ownerA, child, randomUUID()],
  )

  const teacherMember = await createMember(schoolA, ['teacher'], 'Fees Teacher')
  teacherMembershipId = teacherMember.membershipId
  teacher = await signInMember(server, teacherMember)
  const adminMember = await createMember(schoolA, ['admin'], 'Fees Admin')
  admin = await signInOffice(server, adminMember)
  const accountantMember = await createMember(schoolA, ['accountant'], 'Fees Accountant')
  accountant = await signInOffice(server, accountantMember)
  // The same roles, signed in with the password alone: one factor is never
  // enough for the money.
  const weakMember = await createMember(schoolA, ['owner'], 'Fees Weak Owner')
  singleFactorOwner = await signInMember(server, weakMember)

  const parentMember = await createMember(schoolA, ['parent'], 'Fees Parent')
  const guardianId = randomUUID()
  await pool.query('INSERT INTO guardians(id,school_id,first_name) VALUES ($1,$2,$3)', [
    guardianId,
    schoolA,
    'Fees Guardian',
  ])
  await pool.query(
    `INSERT INTO membership_guardian_links(school_id,membership_id,guardian_id,verified_at)
     VALUES ($1,$2,$3,now())`,
    [schoolA, parentMember.membershipId, guardianId],
  )
  await pool.query(
    `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation)
     VALUES ($1,$2,$3,'guardian')`,
    [schoolA, child, guardianId],
  )
  await pool.query(
    `INSERT INTO guardian_student_access
       (school_id,guardian_id,student_id,status,areas,approved_by_membership_id,approved_at)
     VALUES ($1,$2,$3,'approved',ARRAY['basic','fees'],$4,now())`,
    [schoolA, guardianId, child, ownerA],
  )
  parent = await signInMember(server, parentMember)

  // The setup itself goes through the API, so every id these tests use is one
  // the module minted under a real decision.
  const structureResponse = await accountant.fetch(
    `/api/schools/${schoolA}/fees/structures`,
    postBody({ academicYearId: year, feeHeadId: head, gradeId: grade, amountPaise: 500_000 }),
  )
  assert.equal(structureResponse.status, 201, await structureResponse.clone().text())
  structure = (await body<{ id: string }>(structureResponse)).id
  const closedStructure = await accountant.fetch(
    `/api/schools/${schoolA}/fees/structures`,
    postBody({ academicYearId: closedYear, feeHeadId: head, gradeId: grade, amountPaise: 400_000 }),
  )
  assert.equal(closedStructure.status, 201, await closedStructure.clone().text())

  const optInResponse = await accountant.fetch(
    `/api/schools/${schoolA}/fees/students/${child}/opt-ins`,
    postBody({ academicYearId: year, feeHeadId: optInHead, amountPaise: 60_000, startsOn: YEAR_START }),
  )
  assert.equal(optInResponse.status, 201, await optInResponse.clone().text())
  optIn = (await body<{ id: string }>(optInResponse)).id

  const concessionResponse = await accountant.fetch(
    `/api/schools/${schoolA}/fees/students/${child}/concessions`,
    postBody({
      academicYearId: year,
      category: 'sibling',
      kind: 'percent',
      percentBp: 1000,
      reason: 'the elder child is here too',
    }),
  )
  assert.equal(concessionResponse.status, 201, await concessionResponse.clone().text())
  concession = (await body<{ id: string }>(concessionResponse)).id

  const statement = await body<Statement>(
    await accountant.fetch(
      `/api/schools/${schoolA}/fees/students/${child}/statement?academicYearId=${year}`,
    ),
  )
  today = statement.asOf

  for (const [pupil, academicYearId, receivedOn] of [
    [child, year, today],
    [child, closedYear, '2025-06-10'],
    [stranger, year, today],
  ] as const) {
    const response = await accountant.fetch(
      `/api/schools/${schoolA}/fees/students/${pupil}/collect`,
      postBody({
        academicYearId,
        lines: [{ feeHeadId: head, amountPaise: 100_000 }],
        mode: 'cash',
        receivedOn,
      }),
    )
    assert.equal(response.status, 201, await response.clone().text())
    const receipt = (await body<{ id: string }>(response)).id
    if (pupil === stranger) strangerReceipt = receipt
    else if (academicYearId === year) childReceipt = receipt
    else closedReceipt = receipt
  }
})

after(async () => {
  await server.close()
  await closeAdminPool()
})

test('[fees] a teacher is refused every fee route, and every refusal is on the record', async () => {
  const routes = routeTable()
  const fingerprint = await feeFingerprint(schoolA)
  const denialsBefore = await deniedRows(teacherMembershipId)

  for (const route of routes) {
    const response = await call(teacher, route)
    assert.equal(response.status, 403, `${route.method} ${route.path} answered ${response.status}`)
    assert.equal(await codeOf(response), 'ACCESS_DENIED', `${route.method} ${route.path}`)
  }

  // Nothing a teacher sent changed a single fee row.
  assert.equal(await feeFingerprint(schoolA), fingerprint)
  // One refusal, one audit row: the audit screen answers "who tried what".
  assert.equal(await deniedRows(teacherMembershipId), denialsBefore + routes.length)
})

test('[fees] a parent reads their own child and never another family', async () => {
  const mine = await parent.fetch(
    `/api/schools/${schoolA}/fees/students/${child}/statement?academicYearId=${year}`,
  )
  assert.equal(mine.status, 200, await mine.clone().text())
  const statement = await body<Statement>(mine)
  assert.equal(statement.student.id, child)
  assert.equal(statement.receipts.some((receipt) => receipt.id === childReceipt), true)

  const theirs = await parent.fetch(
    `/api/schools/${schoolA}/fees/students/${stranger}/statement?academicYearId=${year}`,
  )
  assert.equal(await codeOf(theirs), 'RESOURCE_NOT_FOUND')

  const ownReceipt = await parent.fetch(`/api/schools/${schoolA}/fees/receipts/${childReceipt}`)
  assert.equal(ownReceipt.status, 200)
  const otherReceipt = await parent.fetch(`/api/schools/${schoolA}/fees/receipts/${strangerReceipt}`)
  assert.equal(await codeOf(otherReceipt), 'RESOURCE_NOT_FOUND')
})

test('[fees] a parent’s lists and totals cover their own children only', async () => {
  const receipts = await body<ReceiptPage>(
    await parent.fetch(`/api/schools/${schoolA}/fees/receipts?pageSize=100`),
  )
  assert.equal(receipts.items.length > 0, true)
  for (const item of receipts.items) assert.equal(item.student.id, child)
  assert.equal(receipts.total, receipts.items.length)
  // The totals are over the plan, not over the page: only this family's money.
  assert.equal(receipts.totals.collectedPaise, 200_000)

  const dues = await body<DuesPage>(
    await parent.fetch(`/api/schools/${schoolA}/fees/dues?academicYearId=${year}&pageSize=100`),
  )
  assert.deepEqual(dues.items.map((row) => row.student.id), [child])
  assert.equal(dues.total, 1)
  assert.equal(dues.totals.paidPaise, 100_000)

  // What the school charges is not a parent's business: the plan reaches no
  // head and no structure at all, so both lists are empty rather than refused.
  const heads = await parent.fetch(`/api/schools/${schoolA}/fees/heads`)
  assert.equal(heads.status, 200)
  assert.deepEqual(await body<unknown[]>(heads), [])
  const structures = await parent.fetch(
    `/api/schools/${schoolA}/fees/structures?academicYearId=${year}`,
  )
  assert.equal(structures.status, 200)
  assert.deepEqual(await body<unknown[]>(structures), [])
})

test('[fees] a parent may not move money, set a fee or print a list', async () => {
  const fingerprint = await feeFingerprint(schoolA)
  // Printing their own child's receipt is a parent's right, and the module
  // suite proves it; everything else that writes is refused.
  const writes = routeTable().filter(
    (route) => route.write && !route.path.endsWith(`${childReceipt}/export`),
  )
  for (const route of writes) {
    const response = await call(parent, route)
    assert.equal(response.status, 403, `${route.method} ${route.path} answered ${response.status}`)
    assert.equal(await codeOf(response), 'ACCESS_DENIED', `${route.method} ${route.path}`)
  }
  assert.equal(await feeFingerprint(schoolA), fingerprint)

  const own = await parent.fetch(
    `/api/schools/${schoolA}/fees/receipts/${childReceipt}/export`,
    postBody({}),
  )
  assert.equal(own.status, 202, await own.clone().text())
})

test('[fees] the office counter takes money and sets nothing', async () => {
  const collected = await admin.fetch(
    `/api/schools/${schoolA}/fees/students/${child}/collect`,
    postBody({
      academicYearId: year,
      lines: [{ feeHeadId: head, amountPaise: 1_000 }],
      mode: 'cash',
      receivedOn: YEAR_START,
    }),
  )
  assert.equal(collected.status, 201, await collected.clone().text())
  assert.equal(
    (await admin.fetch(`/api/schools/${schoolA}/fees/students/${child}/statement?academicYearId=${year}`))
      .status,
    200,
  )

  // Everything that sets or unwinds a charge belongs to the accountant.
  const manage: Route[] = routeTable().filter(
    (route) =>
      route.path.startsWith('/fees/heads') ||
      route.path.startsWith('/fees/structures') ||
      route.path.startsWith('/fees/opt-ins') ||
      route.path.startsWith('/fees/concessions') ||
      route.path.includes('/opt-ins') ||
      route.path.includes('/concessions') ||
      route.path.includes('/refund') ||
      route.path.includes('/cancel') ||
      route.path.includes('/adjustments'),
  )
  for (const route of manage) {
    if (route.method === 'GET') continue
    const response = await call(admin, route)
    assert.equal(await codeOf(response), 'ACCESS_DENIED', `${route.method} ${route.path}`)
  }

  for (const path of [`/fees/dues/export`, `/fees/receipts/export`] as const) {
    const response = await admin.fetch(
      `/api/schools/${schoolA}${path}`,
      postBody(
        path.endsWith('dues/export')
          ? { academicYearId: year, format: 'xlsx' }
          : { from: YEAR_START, to: YEAR_START, format: 'xlsx' },
      ),
    )
    assert.equal(await codeOf(response), 'ACCESS_DENIED', path)
  }
})

test('[fees] the accountant does the lot, and their trail is the money alone', async () => {
  const renamed = await accountant.fetch(
    `/api/schools/${schoolA}/fees/heads/${head}`,
    putBody({ name: `Sec tuition ${suffix}`, category: 'tuition', active: true, expectedVersion: 1 }),
  )
  assert.equal(renamed.status, 200, await renamed.clone().text())
  const refunded = await accountant.fetch(
    `/api/schools/${schoolA}/fees/receipts/${childReceipt}/refund`,
    postBody({
      lines: [{ feeHeadId: head, amountPaise: 1_000 }],
      mode: 'cash',
      refundedOn: today,
      reason: 'the family overpaid by a little',
    }),
  )
  assert.equal(refunded.status, 201, await refunded.clone().text())
  const file = await accountant.fetch(
    `/api/schools/${schoolA}/fees/dues/export`,
    postBody({ academicYearId: year, format: 'xlsx' }),
  )
  assert.equal(file.status, 202, await file.clone().text())
  assert.ok((await body<Job>(file)).id)

  // audit.read at finance scope: the money actions are there and a pupil
  // being admitted is not.
  for (const action of ['fees.collect', 'fees.manage'] as const) {
    const page = await body<Page<{ action: string }>>(
      await accountant.fetch(`/api/schools/${schoolA}/audit-events?action=${action}&pageSize=100`),
    )
    assert.ok(page.total > 0, `the trail carries no ${action}`)
    for (const row of page.items) assert.equal(row.action, action)
  }
  const outside = await body<Page<{ action: string }>>(
    await accountant.fetch(`/api/schools/${schoolA}/audit-events?action=students.create&pageSize=100`),
  )
  assert.equal(outside.total, 0, 'an admission is not a finance event')
})

test('[fees] an id from the school next door reads exactly like an id that never existed', async () => {
  const fingerprintB = await feeFingerprint(schoolB)
  const invented = {
    pupil: randomUUID(),
    receipt: randomUUID(),
    head: randomUUID(),
    structure: randomUUID(),
    optIn: randomUUID(),
    concession: randomUUID(),
    year: randomUUID(),
  }
  const pairs: { foreign: string; invented: string; shape: (id: string) => Route[] }[] = [
    {
      foreign: studentB,
      invented: invented.pupil,
      shape: (id) => [
        { method: 'GET', path: `/fees/students/${id}/statement?academicYearId=${year}`, write: false },
        {
          method: 'POST',
          path: `/fees/students/${id}/collect`,
          body: {
            academicYearId: year,
            lines: [{ feeHeadId: head, amountPaise: 1_000 }],
            mode: 'cash',
            receivedOn: YEAR_START,
          },
          write: true,
        },
      ],
    },
    {
      foreign: receiptB,
      invented: invented.receipt,
      shape: (id) => [
        { method: 'GET', path: `/fees/receipts/${id}`, write: false },
        { method: 'POST', path: `/fees/receipts/${id}/cancel`, body: { reason: 'a try' }, write: true },
      ],
    },
    {
      foreign: headB,
      invented: invented.head,
      shape: (id) => [
        {
          method: 'PUT',
          path: `/fees/heads/${id}`,
          body: { name: `Taken ${suffix}`, category: 'other', active: false, expectedVersion: 1 },
          write: true,
        },
        { method: 'DELETE', path: `/fees/heads/${id}?expectedVersion=1`, write: true },
      ],
    },
    {
      foreign: structureB,
      invented: invented.structure,
      shape: (id) => [
        {
          method: 'PUT',
          path: `/fees/structures/${id}`,
          body: { amountPaise: 1_000, expectedVersion: 1 },
          write: true,
        },
        { method: 'DELETE', path: `/fees/structures/${id}?expectedVersion=1`, write: true },
      ],
    },
    {
      foreign: optInB,
      invented: invented.optIn,
      shape: (id) => [
        {
          method: 'PUT',
          path: `/fees/opt-ins/${id}`,
          body: { amountPaise: null, endsOn: null, expectedVersion: 1 },
          write: true,
        },
        { method: 'DELETE', path: `/fees/opt-ins/${id}?expectedVersion=1`, write: true },
      ],
    },
    {
      foreign: concessionB,
      invented: invented.concession,
      shape: (id) => [
        {
          method: 'POST',
          path: `/fees/concessions/${id}/remove`,
          body: { reason: 'a try', expectedVersion: 1 },
          write: true,
        },
      ],
    },
  ]

  for (const pair of pairs) {
    const foreignRoutes = pair.shape(pair.foreign)
    const inventedRoutes = pair.shape(pair.invented)
    for (const [index, route] of foreignRoutes.entries()) {
      const fromB = await call(accountant, route)
      const nowhere = await call(accountant, inventedRoutes[index] as Route)
      assert.equal(fromB.status, nowhere.status, `${route.method} ${route.path}`)
      const one = await body<ErrorBody>(fromB)
      const two = await body<ErrorBody>(nowhere)
      assert.equal(one.error.code, two.error.code, `${route.method} ${route.path}`)
      // Same body, request id apart: the answer tells nobody that the id is
      // real somewhere else.
      assert.deepEqual(
        { ...one, error: { ...one.error, requestId: '' } },
        { ...two, error: { ...two.error, requestId: '' } },
      )
    }
  }

  // A year from the other school is a refused request, not a 404: it is named
  // in a body, and the body is what is wrong.
  const foreignYear = await accountant.fetch(
    `/api/schools/${schoolA}/fees/students/${child}/collect`,
    postBody({
      academicYearId: yearB,
      lines: [{ feeHeadId: head, amountPaise: 1_000 }],
      mode: 'cash',
      receivedOn: YEAR_START,
    }),
  )
  assert.equal(await codeOf(foreignYear), 'INVALID_REQUEST')
  const foreignHead = await accountant.fetch(
    `/api/schools/${schoolA}/fees/students/${child}/collect`,
    postBody({
      academicYearId: year,
      lines: [{ feeHeadId: headB, amountPaise: 1_000 }],
      mode: 'cash',
      receivedOn: YEAR_START,
    }),
  )
  assert.equal(await codeOf(foreignHead), 'INVALID_REQUEST')

  assert.equal(await feeFingerprint(schoolB), fingerprintB, 'school B kept every one of its rows')
})

test('[fees] one factor is not enough to take money', async () => {
  const before = await ledgerRows(schoolA)
  const response = await singleFactorOwner.fetch(
    `/api/schools/${schoolA}/fees/students/${child}/collect`,
    postBody({
      academicYearId: year,
      lines: [{ feeHeadId: head, amountPaise: 1_000 }],
      mode: 'cash',
      receivedOn: YEAR_START,
    }),
  )
  assert.equal(response.status, 403)
  assert.equal(await codeOf(response), 'MFA_REQUIRED')
  assert.equal(await ledgerRows(schoolA), before)
})

test('[fees] the ledger refuses an edit even to the login the server itself uses', async () => {
  const receipt = await adminPool().query<{ id: string }>(
    'SELECT id FROM fee_receipts WHERE school_id = $1 AND id = $2',
    [schoolA, childReceipt],
  )
  assert.equal(receipt.rowCount, 1)

  // The same connection pool the handlers run on, in a tenant transaction of
  // this school: a bug in a handler could reach no further than this.
  const attempt = (statement: string) =>
    withTenantTransaction(server.pools.runtime, runtimeContext(), ({ client }) =>
      client.query(statement, [childReceipt]),
    )
  for (const statement of [
    'UPDATE fee_receipts SET amount_paise = 1 WHERE id = $1',
    'UPDATE fee_receipts SET received_on = \'2020-01-01\' WHERE id = $1',
    'UPDATE fee_receipts SET payer_name = \'Someone Else\' WHERE id = $1',
    'DELETE FROM fee_receipts WHERE id = $1',
    'UPDATE fee_receipt_lines SET amount_paise = 1 WHERE receipt_id = $1',
    'DELETE FROM fee_receipt_lines WHERE receipt_id = $1',
  ]) {
    await assert.rejects(attempt(statement), `${statement} was allowed`)
  }
  // Clearing the payer's name is the one edit there is, because anonymising a
  // pupil needs it and the money must stay exactly as it was written.
  await attempt('UPDATE fee_receipts SET payer_name = NULL WHERE id = $1')

  const still = await adminPool().query<{ amount_paise: string }>(
    'SELECT amount_paise::text AS amount_paise FROM fee_receipts WHERE id = $1',
    [childReceipt],
  )
  assert.equal(still.rows[0]?.amount_paise, '100000')
})

test('[fees] a promotion never takes the closed year away from the family', async () => {
  // The child sits in this year's class and paid in the one before. A parent
  // reads their own child's record for every year, so both must open.
  const closed = await parent.fetch(
    `/api/schools/${schoolA}/fees/students/${child}/statement?academicYearId=${closedYear}`,
  )
  assert.equal(closed.status, 200, await closed.clone().text())
  const statement = await body<Statement>(closed)
  assert.equal(statement.receipts.some((receipt) => receipt.id === closedReceipt), true)
  assert.equal(
    (await parent.fetch(`/api/schools/${schoolA}/fees/receipts/${closedReceipt}`)).status,
    200,
  )

  for (const academicYearId of [year, closedYear]) {
    const other = await parent.fetch(
      `/api/schools/${schoolA}/fees/students/${stranger}/statement?academicYearId=${academicYearId}`,
    )
    assert.equal(await codeOf(other), 'RESOURCE_NOT_FOUND')
  }
})
