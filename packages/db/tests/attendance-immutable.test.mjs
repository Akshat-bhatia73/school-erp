import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { createPool, withTenantTransaction } from '../src/index.ts'
import { fixtureIds as i, seedFixtures } from '../scripts/fixtures.mjs'

/**
 * The two attendance registers are append-only in the database, not only in
 * the API. A mark is never edited and never removed: a correction is a new
 * row with the next revision. Everything here runs as erp_runtime, the login
 * the application actually uses, so a bug in a handler could not get past it
 * either.
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
 * The runtime login is refused either by the grant (42501, no UPDATE or
 * DELETE on the table) or by the trigger (P0001). Both are the register
 * holding; which one answers first is a detail of the grant, not of the rule.
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
const DATE = '2026-06-15'
let staffId = ''
let entryId = ''
let staffEntryId = ''

test.before(async () => {
  await seedFixtures(admin)
  const staff = await admin.query(
    `INSERT INTO staff(school_id,employee_code,first_name,staff_type,designation,status,joining_date)
     VALUES ($1,$2,'Register','teaching','Teacher','active','2026-04-01') RETURNING id`,
    [i.schoolA, `IMM-${suffix}`],
  )
  staffId = staff.rows[0].id
  const entry = await admin.query(
    `INSERT INTO attendance_entries(school_id,student_id,section_id,academic_year_id,date,mark,
                                    revision,kind,recorded_by_membership_id)
     VALUES ($1,$2,$3,$4,$5::date,'present',1,'marking',$6) RETURNING id`,
    [i.schoolA, i.studentA, i.sectionA, i.yearA, DATE, i.ownerA],
  )
  entryId = entry.rows[0].id
  const staffEntry = await admin.query(
    `INSERT INTO staff_attendance_entries(school_id,staff_id,date,mark,revision,kind,recorded_by_membership_id)
     VALUES ($1,$2,$3::date,'present',1,'marking',$4) RETURNING id`,
    [i.schoolA, staffId, DATE, i.ownerA],
  )
  staffEntryId = staffEntry.rows[0].id
})

test.after(async () => {
  await Promise.all([admin.end(), runtime.end()])
})

test('a pupil mark can never be changed or removed', async () => {
  await refused(i.schoolA, `UPDATE attendance_entries SET mark = 'absent' WHERE id = $1`, [entryId])
  await refused(i.schoolA, `UPDATE attendance_entries SET revision = 5 WHERE id = $1`, [entryId])
  await refused(i.schoolA, 'DELETE FROM attendance_entries WHERE id = $1', [entryId])

  const still = await admin.query('SELECT mark, revision FROM attendance_entries WHERE id = $1', [entryId])
  assert.equal(still.rows[0].mark, 'present')
  assert.equal(still.rows[0].revision, 1)
})

test('a staff mark can never be changed or removed', async () => {
  await refused(i.schoolA, `UPDATE staff_attendance_entries SET mark = 'absent' WHERE id = $1`, [
    staffEntryId,
  ])
  await refused(i.schoolA, 'DELETE FROM staff_attendance_entries WHERE id = $1', [staffEntryId])

  const still = await admin.query('SELECT mark FROM staff_attendance_entries WHERE id = $1', [
    staffEntryId,
  ])
  assert.equal(still.rows[0].mark, 'present')
})

test('two marks of one pupil on one date can never share a revision', async () => {
  await assert.rejects(
    asRuntime(i.schoolA, (client) =>
      client.query(
        `INSERT INTO attendance_entries(school_id,student_id,section_id,academic_year_id,date,mark,
                                        revision,kind,recorded_by_membership_id)
         VALUES ($1,$2,$3,$4,$5::date,'absent',1,'marking',$6)`,
        [i.schoolA, i.studentA, i.sectionA, i.yearA, DATE, i.ownerA],
      ),
    ),
    (error) => {
      assert.equal(error.code, '23505', `unexpected ${error.code} ${error.message}`)
      return true
    },
  )
  // The same pupil and date at the next revision is exactly how a correction
  // is written, so that has to be accepted.
  await asRuntime(i.schoolA, (client) =>
    client.query(
      `INSERT INTO attendance_entries(school_id,student_id,section_id,academic_year_id,date,mark,
                                      revision,supersedes_entry_id,kind,recorded_by_membership_id)
       VALUES ($1,$2,$3,$4,$5::date,'absent',2,$6,'correction',$7)`,
      [i.schoolA, i.studentA, i.sectionA, i.yearA, DATE, entryId, i.ownerA],
    ),
  )
  const rows = await admin.query(
    'SELECT revision FROM attendance_entries WHERE school_id = $1 AND student_id = $2 AND date = $3::date ORDER BY revision',
    [i.schoolA, i.studentA, DATE],
  )
  assert.deepEqual(
    rows.rows.map((row) => row.revision),
    [1, 2],
    'the superseded row is still there',
  )
})

test('two marks of one staff member on one date can never share a revision', async () => {
  await assert.rejects(
    asRuntime(i.schoolA, (client) =>
      client.query(
        `INSERT INTO staff_attendance_entries(school_id,staff_id,date,mark,revision,kind,recorded_by_membership_id)
         VALUES ($1,$2,$3::date,'absent',1,'marking',$4)`,
        [i.schoolA, staffId, DATE, i.ownerA],
      ),
    ),
    (error) => {
      assert.equal(error.code, '23505', `unexpected ${error.code} ${error.message}`)
      return true
    },
  )
})

test('another school never sees a mark of this one', async () => {
  const mine = await asRuntime(i.schoolA, (client) =>
    client.query('SELECT id FROM attendance_entries WHERE id = $1', [entryId]),
  )
  assert.equal(mine.rowCount, 1)

  for (const [table, id] of [
    ['attendance_entries', entryId],
    ['staff_attendance_entries', staffEntryId],
  ]) {
    const hidden = await asRuntime(i.schoolB, (client) =>
      client.query(`SELECT id FROM ${table} WHERE id = $1`, [id]),
    )
    assert.equal(hidden.rowCount, 0, `${table} leaked across schools`)
  }

  // Writing school A's row from school B's context is refused as well.
  await assert.rejects(
    asRuntime(i.schoolB, (client) =>
      client.query(
        `INSERT INTO attendance_entries(school_id,student_id,section_id,academic_year_id,date,mark,
                                        revision,kind,recorded_by_membership_id)
         VALUES ($1,$2,$3,$4,'2026-06-16'::date,'present',1,'marking',$5)`,
        [i.schoolA, i.studentA, i.sectionA, i.yearA, i.ownerA],
      ),
    ),
  )
})
