import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import {
  activeMembershipsForUser,
  createIdentityPool,
  createPool,
  withTenantTransaction,
  TransactionAbortedError,
} from '../src/index.ts'

const url = process.env.TEST_DATABASE_URL
if (!url) throw new Error('TEST_DATABASE_URL is required')
if (new URL(url).pathname === '/erp')
  throw new Error('The db tests refuse to run against "erp", the development database; use erp_test (pnpm db:test:prepare)')
const admin = new pg.Pool({ connectionString: url })

function roleUrl(role) {
  const value = new URL(url)
  value.username = role
  value.password = role
  return value.toString()
}
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

test('identity login can only use the active-adult bootstrap function', async () => {
  const user = crypto.randomUUID(),
    other = crypto.randomUUID(),
    activeSchool = crypto.randomUUID(),
    suspendedSchool = crypto.randomUUID()
  await admin.query(
    `INSERT INTO auth_user(id,name,email) VALUES ($1::uuid,'Identity','identity-' || $1::text || '@test'),($2::uuid,'Other','other-' || $2::text || '@test')`,
    [user, other],
  )
  await admin.query(
    `INSERT INTO schools(id,login_code,name,short_name,status) VALUES ($1::uuid,'identity-a-' || $1::text,'A','A','active'),($2::uuid,'identity-b-' || $2::text,'B','B','suspended')`,
    [activeSchool, suspendedSchool],
  )
  await admin.query(
    `INSERT INTO school_memberships(school_id,user_id,kind,status) VALUES ($1,$2,'adult','active'),($1,$3,'student','suspended'),($4,$2,'adult','active')`,
    [activeSchool, user, other, suspendedSchool],
  )
  const identity = createIdentityPool({
    connectionString: roleUrl('erp_identity'),
  })
  try {
    const memberships = await activeMembershipsForUser(identity, user)
    assert.equal(memberships.length, 1)
    assert.equal(memberships[0].school_id, activeSchool)
    await assert.rejects(identity.query('SELECT * FROM school_memberships'))
    await assert.rejects(identity.query('SELECT * FROM auth_user'))
    await assert.rejects(identity.query('SELECT * FROM auth_session'))
  } finally {
    await identity.end()
  }
})

test('runtime and auth logins cannot borrow bootstrap or tenant capabilities', async () => {
  const runtime = createPool({
    connectionString: roleUrl('erp_runtime'),
    max: 1,
  })
  const auth = new pg.Pool({ connectionString: roleUrl('erp_auth') })
  try {
    await assert.rejects(
      runtime.query(
        `SELECT * FROM active_adult_memberships_for_user(gen_random_uuid())`,
      ),
    )
    await assert.rejects(
      auth.query(
        `SELECT * FROM active_adult_memberships_for_user(gen_random_uuid())`,
      ),
    )
    await assert.rejects(auth.query('SELECT * FROM students'))
    await auth.query(
      `INSERT INTO auth_verification(identifier,value,expires_at) VALUES ('auth-boundary','value',now() + interval '1 hour')`,
    )
  } finally {
    await runtime.end()
    await auth.end()
  }
})

test('same-client validation and max-one pool reuse preserve nonempty tenant contexts', async () => {
  const a = crypto.randomUUID(),
    b = crypto.randomUUID()
  await admin.query(
    `INSERT INTO schools(id,login_code,name,short_name) VALUES ($1::uuid,'safe-a-' || $1::text,'A','A'),($2::uuid,'safe-b-' || $2::text,'B','B')`,
    [a, b],
  )
  const runtime = createPool({
    connectionString: roleUrl('erp_runtime'),
    max: 1,
  })
  try {
    for (const [school, code] of [
      [a, 'A'],
      [b, 'B'],
    ])
      await withTenantTransaction(runtime, context(school), ({ client }) =>
        client.query(
          `INSERT INTO students(school_id,admission_number,first_name,status) VALUES ($1,$2,$2,'active')`,
          [school, code],
        ),
      )
    await assert.rejects(
      withTenantTransaction(runtime, context(a), async ({ client }) => {
        await client.query(
          `INSERT INTO students(school_id,admission_number,first_name,status) VALUES ($1,'rolled','Rolled','active')`,
          [a],
        )
        throw new Error('rollback')
      }),
    )
    for (const [school, code] of [
      [a, 'A'],
      [b, 'B'],
    ]) {
      const result = await withTenantTransaction(
        runtime,
        context(school),
        ({ client }) => client.query('SELECT admission_number FROM students'),
      )
      assert.deepEqual(
        result.rows.map((row) => row.admission_number),
        [code],
      )
    }
  } finally {
    await runtime.end()
  }
})

test('tenant helper rejects an owner and any non-runtime connection role', async () => {
  const school = crypto.randomUUID()
  await admin.query(
    `INSERT INTO schools(id,login_code,name,short_name) VALUES ($1::uuid,'reject-' || $1::text,'Reject','Reject')`,
    [school],
  )
  await assert.rejects(
    withTenantTransaction(admin, context(school), async () => undefined),
  )
  const identity = createIdentityPool({
    connectionString: roleUrl('erp_identity'),
  })
  try {
    await assert.rejects(
      withTenantTransaction(identity, context(school), async () => undefined),
    )
  } finally {
    await identity.end()
  }
})

test('a swallowed SQL error cannot turn a rolled-back transaction into a successful result', async () => {
  const school = crypto.randomUUID()
  await admin.query(
    `INSERT INTO schools(id,login_code,name,short_name) VALUES ($1::uuid,'aborted-' || $1::text,'Aborted','Aborted')`,
    [school],
  )
  const runtime = createPool({
    connectionString: roleUrl('erp_runtime'),
    max: 1,
  })
  try {
    await assert.rejects(
      withTenantTransaction(runtime, context(school), async ({ client }) => {
        await client.query(
          `INSERT INTO students(school_id,admission_number,first_name,status) VALUES ($1,'not-committed','Student','active')`,
          [school],
        )
        await assert.rejects(client.query('SELECT 1 / 0'), { code: '22012' })
        return 'would incorrectly report success'
      }),
      TransactionAbortedError,
    )
    const result = await withTenantTransaction(
      runtime,
      context(school),
      ({ client }) => client.query('SELECT id FROM students'),
    )
    assert.equal(result.rowCount, 0)
  } finally {
    await runtime.end()
  }
})

test.after(async () => admin.end())
