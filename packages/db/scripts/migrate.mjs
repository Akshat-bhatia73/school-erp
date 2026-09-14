import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const directory = join(here, '..', 'migrations')
const databaseUrl = process.env.MIGRATION_DATABASE_URL
if (!databaseUrl)
  throw new Error(
    'MIGRATION_DATABASE_URL is required; migrations never use runtime credentials.',
  )
const migrations = (await readdir(directory))
  .filter((name) => name.endsWith('.sql'))
  .sort()
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
try {
  await pool.query("SELECT pg_advisory_lock(hashtext('school-erp-migrations'))")
  await pool.query(
    'CREATE TABLE IF NOT EXISTS erp_schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  )
  for (const name of migrations) {
    const body = await readFile(join(directory, name), 'utf8')
    const checksum = createHash('sha256').update(body).digest('hex')
    const previous = await pool.query(
      'SELECT checksum FROM erp_schema_migrations WHERE name = $1',
      [name],
    )
    if (previous.rowCount) {
      if (previous.rows[0].checksum !== checksum)
        throw new Error(`Applied migration checksum changed: ${name}`)
      continue
    }
    if (process.argv.includes('--check'))
      throw new Error(`Migration is pending: ${name}`)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(body)
      await client.query(
        'INSERT INTO erp_schema_migrations(name, checksum) VALUES ($1,$2)',
        [name, checksum],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
} finally {
  await pool
    .query("SELECT pg_advisory_unlock(hashtext('school-erp-migrations'))")
    .catch(() => undefined)
  await pool.end()
}
