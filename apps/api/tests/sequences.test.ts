import assert from 'node:assert/strict'
import test from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import {
  allocateAdmissionNumber,
  formatAdmissionNumber,
  formatCounter,
  formatEmployeeCode,
  schoolPrefix,
} from '../src/modules/shared/sequences.ts'
import { adminPool, closeAdminPool, seedDatabaseFixtures } from './harness.ts'

const schoolA = fixtureIds.schoolA as string
const yearA = fixtureIds.yearA as string

// These are the only parts of numbering that do not need a database, so they
// are checked here rather than through an admission.

test('a counter is padded to three digits and widened rather than truncated', () => {
  assert.equal(formatCounter(1), '001')
  assert.equal(formatCounter(14), '014')
  assert.equal(formatCounter(999), '999')
  assert.equal(formatCounter(1000), '1000')
  assert.equal(formatCounter(12345), '12345')
})

test('the school prefix is trimmed and upper cased', () => {
  assert.equal(schoolPrefix('  svm '), 'SVM')
  assert.equal(schoolPrefix('Svm'), 'SVM')
})

test('an admission number names the school, the year and the counter', () => {
  assert.equal(formatAdmissionNumber('svm', '2026-27', 14), 'SVM/2026-27/014')
  assert.equal(formatAdmissionNumber(' svm ', ' 2026-27 ', 1000), 'SVM/2026-27/1000')
})

test('an employee code names the school and one school-wide counter', () => {
  assert.equal(formatEmployeeCode('svm', 7), 'SVM-E007')
  assert.equal(formatEmployeeCode('SVM', 1000), 'SVM-E1000')
})

// The rest needs a database: the point of the allocator is what two
// transactions do to the same counter row, which no unit test can show.

test('two transactions allocating at once take consecutive numbers', async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  const first = await pool.connect()
  const second = await pool.connect()
  try {
    for (const client of [first, second]) {
      await client.query('BEGIN')
      // The RLS policy reads this setting, so the test sees the school's rows.
      await client.query(`SELECT set_config('app.school_id', $1, true)`, [schoolA])
    }
    // Both allocations are in flight before either commits, so the second one
    // waits on the counter row rather than reading the value the first took.
    const firstNumber = await allocateAdmissionNumber({ client: first }, schoolA, yearA)
    const secondPromise = allocateAdmissionNumber({ client: second }, schoolA, yearA)
    let secondSettled = false
    void secondPromise.then(() => {
      secondSettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(secondSettled, false, 'the second allocation must wait for the first to commit')
    await first.query('COMMIT')
    const secondNumber = await secondPromise
    await second.query('COMMIT')
    assert.notEqual(firstNumber, secondNumber)
    const counters = [firstNumber, secondNumber].map((value) => Number(value.split('/').at(-1)))
    assert.equal(counters[1], (counters[0] ?? 0) + 1)
    // Both are past the numbers the fixtures already seeded for this year.
    for (const counter of counters) assert.ok((counter ?? 0) >= 3, String(counter))
  } finally {
    for (const client of [first, second]) {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    await closeAdminPool()
  }
})
