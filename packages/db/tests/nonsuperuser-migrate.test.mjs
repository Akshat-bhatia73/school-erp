// A managed PostgreSQL (Neon) hands the migrator a database owner with
// CREATEROLE and no superuser. Locally and in CI the migrator is a superuser,
// which hides two checks: ALTER FUNCTION ... OWNER TO needs the migrator to be
// a member of the new owner role, and needs that role to hold CREATE on the
// function's schema. This test reproduces the managed shape on purpose: a
// NOSUPERUSER login owning a fresh database, running the real migration runner
// from empty.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { after, before, test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const url = process.env.TEST_DATABASE_URL
if (!url) throw new Error('TEST_DATABASE_URL is required')
if (new URL(url).pathname === '/erp')
  throw new Error(
    'The db tests refuse to run against "erp", the development database; use erp_test (pnpm db:test:prepare)',
  )

const role = 'erp_test_migrator'
const password = 'erp_test_migrator'
const database = `erp_nonsuper_${randomBytes(4).toString('hex')}`
const quoted = `"${database.replace(/"/g, '""')}"`

/** The superuser connection that builds and tears down the sandbox. */
const admin = new pg.Client({ connectionString: url })
let migrated

function targetUrl() {
  const value = new URL(url)
  value.username = role
  value.password = password
  value.pathname = `/${database}`
  return value.toString()
}

before(async () => {
  await admin.connect()
  await admin.query(`DROP ROLE IF EXISTS ${role}`)
  // What a Neon database owner is: it may make roles and databases, and it is
  // not a superuser and does not bypass row level security.
  await admin.query(
    `CREATE ROLE ${role} LOGIN PASSWORD '${password}' CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS`,
  )
  await admin.query(`CREATE DATABASE ${quoted} OWNER ${role}`)

  // Roles are cluster-wide, so erp_identity_reader and erp_maintenance already
  // exist here from the other test databases. On a genuinely empty managed
  // database the migrator creates them itself and is their administrator by
  // that fact; giving the sandbox migrator the ADMIN option reproduces that
  // starting point without disturbing the shared cluster.
  for (const owned of ['erp_identity_reader', 'erp_maintenance'])
    await admin
      .query(`GRANT ${owned} TO ${role} WITH ADMIN OPTION`)
      .catch(() => undefined)

  // Schema public belongs to pg_database_owner from PostgreSQL 15, so owning
  // the database is already CREATE there; the restricted logins still need to
  // see the schema, exactly as prepare-test-db.mjs arranges it.
  const seedUrl = new URL(url)
  seedUrl.pathname = `/${database}`
  const seed = new pg.Client({ connectionString: seedUrl.toString() })
  await seed.connect()
  try {
    await seed.query(
      'GRANT USAGE ON SCHEMA public TO erp_runtime, erp_identity, erp_auth',
    )
  } finally {
    await seed.end().catch(() => undefined)
  }
})

after(async () => {
  await migrated?.end().catch(() => undefined)
  await admin
    .query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`)
    .catch(() => undefined)
  await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined)
  await admin.end().catch(() => undefined)
})

test('the migration runner completes from empty as a non-superuser migrator', async () => {
  const run = spawnSync(process.execPath, [join(here, '..', 'scripts', 'migrate.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, MIGRATION_DATABASE_URL: targetUrl() },
  })
  assert.equal(
    run.status,
    0,
    'a database owner without superuser must be able to migrate from empty',
  )

  migrated = new pg.Client({ connectionString: targetUrl() })
  await migrated.connect()

  const owners = await migrated.query(`
    SELECT p.proname, pg_get_userbyid(p.proowner) AS owner
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'sweep\\_%'
    ORDER BY p.proname
  `)
  assert.ok(owners.rowCount > 0, 'the sweep functions must exist')
  for (const row of owners.rows)
    assert.equal(
      row.owner,
      'erp_maintenance',
      `${row.proname} must be owned by erp_maintenance`,
    )

  const identityOwned = await migrated.query(`
    SELECT pg_get_userbyid(p.proowner) AS owner
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'active_adult_memberships_for_user'
  `)
  assert.equal(identityOwned.rows[0]?.owner, 'erp_identity_reader')

  const privileges = await migrated.query(`
    SELECT
      has_schema_privilege('erp_maintenance', 'public', 'CREATE') AS maintenance_create,
      has_schema_privilege('erp_maintenance', 'public', 'USAGE') AS maintenance_usage,
      has_schema_privilege('erp_identity_reader', 'public', 'CREATE') AS reader_create,
      has_schema_privilege('erp_identity_reader', 'public', 'USAGE') AS reader_usage
  `)
  const grants = privileges.rows[0]
  assert.equal(grants.maintenance_create, false, 'the bootstrap CREATE grant must be revoked')
  assert.equal(grants.reader_create, false, 'the bootstrap CREATE grant must be revoked')
  assert.equal(grants.maintenance_usage, true)
  assert.equal(grants.reader_usage, true)
})
