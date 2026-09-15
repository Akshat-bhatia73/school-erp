import pg from 'pg'
import { fileURLToPath } from 'node:url'
import { ROLE_TEMPLATES } from '@erp/contracts'

export const fixtureIds = Object.freeze({
  schoolA: '10000000-0000-4000-8000-000000000001',
  schoolB: '20000000-0000-4000-8000-000000000001',
  adult: '10000000-0000-4000-8000-000000000010',
  suspended: '10000000-0000-4000-8000-000000000011',
  studentMember: '10000000-0000-4000-8000-000000000012',
  parentA2: '10000000-0000-4000-8000-000000000013',
  parentB: '20000000-0000-4000-8000-000000000013',
  ownerA: '10000000-0000-4000-8000-000000000014',
  ownerB: '20000000-0000-4000-8000-000000000014',
  ownerAUser: '10000000-0000-4000-8000-000000000024',
  ownerBUser: '20000000-0000-4000-8000-000000000024',
  adultUser: '10000000-0000-4000-8000-000000000020',
  suspendedUser: '10000000-0000-4000-8000-000000000021',
  studentUser: '10000000-0000-4000-8000-000000000022',
  parentA2User: '10000000-0000-4000-8000-000000000023',
  parentBUser: '20000000-0000-4000-8000-000000000023',
  staffA: '10000000-0000-4000-8000-000000000030',
  guardianA: '10000000-0000-4000-8000-000000000040',
  guardianA2: '10000000-0000-4000-8000-000000000041',
  guardianB: '20000000-0000-4000-8000-000000000040',
  studentA: '10000000-0000-4000-8000-000000000050',
  studentA2: '10000000-0000-4000-8000-000000000051',
  studentB: '20000000-0000-4000-8000-000000000050',
  yearA: '10000000-0000-4000-8000-000000000060',
  gradeA: '10000000-0000-4000-8000-000000000061',
  sectionA: '10000000-0000-4000-8000-000000000062',
  documentA: '10000000-0000-4000-8000-000000000063',
})
const roleId = (school, n) =>
  `${school[0]}0000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`
export async function seedFixtures(pool) {
  const c = await pool.connect(),
    i = fixtureIds
  try {
    await c.query('BEGIN')
    await c.query(
      `INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,'fixture-a','Fixture A','A'),($2,'fixture-b','Fixture B','B') ON CONFLICT (id) DO NOTHING`,
      [i.schoolA, i.schoolB],
    )
    await c.query(
      `INSERT INTO auth_user(id,name,email) VALUES ($1,'Fixture Adult','fixture-adult@test'),($2,'Suspended','fixture-suspended@test'),($3,'Student','fixture-student@test'),($4,'Parent A2','fixture-parent-a2@test'),($5,'Parent B','fixture-parent-b@test') ON CONFLICT (id) DO NOTHING`,
      [
        i.adultUser,
        i.suspendedUser,
        i.studentUser,
        i.parentA2User,
        i.parentBUser,
      ],
    )
    await c.query(
      `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active'),($4,$2,$5,'adult','suspended'),($6,$2,$7,'student','suspended'),($8,$2,$9,'adult','active'),($10,$11,$12,'adult','active') ON CONFLICT (school_id,user_id) DO NOTHING`,
      [
        i.adult,
        i.schoolA,
        i.adultUser,
        i.suspended,
        i.suspendedUser,
        i.studentMember,
        i.studentUser,
        i.parentA2,
        i.parentA2User,
        i.parentB,
        i.schoolB,
        i.parentBUser,
      ],
    )
    await c.query(
      `INSERT INTO auth_user(id,name,email) VALUES ($1,'Owner A','fixture-owner-a@test'),($2,'Owner B','fixture-owner-b@test') ON CONFLICT (id) DO NOTHING`,
      [i.ownerAUser, i.ownerBUser],
    )
    await c.query(
      `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active'),($4,$5,$6,'adult','active') ON CONFLICT (school_id,user_id) DO NOTHING`,
      [i.ownerA, i.schoolA, i.ownerAUser, i.ownerB, i.schoolB, i.ownerBUser],
    )
    await c.query(
      `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status) VALUES ($1,$2,'FIX-A','Fixture','teaching','Teacher','active') ON CONFLICT (school_id,employee_code) DO NOTHING`,
      [i.staffA, i.schoolA],
    )
    await c.query(
      `INSERT INTO guardians(id,school_id,first_name) VALUES ($1,$2,'Guardian A'),($3,$2,'Guardian A2'),($4,$5,'Guardian B') ON CONFLICT (id) DO NOTHING`,
      [i.guardianA, i.schoolA, i.guardianA2, i.guardianB, i.schoolB],
    )
    await c.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,status) VALUES ($1,$2,'FIX-A1','Student A','active'),($3,$2,'FIX-A2','Student A2','active'),($4,$5,'FIX-B1','Student B','active') ON CONFLICT (school_id,admission_number) DO NOTHING`,
      [i.studentA, i.schoolA, i.studentA2, i.studentB, i.schoolB],
    )
    await c.query(
      `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status) VALUES ($1,$2,'2026-27','2026-04-01','2027-03-31','current') ON CONFLICT (school_id,name) DO NOTHING`,
      [i.yearA, i.schoolA],
    )
    await c.query(
      `INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,'Six','6',6) ON CONFLICT (school_id,name) DO NOTHING`,
      [i.gradeA, i.schoolA],
    )
    await c.query(
      `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,'A') ON CONFLICT (school_id,academic_year_id,grade_id,name) DO NOTHING`,
      [i.sectionA, i.schoolA, i.yearA, i.gradeA],
    )
    await c.query(
      `INSERT INTO student_documents(id,school_id,student_id,document_type,file_name,storage_key,size_bytes) VALUES ($1,$2,$3,'birth_certificate','fixture.pdf','fixtures/a.pdf',1) ON CONFLICT (id) DO NOTHING`,
      [i.documentA, i.schoolA, i.studentA],
    )
    await c.query(
      `INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [i.schoolA, i.adult, i.staffA],
    )
    await c.query(
      `INSERT INTO membership_guardian_links(school_id,membership_id,guardian_id,verified_at) VALUES ($1,$2,$3,'2026-01-01'),($1,$4,$5,'2026-01-01'),($6,$7,$8,'2026-01-01') ON CONFLICT DO NOTHING`,
      [
        i.schoolA,
        i.adult,
        i.guardianA,
        i.parentA2,
        i.guardianA2,
        i.schoolB,
        i.parentB,
        i.guardianB,
      ],
    )
    await c.query(
      `INSERT INTO membership_student_links(school_id,membership_id,student_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [i.schoolA, i.studentMember, i.studentA2],
    )
    await c.query(
      `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation) VALUES ($1,$2,$3,'guardian'),($1,$4,$5,'guardian'),($6,$7,$8,'guardian') ON CONFLICT DO NOTHING`,
      [
        i.schoolA,
        i.studentA,
        i.guardianA,
        i.studentA2,
        i.guardianA2,
        i.schoolB,
        i.studentB,
        i.guardianB,
      ],
    )
    await c.query(
      `INSERT INTO guardian_student_access(school_id,guardian_id,student_id,status,areas,approved_by_membership_id,approved_at) VALUES ($1,$2,$3,'approved',ARRAY['basic'],$4,'2026-01-01'),($1,$5,$6,'approved',ARRAY['basic'],$4,'2026-01-01'),($7,$8,$9,'approved',ARRAY['basic'],$10,'2026-01-01') ON CONFLICT DO NOTHING`,
      [
        i.schoolA,
        i.guardianA,
        i.studentA,
        i.ownerA,
        i.guardianA2,
        i.studentA2,
        i.schoolB,
        i.guardianB,
        i.studentB,
        i.ownerB,
      ],
    )
    for (const school of [i.schoolA, i.schoolB])
      for (const [n, [key, t]] of Object.entries(ROLE_TEMPLATES).entries()) {
        const id = roleId(school, n)
        await c.query(
          `INSERT INTO roles(id,school_id,key,name,is_system) VALUES ($1,$2,$3,$4,true) ON CONFLICT (school_id,key) DO NOTHING`,
          [id, school, key, t.displayName],
        )
        for (const g of t.grants)
          await c.query(
            `INSERT INTO role_permissions(school_id,role_id,permission,scope) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [school, id, g.permission, g.scope],
          )
      }
    for (const key of ['teacher', 'parent'])
      await c.query(
        `INSERT INTO membership_roles(school_id,membership_id,role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [
          i.schoolA,
          i.adult,
          roleId(i.schoolA, Object.keys(ROLE_TEMPLATES).indexOf(key)),
        ],
      )
    for (const [school, member, key] of [
      [i.schoolA, i.ownerA, 'owner'],
      [i.schoolB, i.ownerB, 'owner'],
      [i.schoolA, i.parentA2, 'parent'],
      [i.schoolB, i.parentB, 'parent'],
      [i.schoolA, i.suspended, 'teacher'],
      [i.schoolA, i.studentMember, 'student'],
    ])
      await c.query(
        `INSERT INTO membership_roles(school_id,membership_id,role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [
          school,
          member,
          roleId(school, Object.keys(ROLE_TEMPLATES).indexOf(key)),
        ],
      )
    await c.query(
      `INSERT INTO resource_access_rules(id,school_id,membership_id,permission,effect,target_type,effective_from,expires_at,reason,author_membership_id) VALUES ('10000000-0000-4000-8000-000000000070',$1,$2,'students.read_basic','allow','school','2026-01-01','2099-01-01','fixture current',$3),('10000000-0000-4000-8000-000000000071',$1,$2,'students.export','deny','school','2020-01-01','2021-01-01','fixture expired',$3) ON CONFLICT (id) DO NOTHING`,
      [i.schoolA, i.adult, i.ownerA],
    )
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  } finally {
    c.release()
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const connectionString = process.env.FIXTURE_DATABASE_URL
  if (!connectionString)
    throw new Error('FIXTURE_DATABASE_URL is required for the fixture CLI')
  const pool = new pg.Pool({ connectionString })
  try {
    await seedFixtures(pool)
  } finally {
    await pool.end()
  }
}
