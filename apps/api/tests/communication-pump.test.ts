/**
 * The message pump (Task 22): the automatic messages the school sends by
 * itself, the email queue, and the daily maintenance route that runs both.
 *
 * The suite builds a school of its own, so no other suite's register, exam or
 * fee rows can make a message here, and nothing here reaches another suite's
 * inbox. The school's timezone is chosen so its clock reads early afternoon
 * when the suite starts: the daily kinds (birthdays and fee dues) go out from
 * the school's send hour, which can be no later than noon.
 *
 * The pump is called directly with the test server's own pools. Nothing in
 * this file sends a message through a route, so nothing starts the pump in
 * the background behind a test's back.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { MESSAGE_EMAIL_MAX_ATTEMPTS, ROLE_TEMPLATES } from '@erp/contracts'
import type { DeliveryAdapter } from '../src/delivery/types.ts'
import type { DispatchDependencies } from '../src/modules/communication/common.ts'
import { runEmailQueue } from '../src/modules/communication/email.ts'
import { runMessagePump } from '../src/modules/communication/pump.ts'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
  startTestServer,
  type TestServer,
} from './harness.ts'

const CRON_SECRET = 'cron-secret-for-message-tests-0123456789'
const suffix = randomUUID().slice(0, 8)

const school = randomUUID()
const owner = randomUUID()
const ownerUser = randomUUID()
const year = randomUUID()
const grade = randomUUID()
const feeGrade = randomUUID()
const section = randomUUID()
const feeSection = randomUUID()
const subject = randomUUID()

// The absence cases: stood for the delay; too fresh; corrected to present
// before the delay ran out; marked before automatic messages started.
const absent = randomUUID()
const fresh = randomUUID()
const corrected = randomUUID()
const early = randomUUID()
// Results, birthdays and fee dues.
const marked = randomUUID()
const birthday = randomUUID()
const feePupil = randomUUID()
const birthdayStaff = randomUUID()
const birthdayGuardian = randomUUID()

const examNew = randomUUID()
const examOld = randomUUID()

let server: TestServer
let deps: DispatchDependencies
let today = ''
let dueOn = ''

/** A timezone whose clock reads 14:00 now, give or take the minutes. */
function afternoonZone(): string {
  const offset = 14 - new Date().getUTCHours()
  if (offset === 0) return 'Etc/UTC'
  // The Etc zones name the offset with the opposite sign.
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`
}

/** The pump once, waiting for any runner that holds the school's lock to finish. */
async function pump(): Promise<Record<string, number>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const counts = await runMessagePump(deps, school, `pump-test-${randomUUID()}`)
    if (counts.skipped === undefined) return counts
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('the pump never got the school lock')
}

async function messagesOf(kind: string): Promise<{ id: string; dedupe_key: string; title: string; body: string; student_id: string | null; status: string }[]> {
  const found = await adminPool().query<{
    id: string
    dedupe_key: string
    title: string
    body: string
    student_id: string | null
    status: string
  }>(
    `SELECT id, dedupe_key, title, body, student_id, status FROM messages
      WHERE school_id = $1 AND kind = $2 ORDER BY dedupe_key`,
    [school, kind],
  )
  return found.rows
}

async function pupil(id: string, name: string, sectionId: string, dateOfBirth: string | null = null): Promise<void> {
  const pool = adminPool()
  await pool.query(
    `INSERT INTO students(id,school_id,admission_number,first_name,last_name,status,date_of_birth)
     VALUES ($1,$2,$3,$4,'Pump','active',$5)`,
    [id, school, `PMP/${suffix}/${name}`, name, dateOfBirth],
  )
  await pool.query(
    `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
     VALUES ($1,$2,$3,$4,1,(SELECT start_date FROM academic_years WHERE id = $3))`,
    [school, id, year, sectionId],
  )
}

async function mark(studentId: string, value: string, revision: number, minutesAgo: number, supersedes: string | null = null): Promise<string> {
  const found = await adminPool().query<{ id: string }>(
    `INSERT INTO attendance_entries(school_id,student_id,section_id,academic_year_id,date,mark,revision,
                                    supersedes_entry_id,kind,recorded_by_membership_id,created_at)
     VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,now() - make_interval(mins => $11))
     RETURNING id`,
    [school, studentId, section, year, today, value, revision, supersedes, revision === 1 ? 'marking' : 'correction', owner, minutesAgo],
  )
  return found.rows[0]?.id as string
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(
    `INSERT INTO schools(id,login_code,name,short_name,timezone) VALUES ($1,$2,$3,'PMP',$4)`,
    [school, `pump-${suffix}`, `Pump School ${suffix}`, afternoonZone()],
  )
  for (const [key, template] of Object.entries(ROLE_TEMPLATES)) {
    const role = await pool.query<{ id: string }>(
      `INSERT INTO roles(school_id,key,name,is_system) VALUES ($1,$2,$3,true) RETURNING id`,
      [school, key, template.displayName],
    )
    for (const grant of template.grants)
      await pool.query(
        `INSERT INTO role_permissions(school_id,role_id,permission,scope) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [school, role.rows[0]?.id, grant.permission, grant.scope],
      )
  }
  await pool.query(`INSERT INTO auth_user(id,name,email) VALUES ($1,'Pump Owner',$2)`, [
    ownerUser,
    `pump-owner-${suffix}@example.test`,
  ])
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')`,
    [owner, school, ownerUser],
  )

  const clock = await pool.query<{ today: string; due: string; start: string }>(
    `SELECT to_char(d, 'YYYY-MM-DD') AS today, to_char(d + 3, 'YYYY-MM-DD') AS due,
            to_char((d + 3 - interval '5 months')::date, 'YYYY-MM-DD') AS start
       FROM (SELECT (now() AT TIME ZONE timezone)::date AS d FROM schools WHERE id = $1) AS clock`,
    [school],
  )
  today = clock.rows[0]?.today ?? ''
  dueOn = clock.rows[0]?.due ?? ''
  // The year starts five months before the instalment the reminder is about,
  // so a monthly fee falls due on exactly that day.
  const start = clock.rows[0]?.start ?? ''
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,$4::date,($4::date + interval '1 year' - interval '1 day')::date,'current')`,
    [year, school, `PMP-${suffix}`, start],
  )
  await pool.query(
    `INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,'Class 4','C4',4),($3,$2,'Class 5','C5',5)`,
    [grade, school, feeGrade],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,'A'),($5,$2,$3,$6,'B')`,
    [section, school, year, grade, feeSection, feeGrade],
  )
  const monthDay = today.slice(5)
  await pupil(absent, 'Absent', section)
  await pupil(fresh, 'Fresh', section)
  await pupil(corrected, 'Corrected', section)
  await pupil(early, 'Before', section)
  await pupil(marked, 'Marked', section)
  await pupil(birthday, 'Birthday', section, `2016-${monthDay === '02-29' ? '02-28' : monthDay}`)
  await pupil(feePupil, 'Fees', feeSection)
  await pool.query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status,date_of_birth)
     VALUES ($1,$2,$3,'Birthday','teaching','Teacher','active',$4)`,
    [birthdayStaff, school, `PMP-${suffix}`, `1990-${monthDay === '02-29' ? '02-28' : monthDay}`],
  )
  // A guardian who agreed to messages and has a real-looking address, so the
  // birthday message has an email to send.
  await pool.query(`INSERT INTO guardians(id,school_id,first_name,email) VALUES ($1,$2,'Pump parent',$3)`, [
    birthdayGuardian,
    school,
    `pump.parent.${suffix}@gmail.com`,
  ])
  await pool.query(
    `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation) VALUES ($1,$2,$3,'mother')`,
    [school, birthday, birthdayGuardian],
  )
  await pool.query(
    `INSERT INTO guardian_consents(school_id,student_id,guardian_id,purpose,status,method,recorded_by_membership_id)
     VALUES ($1,$2,$3,'communication','given','signed_form',$4)`,
    [school, birthday, birthdayGuardian, owner],
  )

  // A monthly fee of ₹1,500 for Class 5 with a 20% concession: ₹1,200 falls due in three days.
  const head = await pool.query<{ id: string }>(
    `INSERT INTO fee_heads(school_id,name,category,applies_to,frequency) VALUES ($1,'Tuition','tuition','class','monthly') RETURNING id`,
    [school],
  )
  const headId = head.rows[0]?.id
  await pool.query(
    `INSERT INTO fee_structures(school_id,academic_year_id,fee_head_id,grade_id,amount_paise) VALUES ($1,$2,$3,$4,150000)`,
    [school, year, headId, feeGrade],
  )
  await pool.query(
    `INSERT INTO fee_concessions(school_id,student_id,academic_year_id,fee_head_id,category,kind,percent_bp)
     VALUES ($1,$2,$3,$4,'scholarship','percent',2000)`,
    [school, feePupil, year, headId],
  )

  // Two exams with a mark each: one published now for the first time, one
  // first published five days ago and published again now.
  await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,'Maths',$3,'scholastic')`, [
    subject,
    school,
    `PMP${suffix}`,
  ])
  for (const [id, kind] of [
    [examNew, 'periodic_test_1'],
    [examOld, 'periodic_test_2'],
  ] as const) {
    await pool.query(
      `INSERT INTO exams(id,school_id,academic_year_id,kind,starts_on,ends_on,recheck_deadline)
       VALUES ($1,$2,$3,$4,$5::date - 20,$5::date - 15,$5::date - 10)`,
      [id, school, year, kind, today],
    )
    const paper = await pool.query<{ id: string }>(
      `INSERT INTO exam_papers(school_id,exam_id,academic_year_id,section_id,subject_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [school, id, year, section, subject],
    )
    await pool.query(
      `INSERT INTO exam_marks(school_id,paper_id,exam_id,academic_year_id,section_id,subject_id,student_id,
                              component,status,marks_tenths,revision,kind,recorded_by_membership_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'periodic_test','marked',80,1,'entry',$8)`,
      [school, paper.rows[0]?.id, id, year, section, subject, marked, owner],
    )
  }

  server = await startTestServer({ CRON_SECRET })
  deps = { pools: server.pools, delivery: server.delivery, documents: server.documents, config: server.config }
})

after(async () => {
  await server?.close()
  await closeAdminPool()
})

test('the first run writes the settings row, and nothing that happened before it sends', async () => {
  // A mark saved three hours ago, before automatic messages started here.
  await mark(early, 'absent', 1, 180)
  await pump()
  const row = await adminPool().query<{ since: Date }>(
    'SELECT automatic_since AS since FROM communication_settings WHERE school_id = $1',
    [school],
  )
  assert.ok(row.rows[0]?.since, 'the pump wrote the settings row')
  assert.equal((await messagesOf('absence')).length, 0)

  // Automatic messages started two hours ago, which the old mark predates.
  await adminPool().query(
    `UPDATE communication_settings SET automatic_since = now() - interval '2 hours', fee_overdue_every_days = 0
      WHERE school_id = $1`,
    [school],
  )
})

test('an absence sends once the mark has stood for the delay, and not when corrected before it', async () => {
  await mark(absent, 'absent', 1, 45)
  await mark(fresh, 'absent', 1, 10)
  const first = await mark(corrected, 'absent', 1, 45)
  await mark(corrected, 'present', 2, 40, first)

  await pump()
  const sent = await messagesOf('absence')
  assert.deepEqual(
    sent.map((row) => row.dedupe_key),
    [`absence:${absent}:${today}`],
  )
  assert.equal(sent[0]?.status, 'sent')
  assert.match(sent[0]?.title ?? '', /^Absent is absent today$/)

  // A second run sends nothing again.
  await pump()
  assert.equal((await messagesOf('absence')).length, 1)
})

test('a result notice goes on the first publication only', async () => {
  const pool = adminPool()
  await pool.query(
    `INSERT INTO exam_publications(school_id,exam_id,academic_year_id,section_id,published_by_membership_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [school, examNew, year, section, owner],
  )
  // The other exam went out five days ago (before automatic messages, and
  // before the three-day window) and is published again now.
  await pool.query(
    `INSERT INTO exam_publications(school_id,exam_id,academic_year_id,section_id,published_by_membership_id,published_at)
     VALUES ($1,$2,$3,$4,$5,now() - interval '5 days'),($1,$2,$3,$4,$5,now())`,
    [school, examOld, year, section, owner],
  )
  await pump()
  const results = await messagesOf('result')
  assert.deepEqual(
    results.map((row) => row.dedupe_key),
    [`result:${examNew}:${marked}`],
  )

  await pool.query(
    `INSERT INTO exam_publications(school_id,exam_id,academic_year_id,section_id,published_by_membership_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [school, examNew, year, section, owner],
  )
  await pump()
  assert.equal((await messagesOf('result')).length, 1)
})

test('a birthday sends once a year, to the pupil family and to the staff member', async () => {
  const thisYear = today.slice(0, 4)
  const pupils = await messagesOf('birthday_pupil')
  assert.deepEqual(
    pupils.map((row) => row.dedupe_key),
    [`birthday_pupil:${birthday}:${thisYear}`],
  )
  const staff = await messagesOf('birthday_staff')
  assert.deepEqual(
    staff.map((row) => row.dedupe_key),
    [`birthday_staff:${birthdayStaff}:${thisYear}`],
  )
  await pump()
  assert.equal((await messagesOf('birthday_pupil')).length, 1)
  assert.equal((await messagesOf('birthday_staff')).length, 1)

  const recipient = await adminPool().query<{ outcome: string; email_status: string; email_masked: string | null }>(
    `SELECT outcome, email_status, email_masked FROM message_recipients WHERE school_id = $1 AND message_id = $2`,
    [school, pupils[0]?.id],
  )
  assert.equal(recipient.rows[0]?.outcome, 'delivered')
  // The sandbox adapter took it, so the queue recorded it as sent.
  assert.equal(recipient.rows[0]?.email_status, 'sent')
  assert.equal(recipient.rows[0]?.email_masked, 'p•••@gmail.com')
})

test('a fee reminder names the instalment after the concession', async () => {
  const reminders = await messagesOf('fee_reminder')
  assert.deepEqual(
    reminders.map((row) => row.dedupe_key),
    [`fee_reminder:${feePupil}:${dueOn}`],
  )
  const [y, m, d] = dueOn.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  assert.equal(reminders[0]?.title, `Fees of ₹1,200 due on ${Number(d)} ${months[Number(m) - 1]} ${y}`)
  assert.match(reminders[0]?.body ?? '', /Fees Pump, Class 5 B/)
  // The first run, before overdue reminders were switched off here, sent one
  // about the five instalments already due: 5 x ₹1,200.
  const overdue = await messagesOf('fee_overdue')
  assert.deepEqual(
    overdue.map((row) => row.dedupe_key),
    [`fee_overdue:${feePupil}:${today}`],
  )
  assert.equal(overdue[0]?.title, 'Fee dues of ₹6,000 for Fees')
})

test('a failing email is tried again and recorded as failed after the fifth attempt, never as sent', async () => {
  const [message] = await messagesOf('birthday_pupil')
  const pool = adminPool()
  await pool.query(
    `UPDATE message_recipients SET email_status = 'pending', email_sent_at = NULL, email_attempts = 0,
            email_next_attempt_at = now()
      WHERE school_id = $1 AND message_id = $2`,
    [school, message?.id],
  )
  let tries = 0
  const failing: DeliveryAdapter = {
    ...server.delivery,
    async sendMessage() {
      tries += 1
      throw new Error('the provider is down')
    },
  }
  const failingDeps: DispatchDependencies = { ...deps, delivery: failing }
  const expectedWait = [10, 20, 40, 80]
  for (let attempt = 1; attempt <= MESSAGE_EMAIL_MAX_ATTEMPTS; attempt += 1) {
    const counts = await runEmailQueue(failingDeps, school, `email-test-${attempt}`)
    const row = await pool.query<{
      email_status: string
      email_attempts: number
      email_sent_at: Date | null
      wait: number | null
    }>(
      `SELECT email_status, email_attempts, email_sent_at,
              round(extract(epoch FROM email_next_attempt_at - now()) / 60)::int AS wait
         FROM message_recipients WHERE school_id = $1 AND message_id = $2`,
      [school, message?.id],
    )
    const state = row.rows[0]
    assert.equal(state?.email_attempts, attempt)
    assert.equal(state?.email_sent_at, null)
    if (attempt < MESSAGE_EMAIL_MAX_ATTEMPTS) {
      assert.equal(counts.retry, 1)
      assert.equal(state?.email_status, 'pending')
      assert.equal(state?.wait, expectedWait[attempt - 1])
      // Not due yet: another run leaves it alone.
      const early = await runEmailQueue(failingDeps, school, `email-test-early-${attempt}`)
      assert.equal(early.retry + early.failed + early.sent, 0)
      await pool.query(
        `UPDATE message_recipients SET email_next_attempt_at = now() WHERE school_id = $1 AND message_id = $2`,
        [school, message?.id],
      )
    } else {
      assert.equal(counts.failed, 1)
      assert.equal(state?.email_status, 'failed')
      assert.equal(state?.wait, null)
    }
  }
  assert.equal(tries, MESSAGE_EMAIL_MAX_ATTEMPTS)
})

test('the daily maintenance route needs the cron secret and runs the pump for every school', async () => {
  const bare = await server.fetch('/api/maintenance/messages')
  assert.equal(bare.status, 401)
  assert.equal(((await bare.json()) as { error: { code: string } }).error.code, 'AUTHENTICATION_REQUIRED')
  const wrong = await server.fetch('/api/maintenance/messages', {
    headers: { authorization: `Bearer ${CRON_SECRET}-not` },
  })
  assert.equal(wrong.status, 401)

  const right = await server.fetch('/api/maintenance/messages', {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  })
  assert.equal(right.status, 200, await right.clone().text())
  const answer = (await right.json()) as { pumped: Record<string, number> }
  assert.ok((answer.pumped.schools ?? 0) >= 3, JSON.stringify(answer.pumped))
  assert.equal(answer.pumped.schools_failed, 0)
})

test('without CRON_SECRET the maintenance route does not exist', async () => {
  const plain = await startTestServer()
  try {
    const response = await plain.fetch('/api/maintenance/messages', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    })
    assert.equal(response.status, 404)
  } finally {
    await plain.close()
  }
})
