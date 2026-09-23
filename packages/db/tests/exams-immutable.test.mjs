import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { createPool, withTenantTransaction } from '../src/index.ts'
import { fixtureIds as i, seedFixtures } from '../scripts/fixtures.mjs'

/**
 * Exam marks, publications and published report cards are append-only in the
 * database, not only in the API. A mark is never edited and never removed: a
 * change is a new row with the next revision, and every revision after the
 * first carries a reason kind. A published card is never edited except for
 * the remarks being cleared, which is what anonymising a pupil needs.
 * Everything here runs as erp_runtime, the login the application uses.
 */

const url = process.env.TEST_DATABASE_URL
if (!url) throw new Error('TEST_DATABASE_URL is required')
if (new URL(url).pathname === '/erp')
  throw new Error(
    'The db tests refuse to run against "erp", the development database; use erp_test (pnpm db:test:prepare)',
  )
const admin = new pg.Pool({ connectionString: url })

const runtimeUrl = new URL(url)
runtimeUrl.username = 'erp_runtime'
runtimeUrl.password = 'erp_runtime'
const runtime = createPool({ connectionString: runtimeUrl.toString(), max: 4 })

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

/**
 * One statement in its own tenant transaction. A refused statement poisons the
 * transaction it ran in, so every attempt below needs a fresh one.
 */
async function asRuntime(schoolId, work) {
  return withTenantTransaction(runtime, context(schoolId), ({ client }) => work(client))
}

/**
 * The runtime login is refused either by the grant (42501, no UPDATE or
 * DELETE on the table) or by the trigger (P0001). Both are the register
 * holding; which one answers first is a detail of the grant, not of the rule.
 */
async function refused(schoolId, sql, values) {
  await assert.rejects(
    asRuntime(schoolId, (client) => client.query(sql, values)),
    (error) => {
      assert.ok(
        error.code === 'P0001' || error.code === '42501',
        `${sql}: unexpected ${error.code} ${error.message}`,
      )
      return true
    },
  )
}


const suffix = crypto.randomUUID().slice(0, 8)
let subjectId = ''
let otherSectionId = ''
let examId = ''
let paperId = ''
let otherPaperId = ''
let markId = ''
let publicationId = ''
let versionId = ''

function refusedWith(codes, schoolId, sql, values) {
  return assert.rejects(
    asRuntime(schoolId, (client) => client.query(sql, values)),
    (error) => {
      assert.ok(codes.includes(error.code), `${sql}: unexpected ${error.code} ${error.message}`)
      return true
    },
  )
}

const insertMark = `INSERT INTO exam_marks(school_id,paper_id,exam_id,academic_year_id,section_id,subject_id,student_id,
                        component,status,marks_tenths,revision,supersedes_mark_id,kind,reason_kind,recorded_by_membership_id)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,'periodic_test',$8,$9,$10,$11,$12,$13,$14)`

test.before(async () => {
  await seedFixtures(admin)
  const subject = await admin.query(
    `INSERT INTO subjects(school_id,name,code,type) VALUES ($1,'Exam maths',$2,'scholastic') RETURNING id`,
    [i.schoolA, `EX-${suffix}`],
  )
  subjectId = subject.rows[0].id
  const section = await admin.query(
    `INSERT INTO sections(school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4) RETURNING id`,
    [i.schoolA, i.yearA, i.gradeA, `X${suffix}`],
  )
  otherSectionId = section.rows[0].id
  // Another suite may already have made this exam in the fixture year, so the
  // insert falls back to the row already there.
  await admin.query(
    `INSERT INTO exams(school_id,academic_year_id,kind,starts_on,ends_on,recheck_deadline)
     VALUES ($1,$2,'periodic_test_2','2026-11-02','2026-11-06','2026-11-20')
     ON CONFLICT (school_id,academic_year_id,kind) DO NOTHING`,
    [i.schoolA, i.yearA],
  )
  const exam = await admin.query(
    `SELECT id FROM exams WHERE school_id = $1 AND academic_year_id = $2 AND kind = 'periodic_test_2'`,
    [i.schoolA, i.yearA],
  )
  examId = exam.rows[0].id
  const paper = await admin.query(
    `INSERT INTO exam_papers(school_id,exam_id,academic_year_id,section_id,subject_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [i.schoolA, examId, i.yearA, i.sectionA, subjectId],
  )
  paperId = paper.rows[0].id
  const other = await admin.query(
    `INSERT INTO exam_papers(school_id,exam_id,academic_year_id,section_id,subject_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [i.schoolA, examId, i.yearA, otherSectionId, subjectId],
  )
  otherPaperId = other.rows[0].id
  const mark = await admin.query(
    `${insertMark} RETURNING id`,
    [i.schoolA, paperId, examId, i.yearA, i.sectionA, subjectId, i.studentA, 'marked', 70, 1, null, 'entry', null, i.ownerA],
  )
  markId = mark.rows[0].id
  const publication = await admin.query(
    `INSERT INTO exam_publications(school_id,exam_id,academic_year_id,section_id,published_by_membership_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [i.schoolA, examId, i.yearA, i.sectionA, i.ownerA],
  )
  publicationId = publication.rows[0].id
  const version = await admin.query(
    `INSERT INTO report_card_versions(school_id,student_id,academic_year_id,section_id,card,version_number,
                                      content,remarks,content_hash,published_by_membership_id)
     VALUES ($1,$2,$3,$4,'final',
             (SELECT coalesce(max(version_number),0)+1 FROM report_card_versions
               WHERE school_id=$1 AND student_id=$2 AND academic_year_id=$3 AND card='final'),
             '{"figures":1}'::jsonb,'{"term_1":"Kind and curious"}'::jsonb,$5,$6) RETURNING id`,
    [i.schoolA, i.studentA, i.yearA, i.sectionA, `hash-${suffix}-0123456789`, i.ownerA],
  )
  versionId = version.rows[0].id
})

test.after(async () => {
  await Promise.all([admin.end(), runtime.end()])
})

test('a mark and a publication can never be changed or removed', async () => {
  await refused(i.schoolA, 'UPDATE exam_marks SET marks_tenths = 10 WHERE id = $1', [markId])
  await refused(i.schoolA, 'UPDATE exam_marks SET revision = 5 WHERE id = $1', [markId])
  await refused(i.schoolA, 'DELETE FROM exam_marks WHERE id = $1', [markId])
  await refused(i.schoolA, `UPDATE exam_publications SET published_at = now() - interval '1 day' WHERE id = $1`, [
    publicationId,
  ])
  await refused(i.schoolA, 'DELETE FROM exam_publications WHERE id = $1', [publicationId])

  const still = await admin.query('SELECT marks_tenths, revision FROM exam_marks WHERE id = $1', [markId])
  assert.equal(still.rows[0].marks_tenths, 70)
  assert.equal(still.rows[0].revision, 1)
  const published = await admin.query('SELECT id FROM exam_publications WHERE id = $1', [publicationId])
  assert.equal(published.rowCount, 1)
})

test('two marks of one cell can never share a revision, and a change needs a reason kind', async () => {
  const base = [i.schoolA, paperId, examId, i.yearA, i.sectionA, subjectId, i.studentA]
  await refusedWith(['23505'], i.schoolA, insertMark, [...base, 'marked', 80, 1, null, 'entry', null, i.ownerA])
  // The second revision without a reason kind is refused by the CHECK.
  await refusedWith(['23514'], i.schoolA, insertMark, [...base, 'marked', 80, 2, markId, 'entry', null, i.ownerA])
  // A correction without a reason kind is refused as well.
  await refusedWith(['23514'], i.schoolA, insertMark, [
    ...base, 'marked', 80, 2, markId, 'correction', null, i.ownerA,
  ])
  // The next revision with a reason kind is exactly how a change is written.
  await asRuntime(i.schoolA, (client) =>
    client.query(insertMark, [...base, 'marked', 80, 2, markId, 'correction', 'recheck', i.ownerA]),
  )
  const rows = await admin.query(
    `SELECT revision, marks_tenths FROM exam_marks
      WHERE school_id = $1 AND paper_id = $2 AND student_id = $3 AND component = 'periodic_test' ORDER BY revision`,
    [i.schoolA, paperId, i.studentA],
  )
  assert.deepEqual(
    rows.rows.map((row) => [row.revision, row.marks_tenths]),
    [
      [1, 70],
      [2, 80],
    ],
    'the superseded row is still there',
  )
})

test('a mark above the component maximum is refused', async () => {
  await refusedWith(['23514'], i.schoolA, insertMark, [
    i.schoolA, paperId, examId, i.yearA, i.sectionA, subjectId, i.studentA2,
    'marked', 101, 1, null, 'entry', null, i.ownerA,
  ])
  // Exactly the maximum is accepted.
  await asRuntime(i.schoolA, (client) =>
    client.query(insertMark, [
      i.schoolA, paperId, examId, i.yearA, i.sectionA, subjectId, i.studentA2,
      'marked', 100, 1, null, 'entry', null, i.ownerA,
    ]),
  )
  // A status never carries a number, and a mark always does.
  await refusedWith(['23514'], i.schoolA, insertMark, [
    i.schoolA, paperId, examId, i.yearA, i.sectionA, subjectId, i.studentA,
    'absent', 0, 3, markId, 'correction', 'other', i.ownerA,
  ])
})

test('a mark can never point at the paper of another section', async () => {
  // The paper belongs to the other section; the row claims the fixture section.
  await refusedWith(['23503'], i.schoolA, insertMark, [
    i.schoolA, otherPaperId, examId, i.yearA, i.sectionA, subjectId, i.studentA,
    'marked', 50, 1, null, 'entry', null, i.ownerA,
  ])
})

test('a published card keeps its content; only the remarks may be cleared', async () => {
  await refused(i.schoolA, `UPDATE report_card_versions SET content = '{"figures":2}'::jsonb WHERE id = $1`, [
    versionId,
  ])
  await refused(i.schoolA, 'UPDATE report_card_versions SET version_number = 99 WHERE id = $1', [versionId])
  await refused(i.schoolA, `UPDATE report_card_versions SET remarks = '{"term_1":"Changed"}'::jsonb WHERE id = $1`, [
    versionId,
  ])
  await refused(i.schoolA, 'DELETE FROM report_card_versions WHERE id = $1', [versionId])

  await asRuntime(i.schoolA, (client) =>
    client.query('UPDATE report_card_versions SET remarks = NULL WHERE id = $1', [versionId]),
  )
  const after = await admin.query('SELECT content, remarks FROM report_card_versions WHERE id = $1', [versionId])
  assert.deepEqual(after.rows[0].content, { figures: 1 })
  assert.equal(after.rows[0].remarks, null)
})

test('another school never sees an exam row of this one', async () => {
  const mine = await asRuntime(i.schoolA, (client) => client.query('SELECT id FROM exam_marks WHERE id = $1', [markId]))
  assert.equal(mine.rowCount, 1)
  for (const [table, id] of [
    ['exams', examId],
    ['exam_papers', paperId],
    ['exam_marks', markId],
    ['exam_publications', publicationId],
    ['report_card_versions', versionId],
  ]) {
    const hidden = await asRuntime(i.schoolB, (client) => client.query(`SELECT id FROM ${table} WHERE id = $1`, [id]))
    assert.equal(hidden.rowCount, 0, `${table} leaked across schools`)
  }
  await assert.rejects(
    asRuntime(i.schoolB, (client) =>
      client.query(
        `INSERT INTO exam_publications(school_id,exam_id,academic_year_id,section_id,published_by_membership_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [i.schoolA, examId, i.yearA, i.sectionA, i.ownerA],
      ),
    ),
  )
})
