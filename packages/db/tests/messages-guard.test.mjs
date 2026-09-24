import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { createPool, withTenantTransaction } from '../src/index.ts'
import { fixtureIds as i, seedFixtures } from '../scripts/fixtures.mjs'

/**
 * Once a message has gone out, its words and its audience are the record of
 * what was said to whom. The database holds that, not only the API: a sent
 * message keeps its title, body and audience; its status only moves from sent
 * to withdrawn; only a draft can be deleted by the application; anonymisation
 * may still blank the words. A recipient row is written once and only the
 * email's progress and the read receipt move afterwards. Everything here runs
 * as erp_runtime, the login the application uses.
 */

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
const runtime = createPool({ connectionString: roleUrl('erp_runtime'), max: 4 })
const plainRuntime = new pg.Pool({ connectionString: roleUrl('erp_runtime') })
const auth = new pg.Pool({ connectionString: roleUrl('erp_auth') })

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

/** One statement in its own tenant transaction; a refusal poisons the transaction. */
async function asRuntime(schoolId, work) {
  return withTenantTransaction(runtime, context(schoolId), ({ client }) => work(client))
}

function refusedWith(codes, sql, values) {
  return assert.rejects(
    asRuntime(i.schoolA, (client) => client.query(sql, values)),
    (error) => {
      assert.ok(codes.includes(error.code), `${sql}: unexpected ${error.code} ${error.message}`)
      return true
    },
  )
}

/** A notice by the fixture adult, straight into the table as the admin login. */
async function notice(status, extra = {}) {
  const sentAt = status === 'sent' || status === 'withdrawn' ? new Date() : null
  const row = await admin.query(
    `INSERT INTO messages(school_id,kind,audience,recipients,section_id,academic_year_id,title,body,status,sent_at,
                          withdrawn_at,created_by_membership_id,updated_at)
     VALUES ($1,'notice','section','families',$2,$3,'Sports day','Bring water bottles',$4,$5,$6,$7,coalesce($8,now()))
     RETURNING id`,
    [
      i.schoolA,
      i.sectionA,
      i.yearA,
      status,
      extra.sentAt ?? sentAt,
      status === 'withdrawn' ? new Date() : null,
      i.adult,
      extra.updatedAt ?? null,
    ],
  )
  return row.rows[0].id
}

test.before(async () => {
  await seedFixtures(admin)
})
test.after(async () => {
  await Promise.all([admin.end(), runtime.end(), plainRuntime.end(), auth.end()])
})

test('a sent message keeps its words and its audience', async () => {
  const id = await notice('sent')
  const refusal = ['P0001', '23000']
  await refusedWith(refusal, `UPDATE messages SET title = 'Changed' WHERE id = $1`, [id])
  await refusedWith(refusal, `UPDATE messages SET body = 'Changed' WHERE id = $1`, [id])
  await refusedWith(refusal, `UPDATE messages SET audience = 'school', section_id = NULL, academic_year_id = NULL WHERE id = $1`, [id])
  await refusedWith(refusal, `UPDATE messages SET sent_at = now() - interval '1 day' WHERE id = $1`, [id])
  // Task 23: who of the pupils' people it went to is part of its audience.
  await refusedWith(refusal, `UPDATE messages SET recipients = 'both' WHERE id = $1`, [id])
  // A blank title without redacted_at is not anonymisation.
  await refusedWith(['P0001', '23000', '23514'], `UPDATE messages SET title = '', body = '' WHERE id = $1`, [id])
})

test('a sent message only moves on to withdrawn', async () => {
  const id = await notice('sent')
  await refusedWith(['P0001', '23000'], `UPDATE messages SET status = 'draft', sent_at = NULL WHERE id = $1`, [id])
  await refusedWith(
    ['P0001', '23000'],
    `UPDATE messages SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'author_lost_access' WHERE id = $1`,
    [id],
  )
  await asRuntime(i.schoolA, (client) =>
    client.query(
      `UPDATE messages SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by_membership_id = $2 WHERE id = $1`,
      [id, i.adult],
    ),
  )
  await refusedWith(['P0001', '23000'], `UPDATE messages SET status = 'sent', withdrawn_at = NULL WHERE id = $1`, [id])
})

test('the application deletes a draft and nothing else', async () => {
  const sent = await notice('sent')
  await refusedWith(['P0001', '23000'], `DELETE FROM messages WHERE id = $1`, [sent])
  const scheduled = await admin.query(
    `INSERT INTO messages(school_id,kind,audience,recipients,title,body,status,send_at,created_by_membership_id)
     VALUES ($1,'notice','school','families','Later','Later body','scheduled',now() + interval '1 day',$2) RETURNING id`,
    [i.schoolA, i.adult],
  )
  await refusedWith(['P0001', '23000'], `DELETE FROM messages WHERE id = $1`, [scheduled.rows[0].id])
  const draft = await notice('draft')
  const deleted = await asRuntime(i.schoolA, (client) => client.query(`DELETE FROM messages WHERE id = $1`, [draft]))
  assert.equal(deleted.rowCount, 1)
})

test('anonymisation may blank the words of a sent message', async () => {
  const id = await notice('sent')
  await asRuntime(i.schoolA, (client) =>
    client.query(`UPDATE messages SET title = '', body = '', redacted_at = now() WHERE id = $1`, [id]),
  )
  const row = await admin.query(`SELECT title, body, redacted_at FROM messages WHERE id = $1`, [id])
  assert.equal(row.rows[0].title, '')
  assert.equal(row.rows[0].body, '')
  assert.ok(row.rows[0].redacted_at)
})

test('a recipient row only moves its email progress and read receipt', async () => {
  const id = await notice('sent')
  const recipient = await admin.query(
    `INSERT INTO message_recipients(school_id,message_id,guardian_id,membership_id,student_id,section_id,academic_year_id,
                                    sender_membership_id,outcome,in_app,email_status,email_masked,email_next_attempt_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'delivered',true,'pending','p•••@gmail.com',now()) RETURNING id`,
    [i.schoolA, id, i.guardianA, i.parentA2, i.studentA, i.sectionA, i.yearA, i.adult],
  )
  const rid = recipient.rows[0].id
  await asRuntime(i.schoolA, (client) =>
    client.query(
      `UPDATE message_recipients SET read_at = now(), email_status = 'sent', email_sent_at = now(), email_attempts = 1,
              email_next_attempt_at = NULL, email_masked = NULL WHERE id = $1`,
      [rid],
    ),
  )
  for (const assignment of [
    `outcome = 'no_consent'`,
    `in_app = false`,
    `membership_id = NULL`,
    `guardian_id = $2`,
    `student_id = NULL`,
    `message_id = message_id`,
  ]) {
    const values = assignment.includes('$2') ? [rid, i.guardianA2] : [rid]
    await refusedWith(['42501'], `UPDATE message_recipients SET ${assignment} WHERE id = $1`, values)
  }
  await refusedWith(['42501'], `DELETE FROM message_recipients WHERE id = $1`, [rid])
})

test('the maintenance functions list, forget and sweep', async () => {
  const schools = await plainRuntime.query('SELECT school_id FROM list_message_schools()')
  const ids = schools.rows.map((row) => row.school_id)
  assert.ok(ids.includes(i.schoolA) && ids.includes(i.schoolB))

  const old = new Date(Date.now() - 3 * 365 * 86_400_000)
  const expired = await notice('sent', { sentAt: old, updatedAt: old })
  const fresh = await notice('sent')
  const staleDraft = await notice('draft', { updatedAt: new Date(Date.now() - 400 * 86_400_000) })
  const key = `messages/${i.schoolA}/${expired}/${crypto.randomUUID()}`
  const attachment = await admin.query(
    `INSERT INTO message_attachments(school_id,message_id,file_name,content_type,size_bytes,storage_key)
     VALUES ($1,$2,'notice.pdf','application/pdf',10,$3) RETURNING id`,
    [i.schoolA, expired, key],
  )
  const attachmentId = attachment.rows[0].id

  const listed = await plainRuntime.query('SELECT * FROM list_expired_message_attachments()')
  assert.ok(listed.rows.some((row) => row.id === attachmentId && row.storage_key === key))

  // While the bytes are still named, the sweep keeps the message.
  await plainRuntime.query('SELECT * FROM sweep_messages()')
  assert.equal((await admin.query('SELECT 1 FROM messages WHERE id = $1', [expired])).rowCount, 1)
  assert.equal((await admin.query('SELECT 1 FROM messages WHERE id = $1', [staleDraft])).rowCount, 0)

  await plainRuntime.query('SELECT forget_message_attachment($1, $2)', [i.schoolA, attachmentId])
  const after = await plainRuntime.query('SELECT * FROM list_expired_message_attachments()')
  assert.ok(!after.rows.some((row) => row.id === attachmentId))

  const swept = await plainRuntime.query('SELECT * FROM sweep_messages()')
  assert.equal(swept.rows[0].item, 'messages')
  assert.equal((await admin.query('SELECT 1 FROM messages WHERE id = $1', [expired])).rowCount, 0)
  assert.equal((await admin.query('SELECT 1 FROM message_attachments WHERE id = $1', [attachmentId])).rowCount, 0)
  assert.equal((await admin.query('SELECT 1 FROM messages WHERE id = $1', [fresh])).rowCount, 1)
})

test('only the runtime login may run the message maintenance functions', async () => {
  for (const sql of [
    'SELECT * FROM list_message_schools()',
    'SELECT * FROM list_expired_message_attachments()',
    `SELECT forget_message_attachment('${i.schoolA}', '${i.schoolA}')`,
    'SELECT * FROM sweep_messages()',
  ])
    await assert.rejects(auth.query(sql), (error) => {
      assert.equal(error.code, '42501', `${sql}: ${error.code} ${error.message}`)
      return true
    })
  const grants = await admin.query(
    `SELECT p.proname,
            has_function_privilege('erp_runtime', p.oid, 'EXECUTE') AS runtime,
            has_function_privilege('erp_auth', p.oid, 'EXECUTE') AS auth,
            has_function_privilege('erp_identity_reader', p.oid, 'EXECUTE') AS identity
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('list_message_schools','list_expired_message_attachments','forget_message_attachment','sweep_messages')`,
  )
  assert.equal(grants.rowCount, 4)
  for (const row of grants.rows) {
    assert.equal(row.runtime, true, row.proname)
    assert.equal(row.auth, false, row.proname)
    assert.equal(row.identity, false, row.proname)
  }
})
