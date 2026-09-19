// Brings every school's system roles back in line with ROLE_TEMPLATES.
//
// Role grants live in role_permissions per school and are written only when a
// school is seeded, so a school seeded before a template gained a permission
// keeps refusing that route: the authorizer reads the table, not the template.
// This script inserts the missing (permission, scope) pairs. It never deletes
// unless --prune is passed; drift in the other direction is only reported.
//
// Connects with MIGRATION_DATABASE_URL, the same credential as the migrator,
// and holds the same advisory lock so it cannot race a deploy.
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { ROLE_TEMPLATES } from '@erp/contracts'

const databaseUrl = process.env.MIGRATION_DATABASE_URL
if (!databaseUrl)
  throw new Error(
    'MIGRATION_DATABASE_URL is required; this script never uses runtime credentials.',
  )
const prune = process.argv.includes('--prune')

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
let added = 0
let extra = 0
let pruned = 0
let createdRoles = 0

try {
  await pool.query("SELECT pg_advisory_lock(hashtext('school-erp-migrations'))")
  const schools = await pool.query(
    'SELECT id, name FROM schools ORDER BY created_at, id',
  )
  for (const school of schools.rows) {
    const client = await pool.connect()
    let schoolAdded = 0
    let schoolExtra = 0
    let schoolPruned = 0
    try {
      await client.query('BEGIN')
      // The migrator is a superuser locally but only the table owner on Neon,
      // where FORCE ROW LEVEL SECURITY applies to it too; SET LOCAL makes this
      // work the same in both, exactly as withTenantTransaction does at runtime.
      await client.query("SELECT set_config('app.school_id', $1, true)", [
        school.id,
      ])
      for (const [key, template] of Object.entries(ROLE_TEMPLATES)) {
        const found = await client.query(
          'SELECT id FROM roles WHERE school_id = $1 AND key = $2 AND is_system = TRUE',
          [school.id, key],
        )
        let roleId = found.rows[0]?.id
        if (!roleId) {
          roleId = randomUUID()
          const inserted = await client.query(
            'INSERT INTO roles(id,school_id,key,name,is_system) VALUES ($1,$2,$3,$4,true) ON CONFLICT (school_id,key) DO NOTHING RETURNING id',
            [roleId, school.id, key, template.displayName],
          )
          if (!inserted.rowCount) continue // a non-system role already owns the key
          createdRoles += 1
        }
        const wanted = new Set(
          template.grants.map((g) => `${g.permission}\u0000${g.scope}`),
        )
        const present = await client.query(
          'SELECT permission, scope FROM role_permissions WHERE school_id = $1 AND role_id = $2',
          [school.id, roleId],
        )
        const have = new Set(
          present.rows.map((r) => `${r.permission}\u0000${r.scope}`),
        )
        for (const grant of template.grants) {
          if (have.has(`${grant.permission}\u0000${grant.scope}`)) continue
          const result = await client.query(
            'INSERT INTO role_permissions(school_id,role_id,permission,scope) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
            [school.id, roleId, grant.permission, grant.scope],
          )
          schoolAdded += result.rowCount ?? 0
        }
        for (const row of present.rows) {
          if (wanted.has(`${row.permission}\u0000${row.scope}`)) continue
          schoolExtra += 1
          console.log(
            `  extra ${key}: ${row.permission}:${row.scope}${prune ? ' (pruned)' : ''}`,
          )
          if (prune) {
            const deleted = await client.query(
              'DELETE FROM role_permissions WHERE school_id = $1 AND role_id = $2 AND permission = $3 AND scope = $4',
              [school.id, roleId, row.permission, row.scope],
            )
            schoolPruned += deleted.rowCount ?? 0
          }
        }
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    added += schoolAdded
    extra += schoolExtra
    pruned += schoolPruned
    console.log(
      `${school.id} ${school.name}: added ${schoolAdded}, extra ${schoolExtra}${prune ? ` (pruned ${schoolPruned})` : ''}`,
    )
  }
  console.log(
    `Total: ${schools.rowCount} schools, ${createdRoles} roles created, ${added} grants added, ${extra} extra${prune ? ` (pruned ${pruned})` : ''}`,
  )
  if (extra && !prune)
    console.log('Extra grants were left in place; re-run with --prune to remove them.')
} catch (error) {
  console.error(`sync-role-permissions failed: ${error.message}`)
  process.exitCode = 1
} finally {
  await pool
    .query("SELECT pg_advisory_unlock(hashtext('school-erp-migrations'))")
    .catch(() => undefined)
  await pool.end().catch(() => undefined)
}
