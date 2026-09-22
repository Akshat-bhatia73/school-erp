import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { createPool, withTenantTransaction } from '../src/index.ts'
import { fixtureIds as i, seedFixtures } from '../scripts/fixtures.mjs'

/**
 * The fee ledger is append-only in the database, not only in the API. A row
 * of fee_receipts may never be deleted and never edited, with one exception:
 * clearing payer_name, which is what anonymising a pupil needs. Its lines
 * refuse both. Everything here runs as erp_runtime, the login the application
 * actually uses, so a bug in a handler could not get past it either.
 */

const url = process.env.TEST_DATABASE_URL
if (!url) throw new Error('TEST_DATABASE_URL is required')
if (new URL(url).pathname === '/erp')
  throw new Error(
    'The db tests refuse to run against "erp", the development database; use erp_test (pnpm db:test:prepare)',
  )
const admin = new pg.Pool({ connectionString: url })

const runtimeUrl = new URL(url)
runtimeUrl.username = 'erp_runtime'
runtimeUrl.password = 'erp_runtime'
const runtime = createPool({ connectionString: runtimeUrl.toString(), max: 4 })

function context(schoolId) {
  return {
    schoolId,
    requestId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    membershipId: crypto.randomUUID(),
    membershipKind: 'adult',
    accessVersion: 1,
    roleKeys: [],
    assurance: 'single_factor',
    mfaVerifiedAt: null,
    now: new Date().toISOString(),
  }
}

/**
 * One statement in its own tenant transaction. A refused statement poisons the
 * transaction it ran in, so every attempt below needs a fresh one.
 */
async function asRuntime(schoolId, work) {
  return withTenantTransaction(runtime, context(schoolId), ({ client }) => work(client))
}

/**
 * The runtime login is refused either by the grant (42501, no UPDATE on the
 * column) or by the trigger (P0001). Both are the ledger holding; which one
 * answers first is a detail of the grant, not of the rule.
 */
async function refused(schoolId, sql, values) {
  await assert.rejects(
    asRuntime(schoolId, (client) => client.query(sql, values)),
    (error) => {
      assert.ok(
        error.code === 'P0001' || error.code === '42501',
        `${sql}: unexpected ${error.code} ${error.message}`,
      )
      return true
    },
  )
}

const suffix = crypto.randomUUID().slice(0, 8)
let headId = ''
let receiptId = ''
let lineId = ''

test.before(async () => {
  await seedFixtures(admin)
  const head = await admin.query(
    `INSERT INTO fee_heads(school_id,name,category,applies_to,frequency)
     VALUES ($1,$2,'tuition','class','yearly') RETURNING id`,
    [i.schoolA, `Ledger head ${suffix}`],
  )
  headId = head.rows[0].id
  const receipt = await admin.query(
    `INSERT INTO fee_receipts(school_id,student_id,academic_year_id,kind,receipt_number,
                              amount_paise,mode,received_on,payer_name,recorded_by_membership_id)
     VALUES ($1,$2,$3,'payment',$4,500000,'cash','2026-04-10','Fixture Payer',$5) RETURNING id`,
    [i.schoolA, i.studentA, i.yearA, `LEDGER/${suffix}/R0001`, i.ownerA],
  )
  receiptId = receipt.rows[0].id
  const line = await admin.query(
    `INSERT INTO fee_receipt_lines(school_id,receipt_id,fee_head_id,amount_paise)
     VALUES ($1,$2,$3,500000) RETURNING id`,
    [i.schoolA, receiptId, headId],
  )
  lineId = line.rows[0].id
})

test.after(async () => {
  await Promise.all([admin.end(), runtime.end()])
})

test('the runtime login cannot change the money on a ledger row, or remove it', async () => {
  await refused(i.schoolA, 'UPDATE fee_receipts SET amount_paise = 1 WHERE id = $1', [receiptId])
  await refused(i.schoolA, 'UPDATE fee_receipts SET kind = $2 WHERE id = $1', [receiptId, 'refund'])
  await refused(i.schoolA, 'UPDATE fee_receipts SET received_on = $2 WHERE id = $1', [
    receiptId,
    '2026-05-01',
  ])
  await refused(i.schoolA, 'DELETE FROM fee_receipts WHERE id = $1', [receiptId])

  const still = await admin.query(
    'SELECT amount_paise::text AS amount_paise, kind FROM fee_receipts WHERE id = $1',
    [receiptId],
  )
  assert.equal(still.rows[0].amount_paise, '500000')
  assert.equal(still.rows[0].kind, 'payment')
})

test('clearing the payer name is the one edit the ledger allows', async () => {
  // Anonymising a pupil takes the name of whoever paid off the row and leaves
  // the money exactly as it was written.
  await refused(i.schoolA, `UPDATE fee_receipts SET payer_name = 'x' WHERE id = $1`, [receiptId])
  const named = await admin.query('SELECT payer_name FROM fee_receipts WHERE id = $1', [receiptId])
  assert.equal(named.rows[0].payer_name, 'Fixture Payer')

  await asRuntime(i.schoolA, (client) =>
    client.query('UPDATE fee_receipts SET payer_name = NULL WHERE id = $1', [receiptId]),
  )
  const cleared = await admin.query(
    'SELECT payer_name, amount_paise::text AS amount_paise FROM fee_receipts WHERE id = $1',
    [receiptId],
  )
  assert.equal(cleared.rows[0].payer_name, null)
  assert.equal(cleared.rows[0].amount_paise, '500000')
})

test('a ledger line can never be changed or removed', async () => {
  await refused(i.schoolA, 'UPDATE fee_receipt_lines SET amount_paise = 1 WHERE id = $1', [lineId])
  await refused(i.schoolA, 'DELETE FROM fee_receipt_lines WHERE id = $1', [lineId])
  const still = await admin.query(
    'SELECT amount_paise::text AS amount_paise FROM fee_receipt_lines WHERE id = $1',
    [lineId],
  )
  assert.equal(still.rows[0].amount_paise, '500000')
})

test('another school never sees a fee row of this one', async () => {
  const mine = await asRuntime(i.schoolA, (client) =>
    client.query('SELECT id FROM fee_receipts WHERE id = $1', [receiptId]),
  )
  assert.equal(mine.rowCount, 1)

  for (const [table, column, id] of [
    ['fee_receipts', 'id', receiptId],
    ['fee_receipt_lines', 'id', lineId],
    ['fee_heads', 'id', headId],
  ]) {
    const hidden = await asRuntime(i.schoolB, (client) =>
      client.query(`SELECT ${column} FROM ${table} WHERE ${column} = $1`, [id]),
    )
    assert.equal(hidden.rowCount, 0, `${table} leaked across schools`)
  }
  // Writing school A's rows from school B's context is refused as well.
  await assert.rejects(
    asRuntime(i.schoolB, (client) =>
      client.query(
        `INSERT INTO fee_heads(school_id,name,category,applies_to,frequency)
         VALUES ($1,$2,'tuition','class','yearly')`,
        [i.schoolA, `Cross ${suffix}`],
      ),
    ),
  )
})
