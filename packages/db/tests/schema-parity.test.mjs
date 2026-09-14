import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { getTableColumns, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '../src/schema.ts'

const connectionString = process.env.TEST_DATABASE_URL
if (!connectionString)
  throw new Error(
    'TEST_DATABASE_URL must name the migrated disposable PostgreSQL database',
  )
const pool = new pg.Pool({ connectionString })

const exportedTables = Object.entries(schema)
  .filter(
    ([, value]) =>
      value && typeof value === 'object' && value[Symbol.for('drizzle:Name')],
  )
  .map(([, table]) => table)

function liveType(column) {
  if (column.data_type === 'ARRAY') {
    const element =
      {
        int2: 'smallint',
        int4: 'integer',
        int8: 'bigint',
        uuid: 'uuid',
        text: 'text',
      }[column.udt_name.slice(1)] ?? column.udt_name.slice(1)
    return `${element}[]`
  }
  if (column.data_type === 'USER-DEFINED') return column.udt_name
  if (column.data_type === 'timestamp with time zone')
    return 'timestamp with time zone'
  if (column.data_type === 'numeric') return 'numeric'
  return column.data_type
}

test('every exported Drizzle table has the live PostgreSQL columns, types and nullability', async () => {
  const live = await pool.query(`
    SELECT table_name, column_name, data_type, udt_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name <> 'erp_schema_migrations'
    ORDER BY table_name, ordinal_position
  `)
  const byTable = Map.groupBy(live.rows, (row) => row.table_name)
  const exportedNames = new Set(
    exportedTables.map((table) => table[Symbol.for('drizzle:Name')]),
  )
  assert.deepEqual(
    [...exportedNames].sort(),
    [...byTable.keys()].sort(),
    'no live application table may be absent from schema exports',
  )

  for (const table of exportedTables) {
    const name = table[Symbol.for('drizzle:Name')]
    const columns = getTableColumns(table)
    const expected = new Map(
      Object.values(columns).map((column) => [column.name, column]),
    )
    const actual = byTable.get(name)
    assert.deepEqual(
      [...expected.keys()].sort(),
      actual.map((column) => column.column_name).sort(),
      name,
    )
    for (const dbColumn of actual) {
      const drizzleColumn = expected.get(dbColumn.column_name)
      assert.equal(
        drizzleColumn.getSQLType(),
        liveType(dbColumn),
        `${name}.${dbColumn.column_name} type`,
      )
      assert.equal(
        !drizzleColumn.notNull,
        dbColumn.is_nullable === 'YES',
        `${name}.${dbColumn.column_name} nullability`,
      )
    }
  }
})

test('Drizzle selects current fixed-field domain models without removed generic blobs', async () => {
  const db = drizzle(pool, { schema })
  for (const table of [schema.schools, schema.staff, schema.students]) {
    await db.select().from(table).limit(1)
    const names = Object.keys(getTableColumns(table))
    assert.equal(
      names.some((name) =>
        /(?:basic|sensitive|medical|private|pay|contact)Data/.test(name),
      ),
      false,
    )
  }
  await db.execute(sql`SELECT 1`)
})

test.after(async () => pool.end())
