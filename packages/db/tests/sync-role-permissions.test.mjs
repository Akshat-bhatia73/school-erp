import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { ROLE_TEMPLATES } from '@erp/contracts'
import { fixtureIds as i, seedFixtures } from '../scripts/fixtures.mjs'

const connectionString = process.env.TEST_DATABASE_URL
if (!connectionString) throw new Error('TEST_DATABASE_URL is required')
if (new URL(connectionString).pathname === '/erp')
  throw new Error(
    'The db tests refuse to run against "erp", the development database; use erp_test (pnpm db:test:prepare)',
  )
const pool = new pg.Pool({ connectionString })
const script = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'sync-role-permissions.mjs',
)

function runSync(...args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MIGRATION_DATABASE_URL: connectionString },
  })
}

async function roleId(school, key) {
  const r = await pool.query(
    'SELECT id FROM roles WHERE school_id = $1 AND key = $2',
    [school, key],
  )
  assert.equal(r.rowCount, 1, `${school}:${key}`)
  return r.rows[0].id
}

async function grants(school, roleKey) {
  const id = await roleId(school, roleKey)
  const r = await pool.query(
    'SELECT permission, scope FROM role_permissions WHERE school_id = $1 AND role_id = $2',
    [school, id],
  )
  return new Set(r.rows.map((x) => `${x.permission}:${x.scope}`))
}

function templateSet(key) {
  return new Set(ROLE_TEMPLATES[key].grants.map((g) => `${g.permission}:${g.scope}`))
}

test.before(async () => {
  await seedFixtures(pool)
})

test.after(async () => {
  await pool.end()
})

test('the script restores every missing template grant and leaves no drift', async () => {
  const ownerA = await roleId(i.schoolA, 'owner')
  const parentB = await roleId(i.schoolB, 'parent')
  const removedOwner = ROLE_TEMPLATES.owner.grants.slice(0, 2)
  const removedParent = ROLE_TEMPLATES.parent.grants.slice(0, 1)
  for (const g of removedOwner)
    await pool.query(
      'DELETE FROM role_permissions WHERE school_id=$1 AND role_id=$2 AND permission=$3 AND scope=$4',
      [i.schoolA, ownerA, g.permission, g.scope],
    )
  for (const g of removedParent)
    await pool.query(
      'DELETE FROM role_permissions WHERE school_id=$1 AND role_id=$2 AND permission=$3 AND scope=$4',
      [i.schoolB, parentB, g.permission, g.scope],
    )
  assert.equal((await grants(i.schoolA, 'owner')).size, templateSet('owner').size - 2)

  const run = runSync()
  assert.equal(run.status, 0, run.stderr)
  assert.doesNotMatch(run.stdout, /postgres:\/\//)

  // Both schools now mirror every template exactly, the integrity expectation.
  for (const school of [i.schoolA, i.schoolB])
    for (const key of Object.keys(ROLE_TEMPLATES))
      assert.deepEqual(await grants(school, key), templateSet(key), `${school}:${key}`)
})

test('extra grants are reported and only removed with --prune', async () => {
  const ownerA = await roleId(i.schoolA, 'owner')
  await pool.query(
    'INSERT INTO role_permissions(school_id,role_id,permission,scope) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [i.schoolA, ownerA, 'bogus.permission', 'school'],
  )

  const reported = runSync()
  assert.equal(reported.status, 0, reported.stderr)
  assert.match(reported.stdout, /extra owner: bogus\.permission:school/)
  assert.ok(
    (await grants(i.schoolA, 'owner')).has('bogus.permission:school'),
    'a run without --prune must not delete anything',
  )

  const prunedRun = runSync('--prune')
  assert.equal(prunedRun.status, 0, prunedRun.stderr)
  assert.match(prunedRun.stdout, /pruned 1/)
  assert.deepEqual(await grants(i.schoolA, 'owner'), templateSet('owner'))
})

test('a system role missing entirely is recreated with its grants', async () => {
  // accountant carries no fixture membership_roles row, so it can be dropped
  // and restored without disturbing the deterministic fixture role ids.
  const key = 'accountant'
  const id = await roleId(i.schoolB, key)
  await pool.query('DELETE FROM roles WHERE school_id=$1 AND id=$2', [i.schoolB, id])

  const run = runSync()
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(await grants(i.schoolB, key), templateSet(key))

  // Put the fixture id back so later suites keep their deterministic ids.
  await pool.query('DELETE FROM roles WHERE school_id=$1 AND key=$2', [i.schoolB, key])
  await seedFixtures(pool)
  assert.equal(await roleId(i.schoolB, key), id)
})

test('the script fails loudly without a connection', async () => {
  const run = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, MIGRATION_DATABASE_URL: '' },
  })
  assert.notEqual(run.status, 0)
})
