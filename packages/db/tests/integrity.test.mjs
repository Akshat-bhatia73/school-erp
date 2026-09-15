import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import {
  PermissionKey,
  RESOURCE_RULE_PERMISSIONS,
  ROLE_TEMPLATES,
} from '@erp/contracts'
import { fixtureIds as i, seedFixtures } from '../scripts/fixtures.mjs'
const connectionString = process.env.TEST_DATABASE_URL
if (!connectionString) throw new Error('TEST_DATABASE_URL is required')
const pool = new pg.Pool({ connectionString })
async function rejected(c, sql, values, code) {
  await c.query('SAVEPOINT rejected_write')
  try {
    await assert.rejects(c.query(sql, values), (e) => !code || e.code === code)
  } finally {
    await c.query('ROLLBACK TO SAVEPOINT rejected_write')
  }
}
async function rollback(work) {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await work(c)
    await c.query('ROLLBACK')
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  } finally {
    c.release()
  }
}
test.before(async () => {
  await seedFixtures(pool)
  await seedFixtures(pool)
})
test('fixtures are deterministic, complete, and mirror every role template in both schools', async () => {
  const baseline = await pool.query(
    `SELECT (SELECT count(*) FROM schools WHERE id=ANY($1))::int schools,(SELECT count(*) FROM resource_access_rules WHERE id IN ('10000000-0000-4000-8000-000000000070','10000000-0000-4000-8000-000000000071'))::int rules`,
    [[i.schoolA, i.schoolB]],
  )
  await seedFixtures(pool)
  assert.deepEqual(
    (
      await pool.query(
        `SELECT (SELECT count(*) FROM schools WHERE id=ANY($1))::int schools,(SELECT count(*) FROM resource_access_rules WHERE id IN ('10000000-0000-4000-8000-000000000070','10000000-0000-4000-8000-000000000071'))::int rules`,
        [[i.schoolA, i.schoolB]],
      )
    ).rows,
    baseline.rows,
  )
  for (const school of [i.schoolA, i.schoolB])
    for (const [key, t] of Object.entries(ROLE_TEMPLATES)) {
      const r = await pool.query(
        `SELECT id FROM roles WHERE school_id=$1 AND key=$2`,
        [school, key],
      )
      assert.equal(r.rowCount, 1, `${school}:${key}`)
      const g = await pool.query(
        `SELECT permission,scope FROM role_permissions WHERE school_id=$1 AND role_id=$2`,
        [school, r.rows[0].id],
      )
      assert.deepEqual(
        new Set(g.rows.map((x) => `${x.permission}:${x.scope}`)),
        new Set(t.grants.map((x) => `${x.permission}:${x.scope}`)),
        key,
      )
    }
  const links = await pool.query(
    `SELECT (SELECT count(*) FROM membership_staff_links WHERE membership_id=$1)::int staff,(SELECT count(*) FROM membership_guardian_links WHERE membership_id=$1)::int guardian,(SELECT count(*) FROM membership_student_links WHERE membership_id=$2)::int student,(SELECT count(*) FROM guardian_student_access WHERE (school_id,guardian_id,student_id) IN (($3,$4,$5),($3,$6,$7),($8,$9,$10)) AND status='approved')::int access`,
    [
      i.adult,
      i.studentMember,
      i.schoolA,
      i.guardianA,
      i.studentA,
      i.guardianA2,
      i.studentA2,
      i.schoolB,
      i.guardianB,
      i.studentB,
    ],
  )
  assert.deepEqual(links.rows[0], {
    staff: 1,
    guardian: 1,
    student: 1,
    access: 3,
  })
})
test('resource rules accept every supported target/permission pair and reject bad targets, school, year, and expiry', async () =>
  rollback(async (c) => {
    const targets = {
      school: {},
      section: { academic_year_id: i.yearA, section_id: i.sectionA },
      student: { student_id: i.studentA },
      staff: { staff_id: i.staffA },
      document: { document_id: i.documentA },
    }
    for (const [type, permissions] of Object.entries(RESOURCE_RULE_PERMISSIONS))
      for (const permission of permissions) {
        const cols = Object.keys(targets[type]),
          vals = Object.values(targets[type])
        await c.query(
          `INSERT INTO resource_access_rules(school_id,membership_id,permission,effect,target_type,${cols.join(',')}${cols.length ? ',' : ''}effective_from,reason,author_membership_id) VALUES ($1,$2,$3,'allow',$4${cols.map((_, n) => `,$${n + 5}`).join('')},now(),'valid',$2)`,
          [i.schoolA, i.adult, permission, type, ...vals],
        )
      }
    for (const [type, target] of Object.entries(targets))
      for (const permission of PermissionKey.options.filter(
        (p) => !RESOURCE_RULE_PERMISSIONS[type].includes(p),
      )) {
        const cols = Object.keys(target),
          vals = Object.values(target)
        await rejected(
          c,
          `INSERT INTO resource_access_rules(school_id,membership_id,permission,effect,target_type,${cols.join(',')}${cols.length ? ',' : ''}effective_from,reason,author_membership_id) VALUES ($1,$2,$3,'allow',$4${cols.map((_, n) => `,$${n + 5}`).join('')},now(),'invalid',$2)`,
          [i.schoolA, i.adult, permission, type, ...vals],
          'P0001',
        )
      }
    const otherYear = crypto.randomUUID()
    await c.query(
      `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status) VALUES ($1,$2,'2027-28','2027-04-01','2028-03-31','upcoming')`,
      [otherYear, i.schoolA],
    )
    await rejected(
      c,
      `INSERT INTO resource_access_rules(school_id,membership_id,permission,effect,target_type,academic_year_id,section_id,effective_from,reason,author_membership_id) VALUES ($1,$2,'students.read_basic','allow','section',$3,$4,now(),'wrong-year',$2)`,
      [i.schoolA, i.adult, otherYear, i.sectionA],
      '23503',
    )
    await rejected(
      c,
      `INSERT INTO resource_access_rules(school_id,membership_id,permission,effect,target_type,student_id,effective_from,reason,author_membership_id) VALUES ($1,$2,'students.read_basic','allow','student',$3,now(),'wrong-school',$2)`,
      [i.schoolA, i.adult, i.studentB],
      '23503',
    )
    await rejected(
      c,
      `INSERT INTO resource_access_rules(school_id,membership_id,permission,effect,target_type,effective_from,expires_at,reason,author_membership_id) VALUES ($1,$2,'students.read_basic','allow','school',now(),now()-interval '1 second','expired',$2)`,
      [i.schoolA, i.adult],
      '23514',
    )
  }))
test('invitation role and lifecycle constraints enforce the assignable role contract', async () =>
  rollback(async (c) => {
    const base = `INSERT INTO school_invitations(school_id,identifier_type,identifier_normalized,destination_masked,token_digest,proposed_role_keys,display_name,staff_id,inviter_membership_id,expires_at) VALUES ($1,'email',$2,'x***',$3,$4,'Invite',$5,$6,now()+interval '1 hour')`
    for (const roles of [
      ['owner'],
      ['student'],
      [],
      ['parent', 'parent'],
      ['parent', null],
    ])
      await rejected(
        c,
        base,
        [
          i.schoolA,
          crypto.randomUUID() + '@test',
          crypto.randomUUID(),
          roles,
          i.staffA,
          i.adult,
        ],
        '23514',
      )
    await rejected(
      c,
      base,
      [
        i.schoolA,
        'teacher-no-staff@test',
        crypto.randomUUID(),
        ['teacher'],
        null,
        i.adult,
      ],
      '23514',
    )
    await c.query(base, [
      i.schoolA,
      'parent@test',
      crypto.randomUUID(),
      ['parent'],
      null,
      i.adult,
    ])
    await c.query(base, [
      i.schoolA,
      'teacher-parent@test',
      crypto.randomUUID(),
      ['teacher', 'parent'],
      i.staffA,
      i.adult,
    ])
    const accepted = await c.query(
      `INSERT INTO school_invitations(school_id,identifier_type,identifier_normalized,destination_masked,token_digest,proposed_role_keys,display_name,inviter_membership_id,expires_at,accepted_at,status) VALUES ($1,'email','accepted@test',$2,gen_random_uuid()::text,ARRAY['parent'],'Done',$3,now()+interval '1 hour',now(),'accepted') RETURNING id`,
      [i.schoolA, crypto.randomUUID(), i.adult],
    )
    await rejected(
      c,
      `UPDATE school_invitations SET display_name='changed' WHERE id=$1`,
      [accepted.rows[0].id],
      'P0001',
    )
  }))
test('membership kind rejects adult/student identity-link transitions on inserts and updates', async () =>
  rollback(async (c) => {
    await rejected(
      c,
      `UPDATE school_memberships SET kind='student' WHERE school_id=$1 AND id=$2`,
      [i.schoolA, i.adult],
      'P0001',
    )
    await rejected(
      c,
      `UPDATE school_memberships SET kind='adult' WHERE school_id=$1 AND id=$2`,
      [i.schoolA, i.studentMember],
      'P0001',
    )
    await c
      .query(
        `INSERT INTO staff(school_id,employee_code,first_name,staff_type,designation,status) VALUES ($1,'TEMP','T','teaching','T','active') RETURNING id`,
        [i.schoolA],
      )
      .then(async (r) => {
        await c.query('SAVEPOINT link_write')
        await c.query(
          `INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)`,
          [i.schoolA, i.studentMember, r.rows[0].id],
        )
        await assert.rejects(
          c.query('SET CONSTRAINTS ALL IMMEDIATE'),
          (e) => e.code === 'P0001',
        )
        await c.query('ROLLBACK TO SAVEPOINT link_write')
      })
    await c.query('SAVEPOINT link_write')
    await c.query(
      `INSERT INTO membership_student_links(school_id,membership_id,student_id) VALUES ($1,$2,$3)`,
      [i.schoolA, i.adult, i.studentA],
    )
    await assert.rejects(
      c.query('SET CONSTRAINTS ALL IMMEDIATE'),
      (e) => e.code === 'P0001',
    )
    await c.query('ROLLBACK TO SAVEPOINT link_write')
  }))
test.after(async () => pool.end())
