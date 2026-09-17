// Creates and migrates the disposable database named by TEST_DATABASE_URL.
// The test suites rewrite fixtures, so they must never touch "erp", the
// development database that pnpm dev:api, pnpm db:fixtures and dev:logins use.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl)
  throw new Error(
    'TEST_DATABASE_URL is required, for example ' +
      'postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp_test',
  )

const target = new URL(testUrl)
const name = decodeURIComponent(target.pathname.replace(/^\//, ''))
if (!name) throw new Error('TEST_DATABASE_URL must name a database')
if (name === 'erp')
  throw new Error(
    'Refusing to prepare "erp": that is the development database. ' +
      'Use a disposable name such as erp_test.',
  )

/** Connects with the same credentials to a database that already exists. */
async function connectMaintenance() {
  let lastError
  for (const maintenance of ['postgres', 'erp']) {
    const url = new URL(target.toString())
    url.pathname = `/${maintenance}`
    const client = new pg.Client({ connectionString: url.toString() })
    try {
      await client.connect()
      return client
    } catch (error) {
      lastError = error
      await client.end().catch(() => undefined)
    }
  }
  throw lastError ?? new Error('No maintenance database could be reached')
}

const admin = await connectMaintenance()
try {
  const existing = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [name],
  )
  if (!existing.rowCount) {
    await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`)
    console.log(`Created database ${name}`)
  } else {
    console.log(`Database ${name} already exists`)
  }
} finally {
  await admin.end().catch(() => undefined)
}

// The restricted logins need to see the schema the migrations then fill.
const created = new pg.Client({ connectionString: target.toString() })
await created.connect()
try {
  await created.query(
    'GRANT USAGE ON SCHEMA public TO erp_runtime, erp_identity, erp_auth',
  )
} finally {
  await created.end().catch(() => undefined)
}

const migrate = spawnSync(process.execPath, [join(here, 'migrate.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, MIGRATION_DATABASE_URL: target.toString() },
})
if (migrate.status !== 0) process.exit(migrate.status ?? 1)
console.log(`Migrated ${name}`)
