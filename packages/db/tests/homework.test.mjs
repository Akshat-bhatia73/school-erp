import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { createPool, withTenantTransaction } from '../src/index.ts'
import { fixtureIds as i, seedFixtures } from '../scripts/fixtures.mjs'

/**
 * Homework (migration 0030) as the database holds it, whatever the API does:
 * an item keeps its class, subject and author; removing is for good; nobody
 * the API runs as deletes an item; a check-off always agrees with its item
 * and is never deleted; the sweep removes an item a year after its own year
 * ended, files first, and leaves the pupil's check-offs behind. Everything
 * here runs as erp_runtime unless it says otherwise.
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

let subjectId = ''
let otherSubjectId = ''
let oldYear = ''
let oldSection = ''

async function item(extra = {}) {
  const row = await asRuntime(i.schoolA, (client) =>
    client.query(
      `INSERT INTO homework(school_id,academic_year_id,section_id,subject_id,title,instructions,set_on,due_on,
                            created_by_membership_id,updated_by_membership_id)
       VALUES ($1,$2,$3,$4,'Exercise 4.2','Questions 1 to 5',$5,$6,$7,$7) RETURNING id`,
      [
        i.schoolA,
        extra.yearId ?? i.yearA,
        extra.sectionId ?? i.sectionA,
        extra.subjectId === undefined ? subjectId : extra.subjectId,
        extra.setOn ?? '2026-10-05',
        extra.dueOn ?? '2026-10-07',
        i.ownerA,
      ],
    ),
  )
  return row.rows[0].id
}

async function check(homeworkId, extra = {}) {
  const row = await asRuntime(i.schoolA, (client) =>
    client.query(
      `INSERT INTO homework_checks(school_id,homework_id,student_id,academic_year_id,section_id,subject_id,status,remark,
                                   checked_by_membership_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        i.schoolA,
        homeworkId,
        extra.studentId ?? i.studentA,
        extra.yearId ?? i.yearA,
        extra.sectionId ?? i.sectionA,
        extra.subjectId === undefined ? subjectId : extra.subjectId,
        extra.status ?? 'done',
        extra.remark ?? null,
        i.ownerA,
      ],
    ),
  )
  return row.rows[0].id
}

test.before(async () => {
  await seedFixtures(admin)
  const tag = crypto.randomUUID().slice(0, 8)
  const subject = async (name) =>
    (
      await admin.query(
        `INSERT INTO subjects(school_id,name,code,type) VALUES ($1,$2,$3,'scholastic') RETURNING id`,
        [i.schoolA, `${name} ${tag}`, `${name}-${tag}`],
      )
    ).rows[0].id
  subjectId = await subject('HwMaths')
  otherSubjectId = await subject('HwScience')
  oldYear = (
    await admin.query(
      `INSERT INTO academic_years(school_id,name,start_date,end_date,status)
       VALUES ($1,$2,'2023-04-01','2024-03-31','closed') RETURNING id`,
      [i.schoolA, `Homework old ${tag}`],
    )
  ).rows[0].id
  oldSection = (
    await admin.query(
      `INSERT INTO sections(school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4) RETURNING id`,
      [i.schoolA, oldYear, i.gradeA, `Old ${tag}`],
    )
  ).rows[0].id
})
test.after(async () => {
  await Promise.all([admin.end(), runtime.end(), plainRuntime.end(), auth.end()])
})

test('an item is due on or after the day it was set, within 60 days, with words in bounds', async () => {
  await refusedWith(['23514'], `UPDATE homework SET due_on = set_on - 1 WHERE id = $1`, [await item()])
  await assert.rejects(item({ setOn: '2026-10-05', dueOn: '2026-12-05' }), (error) => error.code === '23514')
  await assert.rejects(item({ setOn: '2026-10-05', dueOn: '2026-10-04' }), (error) => error.code === '23514')
  const id = await item({ setOn: '2026-10-05', dueOn: '2026-12-04' })
  await refusedWith(['23514'], `UPDATE homework SET title = '' WHERE id = $1`, [id])
  await refusedWith(['23514'], `UPDATE homework SET title = repeat('x', 121) WHERE id = $1`, [id])
  await refusedWith(['23514'], `UPDATE homework SET instructions = repeat('x', 4001) WHERE id = $1`, [id])
  // A removal names who removed it.
  await refusedWith(['23514'], `UPDATE homework SET removed_at = now() WHERE id = $1`, [id])
})

test('an item keeps its class, subject, set day and author; removal is for good; nobody deletes one', async () => {
  const id = await item()
  const refusal = ['P0001', '23000']
  await refusedWith(refusal, `UPDATE homework SET subject_id = $2 WHERE id = $1`, [id, otherSubjectId])
  await refusedWith(refusal, `UPDATE homework SET subject_id = NULL WHERE id = $1`, [id])
  await refusedWith(refusal, `UPDATE homework SET set_on = set_on + 1 WHERE id = $1`, [id])
  await refusedWith(refusal, `UPDATE homework SET created_by_membership_id = $2 WHERE id = $1`, [id, i.adult])
  await refusedWith(refusal, `UPDATE homework SET section_id = $2, academic_year_id = $3 WHERE id = $1`, [
    id,
    oldSection,
    oldYear,
  ])
  // The words, the due date and the version move.
  await asRuntime(i.schoolA, (client) =>
    client.query(
      `UPDATE homework SET title = 'Exercise 4.3', due_on = '2026-10-08', version = version + 1, updated_at = now()
        WHERE id = $1`,
      [id],
    ),
  )
  await asRuntime(i.schoolA, (client) =>
    client.query(`UPDATE homework SET removed_at = now(), removed_by_membership_id = $2 WHERE id = $1`, [id, i.ownerA]),
  )
  await refusedWith(refusal, `UPDATE homework SET removed_at = NULL, removed_by_membership_id = NULL WHERE id = $1`, [id])
  await refusedWith(['42501'], `DELETE FROM homework WHERE id = $1`, [id])
  // Not even the migrator's own login deletes one outside the sweep.
  await assert.rejects(admin.query(`DELETE FROM homework WHERE id = $1`, [id]), (error) => refusal.includes(error.code))
})

test('a check-off agrees with its item, keeps its pupil and is never deleted', async () => {
  const id = await item()
  const general = await item({ subjectId: null })
  // The subject, the section and the year are the item's.
  await assert.rejects(check(id, { subjectId: otherSubjectId }), (error) => ['P0001', '23000'].includes(error.code))
  await assert.rejects(check(id, { subjectId: null }), (error) => ['P0001', '23000'].includes(error.code))
  await assert.rejects(check(general, { subjectId }), (error) => ['P0001', '23000'].includes(error.code))
  await assert.rejects(check(id, { sectionId: oldSection, yearId: oldYear }), (error) => error.code === '23503')
  await assert.rejects(check(id, { status: 'not_checked' }), (error) => error.code === '23514')
  await assert.rejects(check(id, { remark: 'x'.repeat(201) }), (error) => error.code === '23514')
  const checkId = await check(id, { remark: 'Neat work' })
  await check(general, { subjectId: null })
  // One per pupil and item.
  await assert.rejects(check(id), (error) => error.code === '23505')
  // The status and the remark move; anonymisation clears the remark.
  await asRuntime(i.schoolA, (client) =>
    client.query(
      `UPDATE homework_checks SET status = 'partly_done', remark = NULL, version = version + 1, updated_at = now(),
              checked_at = now(), checked_by_membership_id = $2
        WHERE id = $1`,
      [checkId, i.adult],
    ),
  )
  for (const assignment of [`student_id = '${i.studentA2}'`, `homework_id = '${general}'`, `subject_id = NULL`])
    await refusedWith(['42501'], `UPDATE homework_checks SET ${assignment} WHERE id = $1`, [checkId])
  await refusedWith(['42501'], `DELETE FROM homework_checks WHERE id = $1`, [checkId])
})

test('a removed item, its files and its check-offs stay as they were; anonymising still clears a remark', async () => {
  const id = await item()
  const refusal = ['P0001', '23000']
  const checkId = await check(id, { remark: 'Neat work' })
  const fileId = (
    await asRuntime(i.schoolA, (client) =>
      client.query(
        `INSERT INTO homework_attachments(school_id,homework_id,file_name,content_type,size_bytes,storage_key,
                                          created_by_membership_id)
         VALUES ($1,$2,'sheet.pdf','application/pdf',10,'k1',$3) RETURNING id`,
        [i.schoolA, id, i.ownerA],
      ),
    )
  ).rows[0].id
  await asRuntime(i.schoolA, (client) =>
    client.query(
      `UPDATE homework SET removed_at = now(), removed_by_membership_id = $2, version = version + 1 WHERE id = $1`,
      [id, i.ownerA],
    ),
  )
  await refusedWith(refusal, `UPDATE homework SET title = 'Changed' WHERE id = $1`, [id])
  await refusedWith(refusal, `UPDATE homework SET due_on = due_on + 1 WHERE id = $1`, [id])
  await refusedWith(refusal, `UPDATE homework SET version = version + 1 WHERE id = $1`, [id])
  await refusedWith(
    refusal,
    `INSERT INTO homework_attachments(school_id,homework_id,file_name,content_type,size_bytes,storage_key,
                                      created_by_membership_id)
     VALUES ($1,$2,'more.pdf','application/pdf',10,'k2',$3)`,
    [i.schoolA, id, i.ownerA],
  )
  await refusedWith(refusal, `DELETE FROM homework_attachments WHERE id = $1`, [fileId])
  await assert.rejects(check(id, { studentId: i.studentA2 }), (error) => refusal.includes(error.code))
  await refusedWith(refusal, `UPDATE homework_checks SET status = 'not_done' WHERE id = $1`, [checkId])
  await refusedWith(refusal, `UPDATE homework_checks SET remark = 'Other words' WHERE id = $1`, [checkId])
  // Anonymising the pupil clears the remark, and changes nothing else.
  await asRuntime(i.schoolA, (client) =>
    client.query(
      `UPDATE homework_checks SET remark = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
      [checkId],
    ),
  )
  const kept = await admin.query('SELECT status, remark FROM homework_checks WHERE id = $1', [checkId])
  assert.deepEqual(kept.rows[0], { status: 'done', remark: null })
})

test('the sweep removes old items with their files and leaves the pupils\' check-offs', async () => {
  const old = await item({ yearId: oldYear, sectionId: oldSection, setOn: '2023-06-01', dueOn: '2023-06-03' })
  const current = await item()
  const oldCheck = await check(old, { yearId: oldYear, sectionId: oldSection, remark: 'Late' })
  const key = `homework/${i.schoolA}/${old}/${crypto.randomUUID()}`
  const attachment = await asRuntime(i.schoolA, (client) =>
    client.query(
      `INSERT INTO homework_attachments(school_id,homework_id,file_name,content_type,size_bytes,storage_key,
                                        created_by_membership_id)
       VALUES ($1,$2,'sheet.pdf','application/pdf',10,$3,$4) RETURNING id`,
      [i.schoolA, old, key, i.ownerA],
    ),
  )
  const attachmentId = attachment.rows[0].id
  await assert.rejects(
    asRuntime(i.schoolA, (client) =>
      client.query(
        `INSERT INTO homework_attachments(school_id,homework_id,file_name,content_type,size_bytes,storage_key,
                                          created_by_membership_id)
         VALUES ($1,$2,'big.pdf','application/pdf',4194305,'k',$3)`,
        [i.schoolA, current, i.ownerA],
      ),
    ),
    (error) => error.code === '23514',
  )

  const listed = await plainRuntime.query('SELECT * FROM list_expired_homework_attachments()')
  assert.ok(listed.rows.some((row) => row.id === attachmentId && row.storage_key === key))

  // While the bytes are still named, the sweep keeps the item.
  await plainRuntime.query('SELECT * FROM sweep_homework()')
  assert.equal((await admin.query('SELECT 1 FROM homework WHERE id = $1', [old])).rowCount, 1)

  await plainRuntime.query('SELECT forget_homework_attachment($1, $2)', [i.schoolA, attachmentId])
  const after = await plainRuntime.query('SELECT * FROM list_expired_homework_attachments()')
  assert.ok(!after.rows.some((row) => row.id === attachmentId))

  const swept = await plainRuntime.query('SELECT * FROM sweep_homework()')
  assert.equal(swept.rows[0].item, 'homework')
  assert.ok(swept.rows[0].count >= 1)
  assert.equal((await admin.query('SELECT 1 FROM homework WHERE id = $1', [old])).rowCount, 0)
  assert.equal((await admin.query('SELECT 1 FROM homework_attachments WHERE id = $1', [attachmentId])).rowCount, 0)
  assert.equal((await admin.query('SELECT 1 FROM homework WHERE id = $1', [current])).rowCount, 1)
  // The pupil's check-off stays, with its class and subject, and no item.
  const kept = await admin.query('SELECT homework_id, section_id, subject_id, remark FROM homework_checks WHERE id = $1', [
    oldCheck,
  ])
  assert.deepEqual(kept.rows[0], { homework_id: null, section_id: oldSection, subject_id: subjectId, remark: 'Late' })
})

test('only the runtime login may run the homework maintenance functions', async () => {
  for (const sql of [
    'SELECT * FROM list_expired_homework_attachments()',
    `SELECT forget_homework_attachment('${i.schoolA}', '${i.schoolA}')`,
    'SELECT * FROM sweep_homework()',
  ])
    await assert.rejects(auth.query(sql), (error) => {
      assert.equal(error.code, '42501', `${sql}: ${error.code} ${error.message}`)
      return true
    })
  const grants = await admin.query(
    `SELECT p.proname, p.prosecdef,
            has_function_privilege('erp_runtime', p.oid, 'EXECUTE') AS runtime,
            has_function_privilege('erp_auth', p.oid, 'EXECUTE') AS auth,
            has_function_privilege('erp_identity_reader', p.oid, 'EXECUTE') AS identity
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('list_expired_homework_attachments','forget_homework_attachment','sweep_homework')`,
  )
  assert.equal(grants.rowCount, 3)
  for (const row of grants.rows) {
    assert.equal(row.prosecdef, true, row.proname)
    assert.equal(row.runtime, true, row.proname)
    assert.equal(row.auth, false, row.proname)
    assert.equal(row.identity, false, row.proname)
  }
})

test('a school sees only its own homework', async () => {
  const id = await item()
  const seen = await withTenantTransaction(runtime, context(i.schoolB), ({ client }) =>
    client.query('SELECT id FROM homework WHERE id = $1', [id]),
  )
  assert.equal(seen.rowCount, 0)
})

test('the digest is a message kind for one pupil\'s families, with its own settings', async () => {
  const settings = await admin.query(
    `SELECT column_name, column_default FROM information_schema.columns
      WHERE table_name = 'communication_settings' AND column_name IN ('homework_digest_enabled','homework_digest_time')
      ORDER BY column_name`,
  )
  assert.equal(settings.rowCount, 2)
  const digest = (audience, recipients) =>
    asRuntime(i.schoolA, (client) =>
      client.query(
        `INSERT INTO messages(school_id,kind,audience,recipients,student_id,section_id,academic_year_id,title,body,status,
                              sent_at,dedupe_key)
         VALUES ($1,'homework_digest',$2,$3,$4,$5,$6,'Homework','Exercise 4.2','sent',now(),$7)`,
        [
          i.schoolA,
          audience,
          recipients,
          audience === 'pupil' ? i.studentA : null,
          i.sectionA,
          i.yearA,
          `homework_digest:${crypto.randomUUID()}`,
        ],
      ),
    )
  await digest('pupil', 'families')
  await assert.rejects(digest('pupil', 'students'), (error) => error.code === '23514')
  await assert.rejects(digest('section', 'families'), (error) => error.code === '23514')
  const digestTime = (time) =>
    asRuntime(i.schoolA, (client) =>
      client.query(
        `INSERT INTO communication_settings(school_id, homework_digest_time) VALUES ($1, $2)
         ON CONFLICT (school_id) DO UPDATE SET homework_digest_time = EXCLUDED.homework_digest_time`,
        [i.schoolA, time],
      ),
    )
  for (const time of ['22:00', '11:59', '21:01', '5pm']) await assert.rejects(digestTime(time), (error) => error.code === '23514', time)
  await digestTime('19:30')
  await digestTime('17:00')
})
