import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { createPool, withTenantTransaction } from '../src/index.ts'
import { getSchema } from 'better-auth/db'
import { phoneNumber } from 'better-auth/plugins/phone-number'
import { twoFactor } from 'better-auth/plugins/two-factor'

const connectionString = process.env.TEST_DATABASE_URL
if (!connectionString)
  throw new Error(
    'TEST_DATABASE_URL must name a disposable PostgreSQL database',
  )
if (new URL(connectionString).pathname === '/erp')
  throw new Error('The db tests refuse to run against "erp", the development database; use erp_test (pnpm db:test:prepare)')
const admin = new pg.Pool({ connectionString, max: 2 })
const runtimeUrl = new URL(connectionString)
runtimeUrl.username = 'erp_runtime'
runtimeUrl.password = 'erp_runtime'
const runtime = createPool({ connectionString: runtimeUrl.toString(), max: 2 })

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

async function asRuntime(schoolId, work) {
  return withTenantTransaction(runtime, context(schoolId), async ({ client }) =>
    work(client),
  )
}

test('RLS fails closed, isolates two schools and clears pooled context after rollback', async () => {
  const a = crypto.randomUUID(),
    b = crypto.randomUUID()
  await admin.query(
    `INSERT INTO schools(id,login_code,name,short_name) VALUES ($1::uuid,'a-' || $1::text,'A','A'),($2::uuid,'b-' || $2::text,'B','B')`,
    [a, b],
  )
  await asRuntime(a, (client) =>
    client.query(
      `INSERT INTO students(school_id,admission_number,first_name,status) VALUES ($1,'A1','A','active')`,
      [a],
    ),
  )
  await asRuntime(b, (client) =>
    client.query(
      `INSERT INTO students(school_id,admission_number,first_name,status) VALUES ($1,'B1','B','active')`,
      [b],
    ),
  )
  await asRuntime(a, async (client) =>
    assert.equal((await client.query('SELECT * FROM students')).rowCount, 1),
  )
  await asRuntime(b, async (client) =>
    assert.equal((await client.query('SELECT * FROM students')).rowCount, 1),
  )
  const unscoped = await runtime.connect()
  try {
    await unscoped.query('BEGIN')
    assert.equal((await unscoped.query('SELECT * FROM students')).rowCount, 0)
    await assert.rejects(
      unscoped.query(
        `INSERT INTO students(school_id,admission_number,first_name,status) VALUES ($1,'no-context','N','active')`,
        [a],
      ),
    )
  } finally {
    await unscoped.query('ROLLBACK')
    unscoped.release()
  }
})

test('composite tenant foreign keys and immutable audit history reject invalid changes', async () => {
  const a = crypto.randomUUID(),
    b = crypto.randomUUID(),
    staff = crypto.randomUUID(),
    year = crypto.randomUUID(),
    grade = crypto.randomUUID()
  await admin.query(
    `INSERT INTO schools(id,login_code,name,short_name) VALUES ($1::uuid,'c-' || $1::text,'C','C'),($2::uuid,'d-' || $2::text,'D','D')`,
    [a, b],
  )
  await asRuntime(a, (c) =>
    c.query(
      `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status) VALUES ($1,$2,'C1','C','teaching','Teacher','active')`,
      [staff, a],
    ),
  )
  await asRuntime(b, async (c) => {
    await c.query(
      `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status) VALUES ($1,$2,'2026-27','2026-04-01','2027-03-31','current')`,
      [year, b],
    )
    await c.query(
      `INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,'Six','6',6)`,
      [grade, b],
    )
  })
  await assert.rejects(
    asRuntime(b, (c) =>
      c.query(
        `INSERT INTO sections(school_id,grade_id,academic_year_id,name,class_teacher_staff_id) VALUES ($1,$2,$3,'A',$4)`,
        [b, grade, year, staff],
      ),
    ),
    {
      code: '23503',
      constraint: 'sections_school_id_class_teacher_staff_id_fkey',
    },
  )
  const event = await asRuntime(a, (c) =>
    c.query(
      `INSERT INTO audit_events(school_id,action,target_type,result,summary,request_id) VALUES ($1,'test','test','allowed','original','test') RETURNING id`,
      [a],
    ),
  )
  await assert.rejects(
    asRuntime(a, (c) =>
      c.query(`UPDATE audit_events SET summary='changed' WHERE id=$1`, [
        event.rows[0].id,
      ]),
    ),
    { code: '42501' },
  )
  await assert.rejects(
    asRuntime(a, (c) =>
      c.query(`DELETE FROM audit_events WHERE id=$1`, [event.rows[0].id]),
    ),
    { code: '42501' },
  )
  const stored = await asRuntime(a, (c) =>
    c.query(`SELECT summary FROM audit_events WHERE id=$1`, [event.rows[0].id]),
  )
  assert.deepEqual(stored.rows, [{ summary: 'original' }])
})

test('runtime catalogue is readable but immutable, and a student membership may be active with the student role only', async () => {
  const school = crypto.randomUUID(),
    user = crypto.randomUUID(),
    studentUser = crypto.randomUUID(),
    adult = crypto.randomUUID(),
    parentRole = crypto.randomUUID()
  await admin.query(
    `INSERT INTO schools(id,login_code,name,short_name) VALUES ($1::uuid,'catalogue-' || $1::text,'Catalogue','Catalogue')`,
    [school],
  )
  await admin.query(
    `INSERT INTO auth_user(id,name,email) VALUES ($1::uuid,'Adult','adult-' || $1::text || '@test'),($2::uuid,'Student','student-' || $2::text || '@test')`,
    [user, studentUser],
  )
  await admin.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')`,
    [adult, school, user],
  )
  await admin.query(
    `INSERT INTO roles(id,school_id,key,name,is_system) VALUES ($1,$2,'parent','Parent',true)`,
    [parentRole, school],
  )
  await admin.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id) VALUES ($1,$2,$3)`,
    [school, adult, parentRole],
  )
  const roles = await asRuntime(school, (c) => c.query(`SELECT key FROM roles`))
  assert.deepEqual(roles.rows, [{ key: 'parent' }])
  await assert.rejects(
    asRuntime(school, (c) =>
      c.query(`UPDATE roles SET name='Changed' WHERE id=$1`, [parentRole]),
    ),
    { code: '42501' },
  )
  await assert.rejects(
    asRuntime(school, (c) =>
      c.query(
        `INSERT INTO role_permissions(school_id,role_id,permission,scope) VALUES ($1,$2,'students.read_basic','school')`,
        [school, parentRole],
      ),
    ),
    { code: '42501' },
  )
  // Task 23: an active student membership is allowed, but never with an adult role.
  const student = await admin.query(
    `INSERT INTO school_memberships(school_id,user_id,kind,status) VALUES ($1,$2,'student','active') RETURNING id`,
    [school, studentUser],
  )
  await assert.rejects(
    admin.query(
      `INSERT INTO membership_roles(school_id,membership_id,role_id) VALUES ($1,$2,$3)`,
      [school, student.rows[0].id, parentRole],
    ),
    { code: 'P0001' },
  )
})

test('wrong-school writes fail while hidden rows cannot be updated and the runtime cannot delete', async () => {
  const a = crypto.randomUUID(),
    b = crypto.randomUUID()
  await admin.query(
    `INSERT INTO schools(id,login_code,name,short_name) VALUES ($1::uuid,'write-a-' || $1::text,'A','A'),($2::uuid,'write-b-' || $2::text,'B','B')`,
    [a, b],
  )
  const local = await asRuntime(a, (c) =>
    c.query(
      `INSERT INTO students(school_id,admission_number,first_name,status) VALUES ($1,'local','Local','active') RETURNING id`,
      [a],
    ),
  )
  await asRuntime(b, (c) =>
    c.query(
      `INSERT INTO students(school_id,admission_number,first_name,status) VALUES ($1,'hidden','Hidden','active')`,
      [b],
    ),
  )
  await assert.rejects(
    asRuntime(a, (c) =>
      c.query(
        `INSERT INTO students(school_id,admission_number,first_name,status) VALUES ($1,'forbidden','Forbidden','active')`,
        [b],
      ),
    ),
    { code: '42501' },
  )
  await assert.rejects(
    asRuntime(a, (c) =>
      c.query(`UPDATE students SET school_id=$1 WHERE id=$2`, [
        b,
        local.rows[0].id,
      ]),
    ),
    { code: '42501' },
  )
  await asRuntime(a, async (c) => {
    assert.equal(
      (
        await c.query(
          `UPDATE students SET first_name='changed' WHERE school_id=$1`,
          [b],
        )
      ).rowCount,
      0,
    )
  })
  // Removing a student is a status change plus anonymisation, so the runtime
  // holds no DELETE at all: a hidden row cannot even be attempted.
  await assert.rejects(
    asRuntime(a, (c) =>
      c.query(`DELETE FROM students WHERE school_id=$1`, [b]),
    ),
    { code: '42501' },
  )
  const hidden = await asRuntime(b, (c) =>
    c.query(`SELECT first_name FROM students`),
  )
  assert.deepEqual(hidden.rows, [{ first_name: 'Hidden' }])
})

test('section-year foreign keys reject valid records from another school and transaction rollback cannot leak context', async () => {
  const a = crypto.randomUUID(),
    b = crypto.randomUUID(),
    yearA = crypto.randomUUID(),
    gradeA = crypto.randomUUID(),
    yearB = crypto.randomUUID(),
    gradeB = crypto.randomUUID()
  await admin.query(
    `INSERT INTO schools(id,login_code,name,short_name) VALUES ($1::uuid,'year-a-' || $1::text,'Year A','A'),($2::uuid,'year-b-' || $2::text,'Year B','B')`,
    [a, b],
  )
  await asRuntime(a, (client) =>
    client.query(
      `INSERT INTO students(school_id,admission_number,first_name,status) VALUES ($1,'concurrent-a','A','active')`,
      [a],
    ),
  )
  await asRuntime(b, (client) =>
    client.query(
      `INSERT INTO students(school_id,admission_number,first_name,status) VALUES ($1,'concurrent-b','B','active')`,
      [b],
    ),
  )
  await admin.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status) VALUES ($1,$2,'2026-27','2026-04-01','2027-03-31','current'),($3,$4,'2026-27','2026-04-01','2027-03-31','current')`,
    [yearA, a, yearB, b],
  )
  await admin.query(
    `INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,'Six','6',6),($3,$4,'Six','6',6)`,
    [gradeA, a, gradeB, b],
  )
  await assert.rejects(
    asRuntime(b, (client) =>
      client.query(
        `INSERT INTO sections(school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,'A')`,
        [b, yearB, gradeA],
      ),
    ),
    { code: '23503', constraint: 'sections_school_id_grade_id_fkey' },
  )
  await assert.rejects(
    withTenantTransaction(runtime, context(a), async ({ client }) => {
      await client.query(
        `INSERT INTO students(school_id,admission_number,first_name,status) VALUES ($1,'rollback-' || $1::text,'Rollback','active')`,
        [a],
      )
      throw new Error('expected rollback')
    }),
  )
  await asRuntime(a, async (client) =>
    assert.equal(
      (
        await client.query(
          `SELECT * FROM students WHERE admission_number LIKE 'rollback-%'`,
        )
      ).rowCount,
      0,
    ),
  )
  const [rowsA, rowsB] = await Promise.all([
    asRuntime(a, (client) =>
      client.query('SELECT school_id, pg_backend_pid() AS pid FROM students'),
    ),
    asRuntime(b, (client) =>
      client.query('SELECT school_id, pg_backend_pid() AS pid FROM students'),
    ),
  ])
  assert.notEqual(
    rowsA.rows[0].pid,
    rowsB.rows[0].pid,
    'concurrent work uses separate connections',
  )
  assert.ok(
    rowsA.rowCount > 0 && rowsA.rows.every((row) => row.school_id === a),
  )
  assert.ok(
    rowsB.rowCount > 0 && rowsB.rows.every((row) => row.school_id === b),
  )
})

test('every tenant table has forced RLS, and Better Auth core, phone and MFA fields exist', async () => {
  const tenantTables = (
    await admin.query(
      // access_log names a school without belonging to one: it is global
      // infrastructure like auth_throttle, written by the runtime and read only
      // during an incident. See migration 0010.
      `SELECT DISTINCT c.table_name FROM information_schema.columns c WHERE c.table_schema='public' AND c.column_name='school_id' AND c.table_name <> 'access_log' UNION SELECT 'schools' ORDER BY 1`,
    )
  ).rows.map((r) => r.table_name)
  const rls = await admin.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, count(p.polname)::int AS policies FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1) GROUP BY c.relname,c.relrowsecurity,c.relforcerowsecurity`,
    [tenantTables],
  )
  assert.equal(rls.rowCount, tenantTables.length)
  for (const row of rls.rows)
    assert.equal(
      row.relrowsecurity && row.relforcerowsecurity && row.policies >= 1,
      true,
      row.relname,
    )

  const provider = getSchema({ plugins: [phoneNumber(), twoFactor()] })
  const tableNames = {
    user: 'auth_user',
    session: 'auth_session',
    account: 'auth_account',
    verification: 'auth_verification',
    twoFactor: 'auth_two_factor',
  }
  for (const [model, table] of Object.entries(tableNames)) {
    const columns = await admin.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
      [table],
    )
    const actual = new Set(columns.rows.map((row) => row.column_name))
    for (const [key, field] of Object.entries(provider[model].fields)) {
      const name = (field.fieldName ?? key).replace(
        /[A-Z]/g,
        (letter) => `_${letter.toLowerCase()}`,
      )
      assert.ok(actual.has(name), `${table}.${name} is required by Better Auth`)
    }
  }
})

test.after(async () => admin.end())
test.after(async () => runtime.end())
