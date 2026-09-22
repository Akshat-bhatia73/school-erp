/**
 * The fees module (Task 19).
 *
 * Nothing about dues is stored, so almost every assertion here is about the
 * same question asked twice: what the charges CTE works out, and what the
 * ledger, the statement, the register, the dues list and the dashboard each
 * say about it. They must never disagree.
 *
 * The suite owns its own academic year, class, section and pupils, so no other
 * suite's rows can move a figure. The one thing it borrows is the school, and
 * it pins its own year as the current one so the dashboard card is about the
 * money it wrote; the pin is put back the way it was found.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
  setFixturePassword,
  signInWithMfa,
  startTestServer,
  type TestServer,
} from './harness.ts'

const PASSWORD = 'Fixture-Pass!42'
const OWNER_EMAIL = `fees-owner-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const ownerUserId = fixtureIds.ownerAUser as string
const ownerBMembershipId = fixtureIds.ownerB as string
const studentB = fixtureIds.studentB as string
const yearA = fixtureIds.yearA as string

const suffix = randomUUID().slice(0, 8)

// This suite's own year, class and section. The year runs April to March like
// every Indian academic year, which is what the instalment maths counts in.
const feeYear = randomUUID()
const FEE_YEAR_NAME = `FEE-${suffix}`
const YEAR_START = '2026-04-01'
const YEAR_END = '2027-03-31'
const feeGrade = randomUUID()
const feeSection = randomUUID()

// The pupils. P1 sits the whole year, P2 joins in September, P3 has a
// percentage concession and P4 one that is larger than the fee itself.
const p1 = randomUUID()
const p2 = randomUUID()
const p3 = randomUUID()
const p4 = randomUUID()
const P2_JOINED = '2026-09-01'

// What the school charges. `spare` deliberately has no amount, so it is a head
// nobody is charged for.
const tuitionHead = randomUUID()
const admissionHead = randomUUID()
const busHead = randomUUID()
const roundHead = randomUUID()
const spareHead = randomUUID()

const TUITION_EVERY_CLASS = 100_000
const TUITION_THIS_CLASS = 120_000
const ADMISSION = 500_000
const BUS_EVERY_CLASS = 60_000
const BUS_OWN = 75_000
const ROUND = 123_457
const ROUND_BP = 3_333
// Integer paise, rounded down: 123457 * 3333 / 10000 = 41148.2181.
const ROUND_CONCESSION = Math.floor((ROUND * ROUND_BP) / 10_000)

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let accountant: Client
let accountantUserId = ''

/** School B's rows, used only as ids school A's routes must not accept. */
const foreign = { yearId: '', headId: '', receiptId: '' }

let previousCurrentYear: string | null = null

interface ErrorBody {
  error: { code: string; requestId: string; reason?: string }
}
interface NamedReference {
  id: string
  name: string
}
interface StatementLine {
  head: NamedReference
  category: string
  appliesTo: string
  frequency: string
  instalments: number
  instalmentsDue: number
  chargedYearPaise: number
  concessionYearPaise: number
  adjustmentPaise: number
  dueToDatePaise: number
  paidPaise: number
  balancePaise: number
  yearBalancePaise: number
}
interface Statement {
  student: { id: string; name: string; admissionNumber: string }
  academicYear: NamedReference
  asOf: string
  lines: StatementLine[]
  totals: Omit<StatementLine, 'head' | 'category' | 'appliesTo' | 'frequency' | 'instalments' | 'instalmentsDue'>
  optIns: { id: string; head: NamedReference; amountPaise?: number; startsOn: string; endsOn?: string; version: number }[]
  concessions: { id: string; head?: NamedReference; category: string; kind: string; percentBp?: number; amountPaise?: number; version: number }[]
  receipts: ReceiptSummary[]
  allowedActions: string[]
}
interface ReceiptSummary {
  id: string
  receiptNumber: string
  kind: string
  amountPaise: number
  mode?: string
  receivedOn: string
  student: { id: string; name: string; admissionNumber: string }
  academicYear: NamedReference
  state?: string
  reverses?: { id: string; receiptNumber: string }
  allowedActions: string[]
}
interface ReceiptDetail extends ReceiptSummary {
  lines: { head: NamedReference; amountPaise: number }[]
  reference?: string
  payerName?: string
  recordedAt: string
  refundablePaise?: number
  reversedBy: { id: string; receiptNumber: string; kind: string; amountPaise: number; receivedOn: string }[]
}
interface ReceiptPage {
  items: ReceiptSummary[]
  total: number
  page: number
  pageSize: number
  totals: { collectedPaise: number; refundedPaise: number; cancelledPaise: number; netPaise: number }
}
interface DuesRow {
  student: { id: string; name: string; admissionNumber: string }
  chargedYearPaise: number
  dueToDatePaise: number
  paidPaise: number
  balancePaise: number
  allowedActions: string[]
}
interface DuesPage {
  items: DuesRow[]
  total: number
  page: number
  pageSize: number
  academicYear: NamedReference
  asOf: string
  totals: {
    dueToDatePaise: number
    paidPaise: number
    outstandingPaise: number
    studentsWithDues: number
  }
}
interface FeeHeadItem {
  id: string
  name: string
  category: string
  appliesTo: string
  frequency: string
  active: boolean
  version: number
  allowedActions: string[]
}

function post(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
}
function put(value: unknown): RequestInit {
  return { ...post(value), method: 'PUT' }
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function failure(response: Response, status: number, reason?: string): Promise<ErrorBody> {
  assert.equal(response.status, status, await response.clone().text())
  const body = await json<ErrorBody>(response)
  if (reason !== undefined) assert.equal(body.error.reason, reason)
  return body
}

async function statementOf(client: Client, studentId: string): Promise<Statement> {
  const response = await client.fetch(
    `/api/schools/${schoolA}/fees/students/${studentId}/statement?academicYearId=${feeYear}`,
  )
  assert.equal(response.status, 200, await response.clone().text())
  return json<Statement>(response)
}

function lineFor(statement: Statement, headId: string): StatementLine {
  const line = statement.lines.find((item) => item.head.id === headId)
  assert.ok(line, `the statement carries no line for ${headId}`)
  return line
}

/** The instalments of a monthly head that have fallen due by a given day. */
function monthsDueBy(asOf: string): number {
  let due = 0
  for (let k = 0; k < 12; k += 1) {
    const moment = new Date(`${YEAR_START}T00:00:00Z`)
    moment.setUTCMonth(moment.getUTCMonth() + k)
    if (moment.toISOString().slice(0, 10) <= asOf) due += 1
  }
  return due
}

/** Every ledger row of one pupil, straight from the table. */
async function ledgerCount(studentId?: string): Promise<number> {
  const found = await adminPool().query<{ count: string }>(
    studentId === undefined
      ? `SELECT count(*)::text AS count FROM fee_receipts WHERE school_id = $1`
      : `SELECT count(*)::text AS count FROM fee_receipts WHERE school_id = $1 AND student_id = $2`,
    studentId === undefined ? [schoolA] : [schoolA, studentId],
  )
  return Number(found.rows[0]?.count)
}

async function auditRowsFor(targetId: string): Promise<
  { action: string; result: string; safe_changes: Record<string, unknown>; note: string | null }[]
> {
  const found = await adminPool().query<{
    action: string
    result: string
    safe_changes: Record<string, unknown>
    note: string | null
  }>(
    `SELECT e.action, e.result, e.safe_changes, n.note FROM audit_events e
       LEFT JOIN audit_event_notes n ON n.school_id = e.school_id AND n.audit_event_id = e.id
      WHERE e.school_id = $1 AND e.target_id = $2 ORDER BY e.created_at`,
    [schoolA, targetId],
  )
  return found.rows
}

/** A collection on one head, as the office would type it. */
async function collect(
  studentId: string,
  feeHeadId: string,
  amountPaise: number,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return owner.fetch(
    `/api/schools/${schoolA}/fees/students/${studentId}/collect`,
    post({
      academicYearId: feeYear,
      lines: [{ feeHeadId, amountPaise }],
      mode: 'cash',
      receivedOn: today,
      ...extra,
    }),
  )
}

let today = ''

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()

  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,$4,$5,'current')`,
    [feeYear, schoolA, FEE_YEAR_NAME, YEAR_START, YEAR_END],
  )
  await pool.query(
    `INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,9)`,
    [feeGrade, schoolA, `Fees ${suffix}`, `F${suffix.slice(0, 3)}`],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,$5)`,
    [feeSection, schoolA, feeYear, feeGrade, `FS-${suffix.slice(0, 4)}`],
  )
  const pupils: [string, string, string][] = [
    [p1, 'Whole Year', YEAR_START],
    [p2, 'Late Joiner', P2_JOINED],
    [p3, 'Percent Concession', YEAR_START],
    [p4, 'Amount Concession', YEAR_START],
  ]
  for (const [index, [id, name, joinedOn]] of pupils.entries()) {
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,status) VALUES ($1,$2,$3,$4,'active')`,
      [id, schoolA, `FEE/${suffix}/${index + 1}`, name],
    )
    await pool.query(
      `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), schoolA, id, feeYear, feeSection, index + 1, joinedOn],
    )
  }

  // What the school charges. The heads are written straight to the table so
  // that the route tests can create, rename and remove one of their own
  // without disturbing any figure this suite asserts.
  const heads: [string, string, string, string][] = [
    [tuitionHead, 'Tuition', 'tuition', 'monthly'],
    [admissionHead, 'Admission', 'admission', 'one_time'],
    [roundHead, 'Laboratory', 'lab', 'yearly'],
    [spareHead, 'Uniform', 'uniform', 'yearly'],
  ]
  for (const [id, name, category, frequency] of heads) {
    await pool.query(
      `INSERT INTO fee_heads(id,school_id,name,category,applies_to,frequency)
       VALUES ($1,$2,$3,$4,'class',$5)`,
      [id, schoolA, `${name} ${suffix}`, category, frequency],
    )
  }
  await pool.query(
    `INSERT INTO fee_heads(id,school_id,name,category,applies_to,frequency)
     VALUES ($1,$2,$3,'transport','opt_in','monthly')`,
    [busHead, schoolA, `Bus ${suffix}`],
  )

  // Tuition has an amount for every class and a different one for this class:
  // the one that names the class has to win.
  for (const [headId, gradeId, amount] of [
    [tuitionHead, null, TUITION_EVERY_CLASS],
    [tuitionHead, feeGrade, TUITION_THIS_CLASS],
    [admissionHead, feeGrade, ADMISSION],
    [roundHead, feeGrade, ROUND],
    [busHead, null, BUS_EVERY_CLASS],
  ] as [string, string | null, number][]) {
    await pool.query(
      `INSERT INTO fee_structures(school_id,academic_year_id,fee_head_id,grade_id,amount_paise)
       VALUES ($1,$2,$3,$4,$5)`,
      [schoolA, feeYear, headId, gradeId, amount],
    )
  }

  // P1 takes the bus from April to August at a fare of its own.
  await pool.query(
    `INSERT INTO fee_student_heads(school_id,student_id,academic_year_id,fee_head_id,amount_paise,starts_on,ends_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [schoolA, p1, feeYear, busHead, BUS_OWN, YEAR_START, '2026-08-31'],
  )
  await pool.query(
    `INSERT INTO fee_concessions(school_id,student_id,academic_year_id,fee_head_id,category,kind,percent_bp)
     VALUES ($1,$2,$3,$4,'sibling','percent',$5)`,
    [schoolA, p3, feeYear, roundHead, ROUND_BP],
  )
  await pool.query(
    `INSERT INTO fee_concessions(school_id,student_id,academic_year_id,fee_head_id,category,kind,amount_paise)
     VALUES ($1,$2,$3,$4,'hardship','amount',$5)`,
    [schoolA, p4, feeYear, roundHead, ROUND * 8],
  )

  // School B's own year, head and ledger row, so a foreign id is a real id.
  const foreignYear = await pool.query<{ id: string }>(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'current') RETURNING id`,
    [schoolB, `FEE-B-${suffix}`, YEAR_START, YEAR_END],
  )
  foreign.yearId = foreignYear.rows[0]?.id as string
  const foreignHead = await pool.query<{ id: string }>(
    `INSERT INTO fee_heads(school_id,name,category,applies_to,frequency)
     VALUES ($1,$2,'tuition','class','yearly') RETURNING id`,
    [schoolB, `Tuition B ${suffix}`],
  )
  foreign.headId = foreignHead.rows[0]?.id as string
  const foreignReceipt = await pool.query<{ id: string }>(
    `INSERT INTO fee_receipts(school_id,student_id,academic_year_id,kind,receipt_number,amount_paise,
                              mode,received_on,recorded_by_membership_id)
     VALUES ($1,$2,$3,'payment',$4,100000,'cash',$5,$6) RETURNING id`,
    [schoolB, studentB, foreign.yearId, `B/${suffix}/R0001`, YEAR_START, ownerBMembershipId],
  )
  foreign.receiptId = foreignReceipt.rows[0]?.id as string
  await pool.query(
    `INSERT INTO fee_receipt_lines(school_id,receipt_id,fee_head_id,amount_paise) VALUES ($1,$2,$3,100000)`,
    [schoolB, foreign.receiptId, foreign.headId],
  )

  // The dashboard card is about the school's current year, so this suite's
  // year becomes it for the length of the run.
  const pinned = await pool.query<{ current_academic_year_id: string | null }>(
    'SELECT current_academic_year_id FROM schools WHERE id = $1',
    [schoolA],
  )
  previousCurrentYear = pinned.rows[0]?.current_academic_year_id ?? null
  await pool.query(
    `UPDATE academic_years SET status = 'closed' WHERE school_id = $1 AND status = 'current' AND id <> $2`,
    [schoolA, feeYear],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [schoolA, feeYear])

  server = await startTestServer()
  await setFixturePassword(server, ownerUserId, PASSWORD)
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })

  accountantUserId = randomUUID()
  const accountantMembership = randomUUID()
  const accountantEmail = `fees-accountant-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [
    accountantUserId,
    'Fees Accountant',
    accountantEmail,
  ])
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')`,
    [accountantMembership, schoolA, accountantUserId],
  )
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = 'accountant'`,
    [schoolA, accountantMembership],
  )
  await setFixturePassword(server, accountantUserId, PASSWORD)
  accountant = await signInWithMfa(server, {
    userId: accountantUserId,
    email: accountantEmail,
    password: PASSWORD,
  })

  today = (await statementOf(owner, p1)).asOf
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = ANY($1::uuid[])', [
    [ownerUserId, accountantUserId],
  ])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = ANY($1::uuid[])', [
    [ownerUserId, accountantUserId],
  ])
  // Put the school's current year back the way the suite found it.
  await pool.query(`UPDATE academic_years SET status = 'closed' WHERE school_id = $1 AND id = $2`, [
    schoolA,
    feeYear,
  ])
  await pool.query(`UPDATE academic_years SET status = 'current' WHERE school_id = $1 AND id = $2`, [
    schoolA,
    previousCurrentYear ?? yearA,
  ])
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [
    schoolA,
    previousCurrentYear ?? yearA,
  ])
  await server.close()
  await closeAdminPool()
})

// ---------------------------------------------------------------------------
// What the school charges.

test('a fee head is created, listed and renamed, and a stale version is refused', async () => {
  const created = await owner.fetch(
    `/api/schools/${schoolA}/fees/heads`,
    post({ name: `Library ${suffix}`, category: 'library', appliesTo: 'class', frequency: 'yearly' }),
  )
  assert.equal(created.status, 201, await created.clone().text())
  const head = await json<FeeHeadItem>(created)
  assert.equal(head.version, 1)
  assert.equal(head.active, true)
  assert.ok(head.allowedActions.includes('fees.manage'))

  const listed = await owner.fetch(`/api/schools/${schoolA}/fees/heads`)
  assert.equal(listed.status, 200)
  const heads = await json<FeeHeadItem[]>(listed)
  assert.ok(heads.some((item) => item.id === head.id))
  assert.ok(heads.some((item) => item.id === tuitionHead))

  const renamed = await owner.fetch(
    `/api/schools/${schoolA}/fees/heads/${head.id}`,
    put({ name: `Library and reading ${suffix}`, category: 'library', active: false, expectedVersion: 1 }),
  )
  assert.equal(renamed.status, 200, await renamed.clone().text())
  const after = await json<FeeHeadItem>(renamed)
  assert.equal(after.name, `Library and reading ${suffix}`)
  assert.equal(after.active, false)
  assert.equal(after.version, 2)
  // Who the head applies to and how often it is charged were never sent, and
  // they are still what they were.
  assert.equal(after.appliesTo, 'class')
  assert.equal(after.frequency, 'yearly')

  const stale = await owner.fetch(
    `/api/schools/${schoolA}/fees/heads/${head.id}`,
    put({ name: `Library again ${suffix}`, category: 'library', active: true, expectedVersion: 1 }),
  )
  assert.equal(stale.status, 409, await stale.clone().text())
  const unchanged = await json<FeeHeadItem[]>(await owner.fetch(`/api/schools/${schoolA}/fees/heads`))
  assert.equal(unchanged.find((item) => item.id === head.id)?.version, 2)

  // Nothing stands on this head, so it can still be taken away.
  const removed = await owner.fetch(
    `/api/schools/${schoolA}/fees/heads/${head.id}?expectedVersion=2`,
    { method: 'DELETE' },
  )
  assert.equal(removed.status, 204, await removed.clone().text())
})

test('a fee head something stands on cannot be removed', async () => {
  const before = await auditRowsFor(tuitionHead)
  const refused = await owner.fetch(`/api/schools/${schoolA}/fees/heads/${tuitionHead}?expectedVersion=1`, {
    method: 'DELETE',
  })
  await failure(refused, 400, 'fee_head_in_use')

  const still = await adminPool().query('SELECT 1 FROM fee_heads WHERE school_id = $1 AND id = $2', [
    schoolA,
    tuitionHead,
  ])
  assert.equal(still.rowCount, 1, 'the head is still there')
  // A refused write leaves no trace in the log: the transaction rolled back.
  assert.equal((await auditRowsFor(tuitionHead)).length, before.length)
})

test('an amount for one class wins over the amount for every class', async () => {
  const statement = await statementOf(owner, p1)
  const tuition = lineFor(statement, tuitionHead)
  assert.equal(tuition.instalments, 12)
  assert.equal(tuition.chargedYearPaise, 12 * TUITION_THIS_CLASS)
  assert.notEqual(tuition.chargedYearPaise, 12 * TUITION_EVERY_CLASS)

  // Both rows are on the structures list, and the class filter keeps the row
  // for the class and the row for every class, because both charge a pupil.
  const listed = await owner.fetch(
    `/api/schools/${schoolA}/fees/structures?academicYearId=${feeYear}&gradeId=${feeGrade}`,
  )
  assert.equal(listed.status, 200)
  const structures = await json<{ id: string; head: NamedReference; grade?: NamedReference; amountPaise: number }[]>(
    listed,
  )
  const tuitionRows = structures.filter((row) => row.head.id === tuitionHead)
  assert.equal(tuitionRows.length, 2)
  assert.deepEqual(
    tuitionRows.map((row) => row.amountPaise).sort((a, b) => a - b),
    [TUITION_EVERY_CLASS, TUITION_THIS_CLASS],
  )
})

test('a monthly head charges twelve instalments and only the ones due today count', async () => {
  const statement = await statementOf(owner, p1)
  const due = monthsDueBy(statement.asOf)
  assert.ok(due >= 1 && due <= 12, `${statement.asOf} is outside the academic year`)
  const tuition = lineFor(statement, tuitionHead)
  assert.equal(tuition.instalments, 12)
  assert.equal(tuition.instalmentsDue, due)
  assert.equal(tuition.chargedYearPaise, 12 * TUITION_THIS_CLASS)
  assert.equal(tuition.dueToDatePaise, due * TUITION_THIS_CLASS)
  assert.equal(tuition.yearBalancePaise, 12 * TUITION_THIS_CLASS)
  assert.equal(tuition.balancePaise, due * TUITION_THIS_CLASS)

  // A one_time head falls due on the first day of the year, once.
  const admission = lineFor(statement, admissionHead)
  assert.equal(admission.instalments, 1)
  assert.equal(admission.instalmentsDue, 1)
  assert.equal(admission.chargedYearPaise, ADMISSION)

  // A head with no amount anywhere charges nobody, so it has no line at all.
  assert.equal(statement.lines.some((line) => line.head.id === spareHead), false)
})

test('a pupil who joined in September owes nothing for the months before', async () => {
  const statement = await statementOf(owner, p2)
  const tuition = lineFor(statement, tuitionHead)
  // September to March: seven of the twelve instalments are ever charged.
  assert.equal(tuition.instalments, 7)
  assert.equal(tuition.chargedYearPaise, 7 * TUITION_THIS_CLASS)
  const due = monthsDueBy(statement.asOf) - 5
  assert.equal(tuition.instalmentsDue, Math.max(due, 0))
  assert.equal(tuition.dueToDatePaise, Math.max(due, 0) * TUITION_THIS_CLASS)

  const whole = await statementOf(owner, p1)
  assert.ok(
    lineFor(whole, tuitionHead).chargedYearPaise > tuition.chargedYearPaise,
    'a pupil who sat the whole year is charged more',
  )
})

test('an optional fee is charged at its own amount, and only while it lasts', async () => {
  const statement = await statementOf(owner, p1)
  const bus = lineFor(statement, busHead)
  // April to August, because the pupil's own end date closes it on 31 August.
  assert.equal(bus.instalments, 5)
  assert.equal(bus.instalmentsDue, 5)
  assert.equal(bus.chargedYearPaise, 5 * BUS_OWN)
  assert.notEqual(bus.chargedYearPaise, 5 * BUS_EVERY_CLASS)
  assert.equal(bus.appliesTo, 'opt_in')

  const optIn = statement.optIns.find((item) => item.head.id === busHead)
  assert.ok(optIn)
  assert.equal(optIn.amountPaise, BUS_OWN)
  assert.equal(optIn.endsOn, '2026-08-31')

  // A pupil who never took the bus is never charged for it.
  const other = await statementOf(owner, p2)
  assert.equal(other.lines.some((line) => line.head.id === busHead), false)
})

test('a percentage concession rounds down and an amount concession stops at the fee', async () => {
  const percent = await statementOf(owner, p3)
  const rounded = lineFor(percent, roundHead)
  assert.equal(rounded.chargedYearPaise, ROUND)
  assert.equal(rounded.concessionYearPaise, ROUND_CONCESSION)
  assert.ok(Number.isSafeInteger(rounded.concessionYearPaise))
  // Rounded down to a whole paisa, never up: the school never gives away a
  // fraction of a paisa it did not mean to.
  assert.ok(rounded.concessionYearPaise * 10_000 <= ROUND * ROUND_BP)
  assert.equal(rounded.dueToDatePaise, ROUND - ROUND_CONCESSION)

  const amount = await statementOf(owner, p4)
  const capped = lineFor(amount, roundHead)
  // The concession was eight times the fee; it comes off exactly once.
  assert.equal(capped.concessionYearPaise, ROUND)
  assert.equal(capped.dueToDatePaise, 0)
  assert.equal(capped.balancePaise, 0)

  // The concession is on one head, so the pupil's other fees are untouched.
  assert.equal(lineFor(amount, admissionHead).concessionYearPaise, 0)
})

// ---------------------------------------------------------------------------
// The ledger.

test('a collection gets a server made receipt number and moves the statement by its amount', async () => {
  const before = await statementOf(owner, p1)
  const beforeLine = lineFor(before, admissionHead)
  const amount = 150_000

  const response = await collect(p1, admissionHead, amount, {
    reference: `UPI-${suffix}`,
    payerName: 'A Parent',
    mode: 'upi',
  })
  assert.equal(response.status, 201, await response.clone().text())
  const receipt = await json<ReceiptDetail>(response)
  assert.match(receipt.receiptNumber, new RegExp(`^A/${FEE_YEAR_NAME}/R\\d{4}$`))
  assert.equal(receipt.kind, 'payment')
  assert.equal(receipt.state, 'standing')
  assert.equal(receipt.amountPaise, amount)
  assert.equal(receipt.refundablePaise, amount)
  assert.equal(receipt.payerName, 'A Parent')
  assert.deepEqual(receipt.lines.map((line) => line.amountPaise), [amount])

  const after = await statementOf(owner, p1)
  const afterLine = lineFor(after, admissionHead)
  assert.equal(afterLine.paidPaise, beforeLine.paidPaise + amount)
  assert.equal(afterLine.balancePaise, beforeLine.balancePaise - amount)
  assert.equal(after.totals.paidPaise, before.totals.paidPaise + amount)
  assert.equal(after.totals.balancePaise, before.totals.balancePaise - amount)
  assert.ok(after.receipts.some((item) => item.id === receipt.id))
})

test('a collection body that names its own receipt number, school or a bad amount is refused', async () => {
  const before = await ledgerCount(p1)
  const bodies: Record<string, unknown>[] = [
    // The server assigns the number; a caller may not choose one.
    { receiptNumber: 'A/2026-27/R9999' },
    { schoolId: schoolB },
    { lines: [{ feeHeadId: admissionHead, amountPaise: 100.5 }] },
    { lines: [{ feeHeadId: admissionHead, amountPaise: -100 }] },
    { lines: [{ feeHeadId: admissionHead, amountPaise: 0 }] },
    { lines: [] },
  ]
  for (const extra of bodies) {
    const response = await owner.fetch(
      `/api/schools/${schoolA}/fees/students/${p1}/collect`,
      post({
        academicYearId: feeYear,
        lines: [{ feeHeadId: admissionHead, amountPaise: 1000 }],
        mode: 'cash',
        receivedOn: today,
        ...extra,
      }),
    )
    assert.equal(response.status, 400, `${JSON.stringify(extra)}: ${await response.clone().text()}`)
  }
  assert.equal(await ledgerCount(p1), before, 'no refused body wrote a row')
})

test('money is only taken against something the pupil owes', async () => {
  const before = await ledgerCount(p1)
  const statement = await statementOf(owner, p1)
  const left = lineFor(statement, admissionHead).yearBalancePaise

  const tooMuch = await collect(p1, admissionHead, left + 1)
  await failure(tooMuch, 400, 'fee_amount_exceeds_balance')

  // A head the pupil is not charged for is nothing to pay, whatever the sum.
  const nothing = await collect(p1, spareHead, 1)
  await failure(nothing, 400, 'fee_nothing_charged')

  assert.equal(await ledgerCount(p1), before)
})

test('two collections sent at once both succeed and take consecutive numbers', async () => {
  const before = await ledgerCount(p1)
  const [first, second] = await Promise.all([
    collect(p1, tuitionHead, 30_000),
    collect(p1, tuitionHead, 40_000),
  ])
  assert.equal(first.status, 201, await first.clone().text())
  assert.equal(second.status, 201, await second.clone().text())
  const a = await json<ReceiptDetail>(first)
  const b = await json<ReceiptDetail>(second)
  assert.notEqual(a.id, b.id)

  const counters = [a.receiptNumber, b.receiptNumber]
    .map((number) => Number(number.slice(-4)))
    .sort((x, y) => x - y)
  assert.equal(counters[1], (counters[0] as number) + 1, `${a.receiptNumber} and ${b.receiptNumber}`)
  assert.equal(await ledgerCount(p1), before + 2)
})

test('a refund never exceeds the payment and a cancellation happens once', async () => {
  const payment = await json<ReceiptDetail>(await collect(p2, admissionHead, 100_000))
  const refundBody = (amountPaise: number) => ({
    lines: [{ feeHeadId: admissionHead, amountPaise }],
    mode: 'cash',
    refundedOn: today,
    reason: 'The family paid twice by mistake',
  })

  const partial = await owner.fetch(
    `/api/schools/${schoolA}/fees/receipts/${payment.id}/refund`,
    post(refundBody(40_000)),
  )
  assert.equal(partial.status, 201, await partial.clone().text())
  const refund = await json<ReceiptDetail>(partial)
  assert.equal(refund.kind, 'refund')
  assert.equal(refund.reverses?.id, payment.id)

  const tooMuch = await owner.fetch(
    `/api/schools/${schoolA}/fees/receipts/${payment.id}/refund`,
    post(refundBody(70_000)),
  )
  await failure(tooMuch, 400, 'fee_amount_exceeds_balance')

  const reread = await json<ReceiptDetail>(
    await owner.fetch(`/api/schools/${schoolA}/fees/receipts/${payment.id}`),
  )
  assert.equal(reread.state, 'partly_refunded')
  assert.equal(reread.refundablePaise, 60_000)
  assert.equal(reread.reversedBy.length, 1)

  // A payment that was partly sent back is history: it cannot be voided.
  const voided = await owner.fetch(
    `/api/schools/${schoolA}/fees/receipts/${payment.id}/cancel`,
    post({ reason: 'Wrong pupil' }),
  )
  await failure(voided, 400, 'fee_receipt_already_reversed')
})

test('a cancelled payment stops counting as paid and cannot be cancelled twice', async () => {
  const before = lineFor(await statementOf(owner, p2), admissionHead)
  const payment = await json<ReceiptDetail>(await collect(p2, admissionHead, 50_000))
  const paid = lineFor(await statementOf(owner, p2), admissionHead)
  assert.equal(paid.paidPaise, before.paidPaise + 50_000)

  const cancelled = await owner.fetch(
    `/api/schools/${schoolA}/fees/receipts/${payment.id}/cancel`,
    post({ reason: 'The cheque bounced' }),
  )
  assert.equal(cancelled.status, 201, await cancelled.clone().text())
  const voidRow = await json<ReceiptDetail>(cancelled)
  assert.equal(voidRow.kind, 'cancellation')
  assert.equal(voidRow.amountPaise, 50_000)
  assert.equal(voidRow.mode, undefined, 'a cancellation moves no money')

  const after = lineFor(await statementOf(owner, p2), admissionHead)
  assert.equal(after.paidPaise, before.paidPaise, 'the cancelled payment is not money')
  assert.equal(after.balancePaise, before.balancePaise)

  const again = await owner.fetch(
    `/api/schools/${schoolA}/fees/receipts/${payment.id}/cancel`,
    post({ reason: 'Again' }),
  )
  await failure(again, 400, 'fee_receipt_already_reversed')

  const reread = await json<ReceiptDetail>(
    await owner.fetch(`/api/schools/${schoolA}/fees/receipts/${payment.id}`),
  )
  assert.equal(reread.state, 'cancelled')
  assert.equal(reread.refundablePaise, 0)
})

test('a debit adjustment raises the balance and a credit lowers it', async () => {
  const before = lineFor(await statementOf(owner, p2), admissionHead)
  const adjust = (direction: 'credit' | 'debit', amountPaise: number) =>
    owner.fetch(
      `/api/schools/${schoolA}/fees/students/${p2}/adjustments`,
      post({
        academicYearId: feeYear,
        direction,
        lines: [{ feeHeadId: admissionHead, amountPaise }],
        reason: direction === 'debit' ? 'Late payment fine' : 'Waived by the principal',
      }),
    )

  const fine = await adjust('debit', 10_000)
  assert.equal(fine.status, 201, await fine.clone().text())
  assert.equal((await json<ReceiptDetail>(fine)).kind, 'debit_adjustment')
  const raised = lineFor(await statementOf(owner, p2), admissionHead)
  assert.equal(raised.adjustmentPaise, before.adjustmentPaise + 10_000)
  assert.equal(raised.balancePaise, before.balancePaise + 10_000)

  const waiver = await adjust('credit', 10_000)
  assert.equal(waiver.status, 201, await waiver.clone().text())
  assert.equal((await json<ReceiptDetail>(waiver)).kind, 'credit_adjustment')
  const lowered = lineFor(await statementOf(owner, p2), admissionHead)
  assert.equal(lowered.adjustmentPaise, before.adjustmentPaise)
  assert.equal(lowered.balancePaise, before.balancePaise)
})

test('the audit row of a collection carries ids only, and a reason stays in the note', async () => {
  const amount = 12_345
  const receipt = await json<ReceiptDetail>(
    await collect(p3, admissionHead, amount, { reference: `CHQ-${suffix}`, payerName: 'Nishant', mode: 'cheque' }),
  )
  const rows = await auditRowsFor(receipt.id)
  assert.equal(rows.length, 1, 'exactly one audit row')
  const row = rows[0]
  assert.ok(row)
  assert.equal(row.action, 'fees.collect')
  assert.equal(row.result, 'allowed')
  assert.equal(row.note, null, 'a collection has no reason to store')

  const printed = JSON.stringify(row.safe_changes)
  for (const forbidden of [String(amount), `CHQ-${suffix}`, 'Nishant', receipt.receiptNumber]) {
    assert.equal(printed.includes(forbidden), false, `the audit row leaks ${forbidden}`)
  }
  for (const value of Object.values(row.safe_changes)) {
    assert.notEqual(value, amount, 'an amount is never a safe change')
  }
  assert.deepEqual(Object.keys(row.safe_changes).sort(), [
    'academicYearId',
    'lineCount',
    'mode',
    'receiptId',
    'studentId',
  ])

  const reason = 'The family overpaid in April'
  const refund = await json<ReceiptDetail>(
    await owner.fetch(
      `/api/schools/${schoolA}/fees/receipts/${receipt.id}/refund`,
      post({
        lines: [{ feeHeadId: admissionHead, amountPaise: 1_000 }],
        mode: 'cash',
        refundedOn: today,
        reason,
      }),
    ),
  )
  const refundRows = await auditRowsFor(refund.id)
  assert.equal(refundRows.length, 1)
  assert.equal(refundRows[0]?.action, 'fees.manage')
  assert.equal(refundRows[0]?.note, reason)
  assert.equal(JSON.stringify(refundRows[0]?.safe_changes).includes(reason), false)
})

// ---------------------------------------------------------------------------
// The lists.

test('the dues totals cover every page and show=due keeps only the pupils who owe', async () => {
  const pageOf = async (page: number, pageSize: number, show: 'all' | 'due') =>
    json<DuesPage>(
      await owner.fetch(
        `/api/schools/${schoolA}/fees/dues?academicYearId=${feeYear}&show=${show}&page=${page}&pageSize=${pageSize}`,
      ),
    )

  const first = await pageOf(1, 1, 'all')
  assert.equal(first.academicYear.id, feeYear)
  const walked: DuesRow[] = []
  for (let page = 1; page <= first.total; page += 1) {
    const found = await pageOf(page, 1, 'all')
    assert.equal(found.total, first.total, 'the total does not move between pages')
    assert.deepEqual(found.totals, first.totals, 'the totals describe the search, not the page')
    walked.push(...found.items)
  }
  assert.equal(walked.length, first.total)
  assert.deepEqual(
    [...walked.map((row) => row.student.id)].sort(),
    [p1, p2, p3, p4].sort(),
  )
  assert.equal(
    first.totals.dueToDatePaise,
    walked.reduce((carry, row) => carry + row.dueToDatePaise, 0),
  )
  assert.equal(
    first.totals.paidPaise,
    walked.reduce((carry, row) => carry + row.paidPaise, 0),
  )
  assert.equal(
    first.totals.outstandingPaise,
    walked.reduce((carry, row) => carry + Math.max(row.balancePaise, 0), 0),
  )
  assert.equal(
    first.totals.studentsWithDues,
    walked.filter((row) => row.balancePaise > 0).length,
  )

  const owing = await pageOf(1, 100, 'due')
  assert.equal(owing.items.every((row) => row.balancePaise > 0), true)
  assert.equal(owing.total, first.totals.studentsWithDues)
})

test('every receipt on the register opens, and one outside the plan does not', async () => {
  const register = await json<ReceiptPage>(
    await owner.fetch(
      `/api/schools/${schoolA}/fees/receipts?academicYearId=${feeYear}&page=1&pageSize=100`,
    ),
  )
  assert.ok(register.items.length > 0)
  assert.equal(register.total, register.items.length)

  for (const item of register.items) {
    const detail = await owner.fetch(`/api/schools/${schoolA}/fees/receipts/${item.id}`)
    assert.equal(detail.status, 200, `${item.receiptNumber} does not open`)
    const row = await json<ReceiptDetail>(detail)
    assert.equal(row.receiptNumber, item.receiptNumber)
    assert.equal(row.amountPaise, item.amountPaise)
    assert.equal(row.state, item.state)
    // The lines of a row always add up to the row.
    assert.equal(row.lines.reduce((carry, line) => carry + line.amountPaise, 0), row.amountPaise)
  }

  // The totals are over the search, and a cancelled payment is not money.
  const collected = register.items
    .filter((item) => item.kind === 'payment' && item.state !== 'cancelled')
    .reduce((carry, item) => carry + item.amountPaise, 0)
  const refunded = register.items
    .filter((item) => item.kind === 'refund')
    .reduce((carry, item) => carry + item.amountPaise, 0)
  const cancelled = register.items
    .filter((item) => item.kind === 'payment' && item.state === 'cancelled')
    .reduce((carry, item) => carry + item.amountPaise, 0)
  assert.equal(register.totals.collectedPaise, collected)
  assert.equal(register.totals.refundedPaise, refunded)
  assert.equal(register.totals.cancelledPaise, cancelled)
  assert.equal(register.totals.netPaise, collected - refunded)

  // Another school's ledger row answers exactly like one that is not there.
  const foreignRow = await owner.fetch(`/api/schools/${schoolA}/fees/receipts/${foreign.receiptId}`)
  await failure(foreignRow, 404)
  const invented = await owner.fetch(`/api/schools/${schoolA}/fees/receipts/${randomUUID()}`)
  await failure(invented, 404)
  // A path id of the wrong shape is a missing record too, never a bad request.
  const misshapen = await owner.fetch(`/api/schools/${schoolA}/fees/receipts/not-a-uuid`)
  await failure(misshapen, 404)
})

test('the accountant dashboard money card matches the register for today', async () => {
  const dashboard = await accountant.fetch(`/api/schools/${schoolA}/dashboard?date=${today}`)
  assert.equal(dashboard.status, 200, await dashboard.clone().text())
  const body = await json<{
    audience: string
    fees?: {
      collectedTodayPaise: number
      receiptsToday: number
      collectedThisMonthPaise: number
      outstandingPaise: number
      studentsWithDues: number
    }
  }>(dashboard)
  assert.equal(body.audience, 'accountant')
  const fees = body.fees
  assert.ok(fees, 'the accountant sees the money card')

  // The card is about the school's current year, which this suite pinned to
  // its own, so the register it is compared with says the same year.
  const register = await json<ReceiptPage>(
    await accountant.fetch(
      `/api/schools/${schoolA}/fees/receipts?academicYearId=${feeYear}&from=${today}&to=${today}&page=1&pageSize=100`,
    ),
  )
  assert.equal(fees.collectedTodayPaise, Math.max(register.totals.netPaise, 0))
  assert.equal(
    fees.receiptsToday,
    register.items.filter((item) => item.kind === 'payment' && item.state !== 'cancelled').length,
  )

  const dues = await json<DuesPage>(
    await accountant.fetch(
      `/api/schools/${schoolA}/fees/dues?academicYearId=${feeYear}&page=1&pageSize=1`,
    ),
  )
  assert.equal(fees.outstandingPaise, dues.totals.outstandingPaise)
  assert.equal(fees.studentsWithDues, dues.totals.studentsWithDues)
})
