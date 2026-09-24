import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import {
  createIdentityPool,
  createPool,
  studentLoginState,
  studentSignInUser,
  withTenantTransaction,
} from '../src/index.ts'

/**
 * Task 23 in the database: a pupil's own login. An active student membership
 * is allowed now, but it still holds the student role only and no adult link,
 * and an adult membership still never holds the student role or a student
 * link. The identity login finds a pupil's identity by school code and
 * admission number, and reads whether a student login is on, and nothing
 * else. Classes carry a number 1 to 12. Messages carry who among the pupil's
 * people they go to, a range of classes, and one row per pupil.
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
const runtime = createPool({ connectionString: roleUrl('erp_runtime'), max: 2 })
const identity = createIdentityPool({ connectionString: roleUrl('erp_identity') })
const auth = new pg.Pool({ connectionString: roleUrl('erp_auth') })
const plainRuntime = new pg.Pool({ connectionString: roleUrl('erp_runtime') })

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

test.after(async () => {
  await Promise.all([admin.end(), runtime.end(), identity.end(), auth.end(), plainRuntime.end()])
})

/** A school of its own with a student role, a parent role, a Class 9 and a pupil. */
async function school(status = 'active') {
  const id = crypto.randomUUID()
  const code = `SL-${id.slice(0, 8)}`
  await admin.query(
    `INSERT INTO schools(id,login_code,name,short_name,status) VALUES ($1,$2,'Login School','LS',$3)`,
    [id, code, status],
  )
  const studentRole = crypto.randomUUID(),
    parentRole = crypto.randomUUID()
  await admin.query(
    `INSERT INTO roles(id,school_id,key,name,is_system) VALUES ($1,$3,'student','Student',true),($2,$3,'parent','Parent',true)`,
    [studentRole, parentRole, id],
  )
  const year = crypto.randomUUID(),
    grade = crypto.randomUUID(),
    section = crypto.randomUUID()
  await admin.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status) VALUES ($1,$2,'2026-27','2026-04-01','2027-03-31','current')`,
    [year, id],
  )
  await admin.query(
    `INSERT INTO grades(id,school_id,name,short_name,sort_order,level) VALUES ($1,$2,'Class 9','9',9,9)`,
    [grade, id],
  )
  await admin.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,'A')`,
    [section, id, year, grade],
  )
  const authorUser = crypto.randomUUID()
  await admin.query(`INSERT INTO auth_user(id,name,email) VALUES ($1::uuid,'Author',$1::text || '@test')`, [authorUser])
  const author = await admin.query(
    `INSERT INTO school_memberships(school_id,user_id,kind,status) VALUES ($1,$2,'adult','active') RETURNING id`,
    [id, authorUser],
  )
  return { id, code, studentRole, parentRole, year, grade, section, author: author.rows[0].id }
}

async function pupil(s, admission, status = 'active') {
  const row = await admin.query(
    `INSERT INTO students(school_id,admission_number,first_name,status) VALUES ($1,$2,'Pupil',$3) RETURNING id`,
    [s.id, admission, status],
  )
  return row.rows[0].id
}

async function user() {
  const id = crypto.randomUUID()
  await admin.query(`INSERT INTO auth_user(id,name,email) VALUES ($1::uuid,'Pupil',$1::text || '@student.invalid')`, [
    id,
  ])
  return id
}

/** A pupil's login as issuance writes it: membership, student role, link. */
async function login(s, studentId, status = 'active') {
  const userId = await user()
  const client = await admin.connect()
  try {
    await client.query('BEGIN')
    const membership = await client.query(
      `INSERT INTO school_memberships(school_id,user_id,kind,status) VALUES ($1,$2,'student',$3) RETURNING id`,
      [s.id, userId, status],
    )
    const membershipId = membership.rows[0].id
    await client.query(`INSERT INTO membership_roles(school_id,membership_id,role_id) VALUES ($1,$2,$3)`, [
      s.id,
      membershipId,
      s.studentRole,
    ])
    await client.query(
      `INSERT INTO membership_student_links(school_id,membership_id,student_id) VALUES ($1,$2,$3)`,
      [s.id, membershipId, studentId],
    )
    await client.query('COMMIT')
    return { userId, membershipId }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** Runs one write in a transaction that is always rolled back, checking deferred triggers too. */
async function refused(work, code = 'P0001') {
  const client = await admin.connect()
  try {
    await client.query('BEGIN')
    await assert.rejects(
      (async () => {
        await work(client)
        await client.query('SET CONSTRAINTS ALL IMMEDIATE')
      })(),
      (error) => {
        assert.equal(error.code, code, error.message)
        return true
      },
    )
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

test('an active student membership with the student role and a pupil link is allowed', async () => {
  const s = await school()
  const studentId = await pupil(s, 'SL/001')
  const { membershipId } = await login(s, studentId)
  const row = await admin.query(`SELECT kind, status FROM school_memberships WHERE id = $1`, [membershipId])
  assert.deepEqual(row.rows, [{ kind: 'student', status: 'active' }])
})

test('a student membership refuses an adult role, a staff link and a guardian link', async () => {
  const s = await school()
  const studentId = await pupil(s, 'SL/002')
  const { membershipId } = await login(s, studentId)
  await refused((c) =>
    c.query(`INSERT INTO membership_roles(school_id,membership_id,role_id) VALUES ($1,$2,$3)`, [
      s.id,
      membershipId,
      s.parentRole,
    ]),
  )
  await refused(async (c) => {
    const staff = await c.query(
      `INSERT INTO staff(school_id,employee_code,first_name,staff_type,designation,status) VALUES ($1,'SL-T','T','teaching','T','active') RETURNING id`,
      [s.id],
    )
    await c.query(`INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)`, [
      s.id,
      membershipId,
      staff.rows[0].id,
    ])
  })
  await refused(async (c) => {
    const guardian = await c.query(
      `INSERT INTO guardians(school_id,first_name,phone) VALUES ($1,'G','+919800000001') RETURNING id`,
      [s.id],
    )
    await c.query(`INSERT INTO membership_guardian_links(school_id,membership_id,guardian_id,verified_at) VALUES ($1,$2,$3,now())`, [
      s.id,
      membershipId,
      guardian.rows[0].id,
    ])
  })
})

test('an adult membership still refuses the student role and a student link', async () => {
  const s = await school()
  const studentId = await pupil(s, 'SL/003')
  const adultUser = crypto.randomUUID()
  await admin.query(`INSERT INTO auth_user(id,name,email) VALUES ($1::uuid,'Adult',$1::text || '@test')`, [adultUser])
  const adult = await admin.query(
    `INSERT INTO school_memberships(school_id,user_id,kind,status) VALUES ($1,$2,'adult','active') RETURNING id`,
    [s.id, adultUser],
  )
  const adultId = adult.rows[0].id
  await refused((c) =>
    c.query(`INSERT INTO membership_roles(school_id,membership_id,role_id) VALUES ($1,$2,$3)`, [
      s.id,
      adultId,
      s.studentRole,
    ]),
  )
  await refused((c) =>
    c.query(`INSERT INTO membership_student_links(school_id,membership_id,student_id) VALUES ($1,$2,$3)`, [
      s.id,
      adultId,
      studentId,
    ]),
  )
})

test('student_sign_in_user finds only an active pupil with an active login in an open school', async () => {
  const s = await school()
  const other = await school()
  const closed = await school('suspended')
  const onRoll = await pupil(s, 'SL/2026/010')
  const onRollLogin = await login(s, onRoll)
  // The same admission number in another school is another pupil.
  const otherPupil = await pupil(other, 'SL/2026/010')
  const otherLogin = await login(other, otherPupil)
  const left = await pupil(s, 'SL/2026/011', 'left')
  await login(s, left)
  const switchedOff = await pupil(s, 'SL/2026/012')
  await login(s, switchedOff, 'suspended')
  const ended = await pupil(s, 'SL/2026/013')
  await login(s, ended, 'removed')
  const noLogin = await pupil(s, 'SL/2026/014')
  const inClosed = await pupil(closed, 'SL/2026/015')
  await login(closed, inClosed)

  assert.equal(await studentSignInUser(identity, s.code, 'SL/2026/010'), onRollLogin.userId)
  // Case and surrounding space do not matter, on either input.
  assert.equal(await studentSignInUser(identity, `  ${s.code.toLowerCase()} `, ' sl/2026/010  '), onRollLogin.userId)
  assert.equal(await studentSignInUser(identity, other.code.toUpperCase(), 'sl/2026/010'), otherLogin.userId)
  assert.notEqual(otherLogin.userId, onRollLogin.userId)
  // Never through another school's code.
  assert.equal(await studentSignInUser(identity, other.code, 'SL/2026/012'), null)
  assert.equal(await studentSignInUser(identity, closed.code, 'SL/2026/010'), null)
  for (const number of ['SL/2026/011', 'SL/2026/012', 'SL/2026/013', 'SL/2026/014', 'SL/2026/999'])
    assert.equal(await studentSignInUser(identity, s.code, number), null, number)
  assert.equal(await studentSignInUser(identity, closed.code, 'SL/2026/015'), null)
  assert.equal(await studentSignInUser(identity, 'no-such-school', 'SL/2026/010'), null)
  assert.ok(noLogin)
})

test('student_login_state is none for an adult, active while the login is on, inactive otherwise', async () => {
  const s = await school()
  const closed = await school('suspended')
  const adultUser = crypto.randomUUID()
  await admin.query(`INSERT INTO auth_user(id,name,email) VALUES ($1::uuid,'Adult',$1::text || '@test')`, [adultUser])
  await admin.query(`INSERT INTO school_memberships(school_id,user_id,kind,status) VALUES ($1,$2,'adult','active')`, [
    s.id,
    adultUser,
  ])
  const on = await login(s, await pupil(s, 'SL/020'))
  const off = await login(s, await pupil(s, 'SL/021'), 'suspended')
  const gone = await login(s, await pupil(s, 'SL/022'), 'removed')
  const schoolClosed = await login(closed, await pupil(closed, 'SL/023'))
  assert.equal(await studentLoginState(identity, adultUser), 'none')
  assert.equal(await studentLoginState(identity, crypto.randomUUID()), 'none')
  assert.equal(await studentLoginState(identity, on.userId), 'active')
  assert.equal(await studentLoginState(identity, off.userId), 'inactive')
  assert.equal(await studentLoginState(identity, gone.userId), 'inactive')
  assert.equal(await studentLoginState(identity, schoolClosed.userId), 'inactive')
  // Switching the login back on makes it active again.
  await admin.query(`UPDATE school_memberships SET status = 'active' WHERE id = $1`, [off.membershipId])
  assert.equal(await studentLoginState(identity, off.userId), 'active')
})

test('the identity lookups run for the identity login only, which still reads no table', async () => {
  for (const sql of [
    `SELECT student_sign_in_user('x', 'y')`,
    `SELECT student_login_state('${crypto.randomUUID()}')`,
    `SELECT * FROM active_memberships_for_user('${crypto.randomUUID()}')`,
  ]) {
    for (const pool of [auth, plainRuntime])
      await assert.rejects(pool.query(sql), (error) => {
        assert.equal(error.code, '42501', `${sql}: ${error.code} ${error.message}`)
        return true
      })
  }
  const grants = await admin.query(
    `SELECT p.proname,
            has_function_privilege('erp_identity', p.oid, 'EXECUTE') AS identity,
            has_function_privilege('erp_runtime', p.oid, 'EXECUTE') AS runtime,
            has_function_privilege('erp_auth', p.oid, 'EXECUTE') AS auth
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('student_sign_in_user','student_login_state','active_memberships_for_user')`,
  )
  assert.equal(grants.rowCount, 3)
  for (const row of grants.rows) assert.deepEqual([row.identity, row.runtime, row.auth], [true, false, false], row.proname)
  for (const table of ['students', 'membership_student_links', 'schools', 'school_memberships'])
    await assert.rejects(identity.query(`SELECT * FROM ${table}`), { code: '42501' })
})

test('a class number is 1 to 12 or none', async () => {
  const s = await school()
  for (const level of [0, 13, -1])
    await refused(
      (c) =>
        c.query(`INSERT INTO grades(school_id,name,short_name,sort_order,level) VALUES ($1,$2,'X',50,$3)`, [
          s.id,
          `Level ${level}`,
          level,
        ]),
      '23514',
    )
  await admin.query(
    `INSERT INTO grades(school_id,name,short_name,sort_order,level) VALUES ($1,'Class 12','12',12,12),($1,'Class 1','1',1,1),($1,'Nursery','N',0,NULL)`,
    [s.id],
  )
})

/** The columns of a message: a notice by the school's author, or an automatic message with its dedupe key. */
function messageColumns(s, fields) {
  const columns = { school_id: s.id, kind: 'notice', title: 'Sports day', body: 'Bring water bottles', status: 'draft', ...fields }
  if (columns.kind === 'notice') columns.created_by_membership_id = s.author
  else columns.dedupe_key = `${columns.kind}:${crypto.randomUUID()}`
  return columns
}

/** A message straight into the table as the admin login. */
async function message(s, fields) {
  const columns = messageColumns(s, fields)
  const names = Object.keys(columns)
  const row = await admin.query(
    `INSERT INTO messages(${names.join(',')}) VALUES (${names.map((_, n) => `$${n + 1}`).join(',')}) RETURNING id`,
    Object.values(columns),
  )
  return row.rows[0].id
}

test('messages say who of a pupil audience they go to, and a range of classes has both ends', async () => {
  const s = await school()
  const upper = crypto.randomUUID()
  await admin.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order,level) VALUES ($1,$2,'Class 10','10',10,10)`, [
    upper,
    s.id,
  ])
  for (const recipients of ['families', 'students', 'both'])
    await message(s, { audience: 'school', recipients })
  await message(s, { audience: 'grade_range', recipients: 'students', grade_id: s.grade, grade_to_id: upper })
  await message(s, { audience: 'staff', recipients: null })
  // A pupil audience needs recipients, a staff audience has none, and the value is one of three.
  for (const fields of [
    { audience: 'school', recipients: null },
    { audience: 'grade', grade_id: s.grade, recipients: null },
    { audience: 'staff', recipients: 'families' },
    { audience: 'school', recipients: 'guardians' },
    // A range needs both ends; a grade has no second end.
    { audience: 'grade_range', recipients: 'families', grade_id: s.grade },
    { audience: 'grade_range', recipients: 'families', grade_to_id: upper },
    { audience: 'grade', recipients: 'families', grade_id: s.grade, grade_to_id: upper },
    { audience: 'school', recipients: 'families', grade_to_id: upper },
    // An automatic message about fees goes to families only; a birthday may go to both.
    { kind: 'fee_reminder', audience: 'pupil', recipients: 'both' },
    { kind: 'absence', audience: 'pupil', recipients: 'students' },
  ]) {
    const pupilId = await pupil(s, `SL/03${Math.floor(Math.random() * 1e6)}`)
    await refused((c) => {
      const columns = messageColumns(s, fields)
      if (columns.audience === 'pupil') columns.student_id = pupilId
      const names = Object.keys(columns)
      return c.query(
        `INSERT INTO messages(${names.join(',')}) VALUES (${names.map((_, n) => `$${n + 1}`).join(',')})`,
        Object.values(columns),
      )
    }, '23514')
  }
  const pupilId = await pupil(s, 'SL/030')
  await message(s, { kind: 'birthday_pupil', audience: 'pupil', recipients: 'both', student_id: pupilId })
})

test('a sent message keeps its recipients and its range', async () => {
  const s = await school()
  const upper = crypto.randomUUID()
  await admin.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order,level) VALUES ($1,$2,'Class 10','10',10,10)`, [
    upper,
    s.id,
  ])
  const draft = await message(s, { audience: 'grade_range', recipients: 'families', grade_id: s.grade, grade_to_id: upper })
  // A draft can still change both.
  await withTenantTransaction(runtime, context(s.id), ({ client }) =>
    client.query(`UPDATE messages SET recipients = 'both', grade_to_id = grade_id WHERE id = $1`, [draft]),
  )
  const sent = await message(s, {
    audience: 'grade_range',
    recipients: 'families',
    grade_id: s.grade,
    grade_to_id: upper,
    status: 'sent',
    sent_at: new Date(),
  })
  for (const assignment of [`recipients = 'students'`, `grade_to_id = grade_id`])
    await assert.rejects(
      withTenantTransaction(runtime, context(s.id), ({ client }) =>
        client.query(`UPDATE messages SET ${assignment} WHERE id = $1`, [sent]),
      ),
      (error) => {
        assert.ok(['P0001', '23000'].includes(error.code), `${assignment}: ${error.code} ${error.message}`)
        return true
      },
    )
})

test('a recipient row is one person, and a pupil row names the pupil, has no email and is unique', async () => {
  const s = await school()
  const studentId = await pupil(s, 'SL/040')
  const { membershipId } = await login(s, studentId)
  const messageId = await message(s, {
    audience: 'school',
    recipients: 'both',
    status: 'sent',
    sent_at: new Date(),
  })
  const guardian = await admin.query(
    `INSERT INTO guardians(school_id,first_name,phone) VALUES ($1,'G','+919800000002') RETURNING id`,
    [s.id],
  )
  const insert = `INSERT INTO message_recipients(school_id,message_id,guardian_id,student_id,membership_id,is_student,outcome,in_app,email_status)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`
  await admin.query(insert, [s.id, messageId, null, studentId, membershipId, true, 'delivered', true, 'none'])
  // The same pupil twice on one message.
  await refused((c) => c.query(insert, [s.id, messageId, null, studentId, null, true, 'no_contact', false, 'none']), '23505')
  // Nobody, or a guardian who is also marked as the pupil.
  await refused((c) => c.query(insert, [s.id, messageId, null, studentId, null, false, 'no_contact', false, 'none']), '23514')
  await refused(
    (c) => c.query(insert, [s.id, messageId, guardian.rows[0].id, studentId, null, true, 'no_contact', false, 'none']),
    '23514',
  )
  // A pupil row without the pupil, or with an email.
  const other = await message(s, { audience: 'school', recipients: 'students', status: 'sent', sent_at: new Date() })
  await refused((c) => c.query(insert, [s.id, other, null, null, null, true, 'no_contact', false, 'none']), '23514')
  await refused(
    (c) => c.query(insert, [s.id, other, null, studentId, membershipId, true, 'delivered', true, 'pending']),
    '23514',
  )
  // A guardian row about the same pupil is a different person.
  await admin.query(insert, [s.id, messageId, guardian.rows[0].id, studentId, null, false, 'no_contact', false, 'none'])
})

test('a test build holds a student password text', async () => {
  const row = await admin.query(
    `INSERT INTO held_sms(recipient,purpose,secret,expires_at) VALUES ('+919800000003','student_password','x',now() + interval '1 hour') RETURNING id`,
  )
  await admin.query(`DELETE FROM held_sms WHERE id = $1`, [row.rows[0].id])
  await assert.rejects(
    admin.query(
      `INSERT INTO held_sms(recipient,purpose,secret,expires_at) VALUES ('+919800000003','pupil_secret','x',now())`,
    ),
    { code: '23514' },
  )
})
