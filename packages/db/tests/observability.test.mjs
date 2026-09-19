import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'

const url = process.env.TEST_DATABASE_URL
if (!url) throw new Error('TEST_DATABASE_URL is required')
if (new URL(url).pathname === '/erp')
  throw new Error(
    'The db tests refuse to run against "erp", the development database; use erp_test (pnpm db:test:prepare)',
  )
const admin = new pg.Pool({ connectionString: url })

function roleUrl(role) {
  const value = new URL(url)
  value.username = role
  value.password = role
  return value.toString()
}
const runtime = new pg.Pool({ connectionString: roleUrl('erp_runtime') })
const auth = new pg.Pool({ connectionString: roleUrl('erp_auth') })

async function refused(pool, sql, values, code) {
  await assert.rejects(pool.query(sql, values), (error) => {
    assert.equal(error.code, code, `${sql}: ${error.code} ${error.message}`)
    return true
  })
}

const insert = `INSERT INTO access_log(method,route,status,duration_ms,request_id)
   VALUES ('GET','/api/schools/:schoolId/students/:studentId',200,12,$1)`

test.after(async () => {
  await Promise.all([admin.end(), runtime.end(), auth.end()])
})

test('the runtime writes the access log and never reads or clears it', async () => {
  await runtime.query(insert, [crypto.randomUUID()])
  await refused(runtime, 'SELECT * FROM access_log', [], '42501')
  await refused(runtime, 'DELETE FROM access_log', [], '42501')
})

test('the auth login cannot touch the access log', async () => {
  await refused(auth, 'SELECT * FROM access_log', [], '42501')
  await refused(auth, insert, [crypto.randomUUID()], '42501')
  await refused(auth, 'DELETE FROM access_log', [], '42501')
})

test('the sweep removes a 200-day-old row and keeps a 100-day-old one', async () => {
  const old = crypto.randomUUID(),
    recent = crypto.randomUUID()
  await admin.query(
    `INSERT INTO access_log(at,method,route,status,duration_ms,request_id)
     VALUES (now() - interval '200 days','GET','/api/me',200,5,$1),
            (now() - interval '100 days','GET','/api/me',200,5,$2)`,
    [old, recent],
  )
  const swept = await runtime.query('SELECT * FROM sweep_access_log()')
  const line = swept.rows.find((row) => row.item === 'access_log')
  assert.ok(line.count >= 1, 'the old row is counted')
  const left = await admin.query(
    'SELECT request_id FROM access_log WHERE request_id = ANY($1)',
    [[old, recent]],
  )
  assert.deepEqual(
    left.rows.map((row) => row.request_id),
    [recent],
  )
})

test('an identity carries a durable lockout and disable state', async () => {
  const columns = await admin.query(
    `SELECT column_name, is_nullable, column_default FROM information_schema.columns
     WHERE table_name='auth_user' AND column_name IN ('disabled_at','locked_until','failed_sign_ins')
     ORDER BY column_name`,
  )
  assert.deepEqual(
    columns.rows.map((row) => row.column_name),
    ['disabled_at', 'failed_sign_ins', 'locked_until'],
  )
  const counter = columns.rows.find((row) => row.column_name === 'failed_sign_ins')
  assert.equal(counter.is_nullable, 'NO')
  assert.equal(counter.column_default, '0')
})
