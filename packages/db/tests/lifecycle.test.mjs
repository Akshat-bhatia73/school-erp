import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { fixtureIds as i, seedFixtures } from '../scripts/fixtures.mjs'

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

test.before(async () => {
  await seedFixtures(admin)
})
test.after(async () => {
  await Promise.all([admin.end(), runtime.end(), auth.end()])
})

test('the runtime login cannot DELETE a person or a document', async () => {
  for (const table of ['students', 'guardians', 'staff', 'student_documents'])
    await refused(runtime, `DELETE FROM ${table}`, [], '42501')
})

test('consent history is append-only', async () => {
  const client = await admin.connect()
  try {
    const consent = await client.query(
      `INSERT INTO guardian_consents(school_id,student_id,guardian_id,purpose,status,method,recorded_by_membership_id)
       VALUES ($1,$2,$3,'photographs','given','signed_form',$4) RETURNING id`,
      [i.schoolA, i.studentA, i.guardianA, i.adult],
    )
    const id = consent.rows[0].id
    await refused(
      admin,
      `UPDATE guardian_consents SET status='withdrawn' WHERE id=$1`,
      [id],
      'P0001',
    )
    await refused(admin, `DELETE FROM guardian_consents WHERE id=$1`, [id], 'P0001')
    // Withdrawal is a newer row, which is why the table needs no UPDATE.
    await client.query(
      `INSERT INTO guardian_consents(school_id,student_id,guardian_id,purpose,status,method,recorded_by_membership_id)
       VALUES ($1,$2,$3,'photographs','withdrawn','portal',$4)`,
      [i.schoolA, i.studentA, i.guardianA, i.adult],
    )
    const current = await client.query(
      `SELECT status FROM guardian_consents WHERE school_id=$1 AND student_id=$2 AND guardian_id=$3 AND purpose='photographs' ORDER BY recorded_at DESC, created_at DESC LIMIT 1`,
      [i.schoolA, i.studentA, i.guardianA],
    )
    assert.equal(current.rows[0].status, 'withdrawn')
  } finally {
    client.release()
  }
})

test('each sweep function is executable by exactly one login', async () => {
  await refused(runtime, 'SELECT * FROM sweep_auth_transients()', [], '42501')
  await refused(auth, 'SELECT * FROM sweep_tenant_transients()', [], '42501')
  await refused(
    runtime,
    "SELECT * FROM sweep_orphaned_credentials(interval '30 days')",
    [],
    '42501',
  )
})

test('one tenant sweep with no school context clears expired previews in both schools', async () => {
  const yearB = crypto.randomUUID()
  await admin.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status) VALUES ($1,$2,'2026-27','2026-04-01','2027-03-31','current') ON CONFLICT (school_id,name) DO NOTHING`,
    [yearB, i.schoolB],
  )
  const previewA = crypto.randomUUID(),
    previewB = crypto.randomUUID()
  await admin.query(
    `INSERT INTO student_import_previews(id,school_id,created_by_membership_id,academic_year_id,status,total_rows,valid_rows,rows,expires_at)
     VALUES ($1,$2,$3,$4,'pending',1,1,'[]'::jsonb,now() - interval '1 hour'),
            ($5,$6,$7,(SELECT id FROM academic_years WHERE school_id=$6 LIMIT 1),'pending',1,1,'[]'::jsonb,now() - interval '1 hour')`,
    [previewA, i.schoolA, i.adult, i.yearA, previewB, i.schoolB, i.ownerB],
  )
  const swept = await runtime.query('SELECT * FROM sweep_tenant_transients()')
  const previews = swept.rows.find((row) => row.item === 'import_previews')
  assert.ok(previews.count >= 2, 'both previews are counted')
  const left = await admin.query(
    'SELECT id FROM student_import_previews WHERE id = ANY($1)',
    [[previewA, previewB]],
  )
  assert.equal(left.rowCount, 0)
})

test('a spent invitation keeps its status and digest while its contact is blanked', async () => {
  const invitation = crypto.randomUUID()
  await admin.query(
    `INSERT INTO school_invitations(id,school_id,identifier_type,identifier_normalized,destination_masked,token_digest,status,proposed_role_keys,staff_id,inviter_membership_id,expires_at,accepted_at)
     VALUES ($1::uuid,$2,'email','parent@example.test','p••••@example.test','digest-' || $1::text,'accepted','{teacher}',$3,$4,now() + interval '1 day',now())`,
    [invitation, i.schoolA, i.staffA, i.adult],
  )
  await admin.query(
    `UPDATE school_invitations SET identifier_normalized='' WHERE id=$1`,
    [invitation],
  )
  const row = await admin.query(
    'SELECT identifier_normalized, status, token_digest FROM school_invitations WHERE id=$1',
    [invitation],
  )
  assert.equal(row.rows[0].identifier_normalized, '')
  assert.equal(row.rows[0].status, 'accepted')
  assert.ok(row.rows[0].token_digest)
  // Reviving a terminal invitation is still refused.
  await refused(
    admin,
    `UPDATE school_invitations SET status='pending' WHERE id=$1`,
    [invitation],
    'P0001',
  )
  await admin.query('DELETE FROM school_invitations WHERE id=$1', [invitation])
})

test('credentials of a long-removed member are cleared and an active member is untouched', async () => {
  const orphan = crypto.randomUUID(),
    kept = crypto.randomUUID()
  await admin.query(
    `INSERT INTO auth_user(id,name,email,phone_number,two_factor_enabled) VALUES
       ($1::uuid,'Left Long Ago','orphan-' || $1::text || '@test','+91' || substr(replace($1::text,'-',''),1,10),TRUE),
       ($2::uuid,'Still Here','kept-' || $2::text || '@test','+91' || substr(replace($2::text,'-',''),1,10),TRUE)`,
    [orphan, kept],
  )
  // Back-dated far past any real row so the sweep can be given a grace no other
  // fixture user can satisfy.
  await admin.query(
    `INSERT INTO school_memberships(school_id,user_id,kind,status,updated_at) VALUES
       ($1,$2,'adult','removed',now() - interval '1001 years'),
       ($1,$3,'adult','active',now() - interval '1001 years')`,
    [i.schoolA, orphan, kept],
  )
  await admin.query(
    `INSERT INTO auth_session(token,user_id,expires_at) VALUES ('session-' || $1::text,$1::uuid,now() + interval '1 day'),('session-' || $2::text,$2::uuid,now() + interval '1 day')`,
    [orphan, kept],
  )
  await admin.query(
    `INSERT INTO auth_account(account_id,provider_id,user_id,password) VALUES ($1::text,'credential',$1::uuid,'hash')`,
    [orphan],
  )

  const swept = await auth.query(
    "SELECT * FROM sweep_orphaned_credentials(interval '1000 years')",
  )
  assert.ok(swept.rows.find((row) => row.item === 'users').count >= 1)

  const after = await admin.query(
    'SELECT id, name, email, phone_number, two_factor_enabled FROM auth_user WHERE id = ANY($1) ORDER BY id',
    [[orphan, kept]],
  )
  const seen = new Map(after.rows.map((row) => [row.id, row]))
  assert.equal(seen.get(orphan).email, `removed+${orphan}@invalid.local`)
  assert.equal(seen.get(orphan).phone_number, null)
  assert.equal(seen.get(orphan).two_factor_enabled, false)
  assert.equal(seen.get(orphan).name, 'Left Long Ago', 'attribution survives')
  assert.match(seen.get(kept).email, /^kept-/)
  assert.equal(seen.get(kept).two_factor_enabled, true)

  const sessions = await admin.query(
    'SELECT user_id FROM auth_session WHERE user_id = ANY($1)',
    [[orphan, kept]],
  )
  assert.deepEqual(
    sessions.rows.map((row) => row.user_id),
    [kept],
  )
  assert.equal(
    (await admin.query('SELECT 1 FROM auth_account WHERE user_id=$1', [orphan]))
      .rowCount,
    0,
  )
})
