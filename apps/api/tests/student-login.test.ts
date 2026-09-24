/**
 * A pupil's own login (Task 23), end to end through the API.
 *
 * The suite builds a school of its own with Class 8, Class 9 and Class 10 this
 * year and a Class 9 next year, so a login is issued, or not, exactly as the
 * class number says. The office admits, promotes and issues; the pupil signs
 * in with the school code, the admission number and the texted password,
 * must choose their own before any school route answers, and loses every
 * session when the office resets the password, switches the login off or the
 * pupil leaves.
 *
 * Every password the sandbox "sent" and every generated @student.invalid
 * address is collected, and the last test checks that none of them is in any
 * response body, log line, audit row or outbox payload this suite produced.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { ROLE_TEMPLATES } from '@erp/contracts'
import { fixtureIds } from '@erp/db/fixtures'
import { MAX_FAILED_SIGN_INS } from '../src/auth/lockout.ts'
import { studentPasswordText } from '../src/delivery/resend.ts'
import type { DeliveryMessage } from '../src/delivery/index.ts'
import {
  adminPool,
  clientFor,
  closeAdminPool,
  resetRateLimits,
  seedDatabaseFixtures,
  setFixturePassword,
  signInWithMfa,
  signInWithPassword,
  startTestServer,
  type TestServer,
} from './harness.ts'

const PASSWORD = 'Fixture-Pass!42'
const PUPIL_PASSWORD = 'My-Own-Pass!2026'
const suffix = randomUUID().slice(0, 8)
const SCHOOL_CODE = `sl-${suffix}`

const school = randomUUID()
const year = randomUUID()
const nextYear = randomUUID()
const grade8 = randomUUID()
const grade9 = randomUUID()
const grade10 = randomUUID()
const section8 = randomUUID()
const section9 = randomUUID()
const section10 = randomUUID()
const nextSection9 = randomUUID()

let server: TestServer
type Client = ReturnType<typeof clientFor>
let owner: Client
let teacher: Client
let parent: Client
let phoneCounter = 0

/** Everything a pupil's secret could leak into, gathered as the suite runs. */
const responses: string[] = []
const logLines: string[] = []
const secrets = new Set<string>()
const addresses = new Set<string>()

interface ErrorBody {
  error: { code: string; reason?: string; requestId?: string }
}
interface LoginView {
  state: string
  username: string
  schoolCode: string
  blocker?: string
  guardianPhoneMasked?: string
  passwordChangePending: boolean
  issuedAt?: string
  lastSignInAt?: string
  version?: number
  allowedActions: string[]
}

const base = `/api/schools/${school}`

function json(method: string, value?: unknown): RequestInit {
  return value === undefined
    ? { method }
    : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
}

/** Reads a body once, keeps it for the leak check, and checks the status. */
async function read<T>(response: Response, status: number): Promise<T> {
  const text = await response.text()
  responses.push(text)
  assert.equal(response.status, status, text)
  return (text ? JSON.parse(text) : null) as T
}

async function refused(response: Response, status: number, code: string, reason?: string): Promise<ErrorBody> {
  const body = await read<ErrorBody>(response, status)
  assert.equal(body.error.code, code)
  if (reason !== undefined) assert.equal(body.error.reason, reason)
  return body
}

function nextPhone(): string {
  phoneCounter += 1
  return `+9197${suffix.replace(/[^0-9]/g, '').padEnd(4, '0').slice(0, 4)}${String(phoneCounter).padStart(4, '0')}`
}

/** The password texts the sandbox took for one phone, newest last. */
function textsTo(phone: string): DeliveryMessage[] {
  const found = server.delivery.outbox.filter(
    (message) => message.channel === 'sms' && message.to === phone && message.purpose === 'student_password',
  )
  for (const message of found) secrets.add(message.secret)
  return found
}

function lastPassword(phone: string): string {
  const text = textsTo(phone).at(-1)
  assert.ok(text, `no password text went to ${phone}`)
  return text.secret
}

/** A pupil straight into the tables: on the roll, enrolled, a primary guardian with or without a phone. */
async function pupil(input: {
  sectionId: string
  academicYearId?: string
  phone: string | null
  name?: string
}): Promise<{ id: string; admissionNumber: string }> {
  const pool = adminPool()
  const id = randomUUID()
  const admissionNumber = `SL/${suffix}/${randomUUID().slice(0, 6).toUpperCase()}`
  await pool.query(
    `INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,$4,'Pupil','active')`,
    [id, school, admissionNumber, input.name ?? 'Senior'],
  )
  await pool.query(
    `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,joined_on) VALUES ($1,$2,$3,$4,current_date - 30)`,
    [school, id, input.academicYearId ?? year, input.sectionId],
  )
  const guardian = randomUUID()
  await pool.query(`INSERT INTO guardians(id,school_id,first_name,phone) VALUES ($1,$2,'Guardian',$3)`, [
    guardian,
    school,
    input.phone,
  ])
  await pool.query(
    `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation,is_primary) VALUES ($1,$2,$3,'mother',true)`,
    [school, id, guardian],
  )
  return { id, admissionNumber }
}

async function admit(sectionId: string, phone: string): Promise<{ id: string; admissionNumber: string }> {
  const created = await read<{ id: string; admissionNumber: string }>(
    await owner.fetch(
      `${base}/students`,
      json('POST', {
        firstName: 'Admitted',
        lastName: 'Pupil',
        dateOfBirth: '2011-06-01',
        gender: 'female',
        admissionDate: '2026-04-01',
        sectionId,
        guardians: [{ guardian: { firstName: 'Admitted', lastName: 'Parent', phone }, relation: 'mother', isPrimary: true }],
      }),
    ),
    201,
  )
  return created
}

async function view(studentId: string, client: Client = owner): Promise<LoginView> {
  return read<LoginView>(await client.fetch(`${base}/students/${studentId}/login`), 200)
}

async function studentSignIn(schoolCode: string, admissionNumber: string, password: string): Promise<{
  client: Client
  response: Response
  text: string
}> {
  await resetRateLimits()
  const client = clientFor(server)
  const response = await client.fetch('/api/student-sign-in', json('POST', { schoolCode, admissionNumber, password }))
  const text = await response.text()
  responses.push(text)
  return { client, response, text }
}

/** Signs a pupil in and chooses their own password, so school routes answer. */
async function signedInPupil(admissionNumber: string, texted: string): Promise<Client> {
  const { client, response, text } = await studentSignIn(SCHOOL_CODE, admissionNumber, texted)
  assert.equal(response.status, 200, text)
  const changed = await client.fetch(
    '/api/auth/change-password',
    json('POST', { currentPassword: texted, newPassword: PUPIL_PASSWORD }),
  )
  await read(changed, 200)
  return client
}

async function identityOf(studentId: string): Promise<{ userId: string; membershipId: string; email: string }> {
  const found = await adminPool().query<{ user_id: string; membership_id: string; email: string }>(
    `SELECT m.user_id, m.id AS membership_id, u.email
       FROM membership_student_links l
       JOIN school_memberships m ON m.school_id = l.school_id AND m.id = l.membership_id
       JOIN auth_user u ON u.id = m.user_id
      WHERE l.school_id = $1 AND l.student_id = $2`,
    [school, studentId],
  )
  const row = found.rows[0]
  assert.ok(row, 'the pupil has no login')
  addresses.add(row.email)
  return { userId: row.user_id, membershipId: row.membership_id, email: row.email }
}

async function sessionsOf(userId: string): Promise<number> {
  const found = await adminPool().query<{ n: number }>('SELECT count(*)::int AS n FROM auth_session WHERE user_id = $1', [
    userId,
  ])
  return found.rows[0]?.n ?? 0
}

async function loginAudits(studentId: string): Promise<Record<string, unknown>[]> {
  const found = await adminPool().query<{ safe_changes: Record<string, unknown> }>(
    `SELECT safe_changes FROM audit_events
      WHERE school_id = $1 AND action = 'students.manage_login' AND target_type = 'student' AND target_id = $2
      ORDER BY created_at`,
    [school, studentId],
  )
  return found.rows.map((row) => row.safe_changes)
}

/** A new adult member of the suite's school, signed in (with the second factor for an office role). */
async function member(roleKeys: readonly string[], options: { mfa?: boolean; staffId?: string; guardianOf?: string } = {}): Promise<Client> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `sl-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, 'Login member', email])
  await pool.query(`INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')`, [
    membershipId,
    school,
    userId,
  ])
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = ANY($3::text[])`,
    [school, membershipId, [...roleKeys]],
  )
  if (options.staffId)
    await pool.query('INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)', [
      school,
      membershipId,
      options.staffId,
    ])
  if (options.guardianOf) {
    const guardian = await pool.query<{ guardian_id: string }>(
      'SELECT guardian_id FROM student_guardians WHERE school_id = $1 AND student_id = $2 AND is_primary',
      [school, options.guardianOf],
    )
    const guardianId = guardian.rows[0]?.guardian_id
    await pool.query(
      `INSERT INTO membership_guardian_links(school_id,membership_id,guardian_id,verified_at) VALUES ($1,$2,$3,now())`,
      [school, membershipId, guardianId],
    )
    await pool.query(
      `INSERT INTO guardian_student_access(school_id,guardian_id,student_id,status,areas,approved_by_membership_id,approved_at)
       VALUES ($1,$2,$3,'approved',ARRAY['basic'],$4,now())`,
      [school, guardianId, options.guardianOf, membershipId],
    )
  }
  await setFixturePassword(server, userId, PASSWORD)
  return options.mfa
    ? signInWithMfa(server, { userId, email, password: PASSWORD })
    : signInWithPassword(server, email, PASSWORD)
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,'SLS')`, [
    school,
    SCHOOL_CODE,
    `Student Login School ${suffix}`,
  ])
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
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,'2026-27','2026-04-01','2027-03-31','current'),($3,$2,'2027-28','2027-04-01','2028-03-31','upcoming')`,
    [year, school, nextYear],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [school, year])
  await pool.query(
    `INSERT INTO grades(id,school_id,name,short_name,sort_order,level)
     VALUES ($1,$4,'Class 8','8',8,8),($2,$4,'Class 9','9',9,9),($3,$4,'Class 10','10',10,10)`,
    [grade8, grade9, grade10, school],
  )
  const teacherStaff = randomUUID()
  await pool.query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status)
     VALUES ($1,$2,$3,'Class','teaching','Teacher','active')`,
    [teacherStaff, school, `SL-${suffix}`],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id)
     VALUES ($1,$5,$6,$2,'A',NULL),($3,$5,$6,$4,'A',$9),($7,$5,$6,$8,'A',NULL),($10,$5,$11,$4,'A',NULL)`,
    [section8, grade8, section9, grade9, school, year, section10, grade10, teacherStaff, nextSection9, nextYear],
  )

  server = await startTestServer({}, (app) => {
    // The app logs nothing in tests; every line a route writes is kept here instead.
    app.addHook('onRequest', async (request) => {
      const keep =
        (level: string) =>
        (...args: unknown[]) => {
          logLines.push(`${level} ${JSON.stringify(args)}`)
        }
      const capture = new Proxy(request.log, {
        get(target, property, receiver) {
          if (['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(String(property)))
            return keep(String(property))
          if (property === 'child') return () => capture
          return Reflect.get(target, property, receiver)
        },
      })
      request.log = capture
    })
  })
  owner = await member(['owner'], { mfa: true })
  teacher = await member(['teacher'], { staffId: teacherStaff })
})

after(async () => {
  await server.close()
  await closeAdminPool()
})

let admitted = { id: '', admissionNumber: '' }
let admittedPhone = ''

test('admission into a Class 9 section issues a login and texts the password to the primary guardian', async () => {
  admittedPhone = nextPhone()
  admitted = await admit(section9, admittedPhone)
  const texts = textsTo(admittedPhone)
  assert.equal(texts.length, 1)
  const text = texts[0]
  assert.ok(text)
  assert.match(text.secret, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
  assert.deepEqual(text.studentLogin, { schoolCode: SCHOOL_CODE, admissionNumber: admitted.admissionNumber })
  const words = studentPasswordText(text)
  assert.ok(words.includes(SCHOOL_CODE))
  assert.ok(words.includes(admitted.admissionNumber))
  assert.ok(words.includes(text.secret))

  const login = await view(admitted.id)
  assert.equal(login.state, 'active')
  assert.equal(login.username, admitted.admissionNumber)
  assert.equal(login.schoolCode, SCHOOL_CODE)
  assert.equal(login.passwordChangePending, true)
  assert.equal(login.blocker, undefined)
  assert.ok(login.guardianPhoneMasked && !login.guardianPhoneMasked.includes(admittedPhone.slice(3, 9)))
  assert.ok(login.allowedActions.includes('students.manage_login'))

  const identity = await identityOf(admitted.id)
  assert.match(identity.email, /^[0-9a-f-]{36}@student\.invalid$/)
  const membership = await adminPool().query<{ kind: string; status: string; roles: string[] }>(
    `SELECT m.kind, m.status, array_agg(r.key) AS roles FROM school_memberships m
       JOIN membership_roles mr ON mr.school_id = m.school_id AND mr.membership_id = m.id
       JOIN roles r ON r.school_id = mr.school_id AND r.id = mr.role_id
      WHERE m.id = $1 GROUP BY m.kind, m.status`,
    [identity.membershipId],
  )
  assert.deepEqual(membership.rows, [{ kind: 'student', status: 'active', roles: ['student'] }])
  const flag = await adminPool().query<{ must: boolean }>('SELECT must_change_password AS must FROM auth_user WHERE id = $1', [
    identity.userId,
  ])
  assert.equal(flag.rows[0]?.must, true)

  assert.deepEqual(
    (await loginAudits(admitted.id)).map((row) => [row.change, row.trigger]),
    [['issued', 'admission']],
  )
  const outbox = await adminPool().query<{ status: string; destination: string }>(
    `SELECT status, destination FROM delivery_outbox WHERE school_id = $1 AND event_type = 'student_password'`,
    [school],
  )
  assert.deepEqual(outbox.rows.map((row) => row.status), ['sent'])
  assert.ok(!outbox.rows[0]?.destination.includes(admittedPhone.slice(3, 9)), 'the outbox keeps a masked phone')
})

test('admission into Class 8 issues no login and sends nothing', async () => {
  const phone = nextPhone()
  const younger = await admit(section8, phone)
  assert.equal(textsTo(phone).length, 0)
  const login = await view(younger.id)
  assert.equal(login.state, 'none')
  assert.equal(login.blocker, 'not_senior')
  await refused(await owner.fetch(`${base}/students/${younger.id}/login`, json('POST')), 400, 'INVALID_REQUEST', 'student_login_not_eligible')
})

test('a pupil whose primary guardian has no phone gets no login until one is added', async () => {
  const noPhone = await pupil({ sectionId: section9, phone: null })
  const login = await view(noPhone.id)
  assert.equal(login.state, 'none')
  assert.equal(login.blocker, 'no_guardian_phone')
  assert.equal(login.guardianPhoneMasked, undefined)
  await refused(
    await owner.fetch(`${base}/students/${noPhone.id}/login`, json('POST')),
    400,
    'INVALID_REQUEST',
    'student_login_no_guardian_phone',
  )
  // A phone arrives; the office issues from the pupil's page.
  const phone = nextPhone()
  await adminPool().query(
    `UPDATE guardians SET phone = $3 WHERE school_id = $1 AND id IN
       (SELECT guardian_id FROM student_guardians WHERE school_id = $1 AND student_id = $2)`,
    [school, noPhone.id, phone],
  )
  const issued = await read<LoginView>(await owner.fetch(`${base}/students/${noPhone.id}/login`, json('POST')), 201)
  assert.equal(issued.state, 'active')
  assert.equal(textsTo(phone).length, 1)
  await refused(await owner.fetch(`${base}/students/${noPhone.id}/login`, json('POST')), 400, 'INVALID_REQUEST', 'student_login_exists')
  assert.deepEqual(
    (await loginAudits(noPhone.id)).map((row) => [row.change, row.trigger]),
    [['issued', 'office']],
  )
})

test('promotion from Class 8 into Class 9 issues a login after the commit', async () => {
  const phone = nextPhone()
  const moving = await pupil({ sectionId: section8, phone })
  assert.equal((await view(moving.id)).state, 'none')
  await read(
    await owner.fetch(
      `${base}/students/promote`,
      json('POST', {
        fromAcademicYearId: year,
        toAcademicYearId: nextYear,
        fromSectionId: section8,
        toSectionId: nextSection9,
        studentIds: [moving.id],
        detainedStudentIds: [],
        reason: 'End of year promotion',
      }),
    ),
    200,
  )
  assert.equal(textsTo(phone).length, 1)
  assert.equal((await view(moving.id)).state, 'active')
  assert.deepEqual(
    (await loginAudits(moving.id)).map((row) => [row.change, row.trigger]),
    [['issued', 'promotion']],
  )
})

let bulkPupils: { id: string; admissionNumber: string; phone: string }[] = []

test('issuing every missing login at once answers counts and texts each pupil', async () => {
  // Two pupils already in Class 10 with a phone, one without.
  const phones = [nextPhone(), nextPhone()]
  bulkPupils = []
  for (const phone of phones) bulkPupils.push({ ...(await pupil({ sectionId: section10, phone })), phone })
  await pupil({ sectionId: section10, phone: null })
  const had = await adminPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM membership_student_links l
       JOIN school_memberships m ON m.school_id = l.school_id AND m.id = l.membership_id
      WHERE l.school_id = $1 AND m.status IN ('active','suspended')`,
    [school],
  )
  const result = await read<Record<string, number>>(await owner.fetch(`${base}/students/logins/issue`, json('POST')), 200)
  // The no-phone pupil of the earlier test got a phone and a login; this one has none.
  assert.equal(result.issued, 2)
  assert.equal(result.noGuardianPhone, 1)
  assert.equal(result.textFailed, 0)
  // Every login the suite made so far: the promoted pupil counts too, since
  // next year's Class 9 is in a year that is not closed.
  assert.equal(result.alreadyHadLogin, had.rows[0]?.n)
  for (const entry of bulkPupils) {
    assert.equal(textsTo(entry.phone).length, 1)
    assert.deepEqual(
      (await loginAudits(entry.id)).map((row) => [row.change, row.trigger]),
      [['issued', 'bulk']],
    )
  }
  // A second run finds nobody new.
  const again = await read<Record<string, number>>(await owner.fetch(`${base}/students/logins/issue`, json('POST')), 200)
  assert.equal(again.issued, 0)
  assert.equal(again.noGuardianPhone, 1)
})

test('a pupil signs in with the school code, admission number and password, whatever the case and spaces', async () => {
  const texted = lastPassword(admittedPhone)
  for (const [code, number] of [
    [SCHOOL_CODE, admitted.admissionNumber],
    [SCHOOL_CODE.toUpperCase(), admitted.admissionNumber.toLowerCase()],
    [`  ${SCHOOL_CODE} `, ` ${admitted.admissionNumber}  `],
  ] as const) {
    const { response, text } = await studentSignIn(code, number, texted)
    assert.equal(response.status, 200, text)
    assert.deepEqual(JSON.parse(text), { signedIn: true, passwordChangeRequired: true })
    assert.ok(response.headers.getSetCookie().length > 0)
  }
})

test('every wrong answer is the same AUTHENTICATION_REQUIRED', async () => {
  const texted = lastPassword(admittedPhone)
  const bodies: unknown[] = []
  for (const [code, number, password] of [
    [SCHOOL_CODE, admitted.admissionNumber, 'wrong-pass-word'],
    [SCHOOL_CODE, `${admitted.admissionNumber}-X`, texted],
    ['fixture-b', admitted.admissionNumber, texted],
    ['no-such-school', admitted.admissionNumber, texted],
  ] as const) {
    const { response, text } = await studentSignIn(code, number, password)
    assert.equal(response.status, 401, text)
    const body = JSON.parse(text) as ErrorBody
    assert.equal(body.error.code, 'AUTHENTICATION_REQUIRED')
    delete body.error.requestId
    bodies.push(body)
    assert.equal(response.headers.getSetCookie().filter((line) => !/max-age=0/i.test(line)).length, 0)
  }
  for (const body of bodies) assert.deepEqual(body, bodies[0])
})

test('the generated address is refused at the email door even with the right password', async () => {
  const identity = await identityOf(admitted.id)
  const client = clientFor(server)
  const response = await client.signIn(identity.email, lastPassword(admittedPhone))
  const text = await response.text()
  responses.push(text)
  assert.equal(response.status, 401, text)
  assert.equal(await sessionsOf(identity.userId) > 0, true, 'the earlier sign-ins hold sessions; this one added none')
  const before = await sessionsOf(identity.userId)
  await client.signIn(identity.email.toUpperCase(), lastPassword(admittedPhone))
  assert.equal(await sessionsOf(identity.userId), before)
})

let pupilClient: Client

test('the texted password must be replaced before any school route answers', async () => {
  const texted = lastPassword(admittedPhone)
  const { client, response } = await studentSignIn(SCHOOL_CODE, admitted.admissionNumber, texted)
  assert.equal(response.status, 200)
  const me = await read<{ session: { passwordChangeRequired?: boolean }; memberships: { school: { id: string }; kind: string; roleKeys: string[] }[] }>(
    await client.fetch('/api/me'),
    200,
  )
  assert.equal(me.session.passwordChangeRequired, true)
  const own = me.memberships.find((entry) => entry.school.id === school)
  assert.equal(own?.kind, 'student')
  assert.deepEqual(own?.roleKeys, ['student'])
  for (const path of [
    `${base}/context`,
    `${base}/students/${admitted.id}`,
    `${base}/dashboard`,
    `${base}/messages/inbox`,
    `${base}/exams/students/${admitted.id}/results`,
  ])
    await refused(await client.fetch(path), 403, 'PASSWORD_CHANGE_REQUIRED')

  await read(
    await client.fetch('/api/auth/change-password', json('POST', { currentPassword: texted, newPassword: PUPIL_PASSWORD })),
    200,
  )
  const after = await read<{ session: { passwordChangeRequired?: boolean } }>(await client.fetch('/api/me'), 200)
  assert.equal(after.session.passwordChangeRequired, undefined)
  const context = await read<{ roleKeys: string[]; ownStudentId?: string; studentLoginEnabled: boolean }>(
    await client.fetch(`${base}/context`),
    200,
  )
  assert.deepEqual(context.roleKeys, ['student'])
  assert.equal(context.ownStudentId, admitted.id)
  assert.equal(context.studentLoginEnabled, true)
  await read(await client.fetch(`${base}/students/${admitted.id}`), 200)
  // Another pupil of the school answers exactly like an id that does not exist.
  const other = await refused(await client.fetch(`${base}/students/${bulkPupils[0]?.id}`), 404, 'RESOURCE_NOT_FOUND')
  const missing = await refused(await client.fetch(`${base}/students/${randomUUID()}`), 404, 'RESOURCE_NOT_FOUND')
  delete other.error.requestId
  delete missing.error.requestId
  assert.deepEqual(other, missing)
  assert.equal((await view(admitted.id)).passwordChangePending, false)

  // The old password no longer works; the new one does, with nothing pending.
  assert.equal((await studentSignIn(SCHOOL_CODE, admitted.admissionNumber, texted)).response.status, 401)
  const fresh = await studentSignIn(SCHOOL_CODE, admitted.admissionNumber, PUPIL_PASSWORD)
  assert.equal(fresh.response.status, 200)
  assert.deepEqual(JSON.parse(fresh.text), { signedIn: true, passwordChangeRequired: false })
  pupilClient = fresh.client
})

test('ten wrong passwords lock a pupil out, and the right one is then refused too', async () => {
  const target = bulkPupils[1]
  assert.ok(target)
  const texted = lastPassword(target.phone)
  for (let attempt = 0; attempt < MAX_FAILED_SIGN_INS; attempt += 1) {
    const { response } = await studentSignIn(SCHOOL_CODE, target.admissionNumber, `wrong-${attempt}`)
    assert.equal(response.status, 401)
  }
  const locked = await studentSignIn(SCHOOL_CODE, target.admissionNumber, texted)
  assert.equal(locked.response.status, 401, locked.text)
  assert.equal((JSON.parse(locked.text) as ErrorBody).error.code, 'AUTHENTICATION_REQUIRED')
})

test('resetting the password ends every session, texts a new one and asks for a change again', async () => {
  const identity = await identityOf(admitted.id)
  assert.ok((await sessionsOf(identity.userId)) > 0)
  const before = lastPassword(admittedPhone)
  const reset = await read<LoginView>(await owner.fetch(`${base}/students/${admitted.id}/login/reset-password`, json('POST')), 200)
  assert.equal(reset.state, 'active')
  assert.equal(reset.passwordChangePending, true)
  assert.equal(await sessionsOf(identity.userId), 0)
  assert.equal((await pupilClient.fetch('/api/me')).status, 401)
  const texted = lastPassword(admittedPhone)
  assert.notEqual(texted, before)
  assert.equal(textsTo(admittedPhone).length, 2)
  assert.equal((await studentSignIn(SCHOOL_CODE, admitted.admissionNumber, PUPIL_PASSWORD)).response.status, 401)
  const signed = await studentSignIn(SCHOOL_CODE, admitted.admissionNumber, texted)
  assert.equal(signed.response.status, 200)
  assert.deepEqual(JSON.parse(signed.text), { signedIn: true, passwordChangeRequired: true })
  assert.deepEqual(
    (await loginAudits(admitted.id)).map((row) => row.change),
    ['issued', 'password_reset'],
  )
  pupilClient = await signedInPupil(admitted.admissionNumber, texted)
})

test('switching a login off refuses the live session and a new sign-in; switching on restores it', async () => {
  const identity = await identityOf(admitted.id)
  await read(await pupilClient.fetch(`${base}/context`), 200)
  const current = await view(admitted.id)
  await refused(
    await owner.fetch(`${base}/students/${admitted.id}/login/switch-off`, json('POST', { expectedVersion: (current.version ?? 1) + 5 })),
    409,
    'VERSION_CONFLICT',
  )
  const off = await read<LoginView>(
    await owner.fetch(
      `${base}/students/${admitted.id}/login/switch-off`,
      json('POST', { expectedVersion: current.version, reason: 'Phone lost, family asked' }),
    ),
    200,
  )
  assert.equal(off.state, 'switched_off')
  const refusedLive = await pupilClient.fetch(`${base}/context`)
  responses.push(await refusedLive.text())
  assert.ok(refusedLive.status === 401 || refusedLive.status === 403, `live session answered ${refusedLive.status}`)
  assert.equal(await sessionsOf(identity.userId), 0)
  assert.equal((await studentSignIn(SCHOOL_CODE, admitted.admissionNumber, PUPIL_PASSWORD)).response.status, 401)
  await refused(
    await owner.fetch(`${base}/students/${admitted.id}/login/switch-off`, json('POST', { expectedVersion: off.version })),
    400,
    'INVALID_REQUEST',
    'student_login_missing',
  )

  const on = await read<LoginView>(
    await owner.fetch(`${base}/students/${admitted.id}/login/switch-on`, json('POST', { expectedVersion: off.version })),
    200,
  )
  assert.equal(on.state, 'active')
  const back = await studentSignIn(SCHOOL_CODE, admitted.admissionNumber, PUPIL_PASSWORD)
  assert.equal(back.response.status, 200, back.text)
  pupilClient = back.client
  await read(await pupilClient.fetch(`${base}/context`), 200)
  assert.deepEqual(
    (await loginAudits(admitted.id)).map((row) => row.change),
    ['issued', 'password_reset', 'switched_off', 'switched_on'],
  )
})

test('the office routes need students.manage_login: a teacher and a parent are refused, another school is not found', async () => {
  parent = await member(['parent'], { guardianOf: admitted.id })
  for (const client of [teacher, parent]) {
    for (const [path, init] of [
      [`${base}/students/${admitted.id}/login`, undefined],
      [`${base}/students/${admitted.id}/login/reset-password`, json('POST')],
      [`${base}/students/${admitted.id}/login/switch-off`, json('POST', { expectedVersion: 1 })],
      [`${base}/students/logins/issue`, json('POST')],
    ] as const) {
      const response = await client.fetch(path, init)
      const text = await response.text()
      responses.push(text)
      assert.ok(response.status === 403 || response.status === 404, `${path}: ${response.status} ${text}`)
      assert.notEqual(response.status, 200)
    }
  }
  // A pupil holds no office key either.
  const own = await pupilClient.fetch(`${base}/students/${admitted.id}/login`)
  responses.push(await own.text())
  assert.ok(own.status === 403 || own.status === 404)
  // The login is untouched.
  assert.equal((await view(admitted.id)).state, 'active')

  for (const id of [fixtureIds.studentB as string, randomUUID()]) {
    await refused(await owner.fetch(`${base}/students/${id}/login`), 404, 'RESOURCE_NOT_FOUND')
    await refused(await owner.fetch(`${base}/students/${id}/login`, json('POST')), 404, 'RESOURCE_NOT_FOUND')
    await refused(await owner.fetch(`${base}/students/${id}/login/reset-password`, json('POST')), 404, 'RESOURCE_NOT_FOUND')
  }
})

test('leaving ends the login and its sessions; admitting the pupil again issues a new one', async () => {
  const identity = await identityOf(admitted.id)
  assert.ok((await sessionsOf(identity.userId)) > 0)
  const record = await adminPool().query<{ version: number }>('SELECT version FROM students WHERE school_id = $1 AND id = $2', [
    school,
    admitted.id,
  ])
  await read(
    await owner.fetch(
      `${base}/students/${admitted.id}/leave`,
      json('POST', { expectedVersion: record.rows[0]?.version, leftOn: '2026-09-01', reason: 'Family moved city' }),
    ),
    204,
  )
  const ended = await view(admitted.id)
  assert.equal(ended.state, 'ended')
  assert.equal(ended.blocker, 'not_on_roll')
  assert.equal(await sessionsOf(identity.userId), 0)
  const live = await pupilClient.fetch('/api/me')
  responses.push(await live.text())
  assert.equal(live.status, 401)
  assert.equal((await studentSignIn(SCHOOL_CODE, admitted.admissionNumber, PUPIL_PASSWORD)).response.status, 401)
  const leaveAudit = await adminPool().query<{ safe_changes: Record<string, unknown> }>(
    `SELECT safe_changes FROM audit_events
      WHERE school_id = $1 AND action = 'students.manage_enrollment' AND safe_changes ? 'studentLoginEnded'`,
    [school],
  )
  // The leaving write's own audit row says the login ended; there is no second row.
  assert.equal(leaveAudit.rows.length, 1)
  assert.equal(leaveAudit.rows[0]?.safe_changes.studentLoginEnded, true)
  assert.deepEqual(
    (await loginAudits(admitted.id)).map((row) => row.change),
    ['issued', 'password_reset', 'switched_off', 'switched_on'],
  )
  await refused(
    await owner.fetch(`${base}/students/${admitted.id}/login/reset-password`, json('POST')),
    400,
    'INVALID_REQUEST',
    'student_login_missing',
  )

  // Back on the roll in Class 9: the office issues a new login to the same membership.
  await adminPool().query(`UPDATE students SET status = 'active', left_on = NULL, left_reason = NULL WHERE id = $1`, [admitted.id])
  await adminPool().query(
    `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,joined_on) VALUES ($1,$2,$3,$4,'2026-09-10')`,
    [school, admitted.id, year, section9],
  )
  const issued = await read<LoginView>(await owner.fetch(`${base}/students/${admitted.id}/login`, json('POST')), 201)
  assert.equal(issued.state, 'active')
  const renewed = await identityOf(admitted.id)
  assert.equal(renewed.membershipId, identity.membershipId)
  assert.notEqual(renewed.userId, identity.userId)
  const signed = await studentSignIn(SCHOOL_CODE, admitted.admissionNumber, lastPassword(admittedPhone))
  assert.equal(signed.response.status, 200, signed.text)
})

test('no response, log line, audit row or outbox payload carries a password or a generated address', async () => {
  for (const message of server.delivery.outbox) if (message.purpose === 'student_password') secrets.add(message.secret)
  assert.ok(secrets.size >= 6)
  assert.ok(addresses.size >= 2)
  const audits = await adminPool().query<{ summary: string; safe_changes: unknown }>(
    'SELECT summary, safe_changes FROM audit_events WHERE school_id = $1',
    [school],
  )
  const notes = await adminPool().query<{ note: unknown }>(
    'SELECT to_jsonb(n) AS note FROM audit_event_notes n WHERE school_id = $1',
    [school],
  )
  const outbox = await adminPool().query<{ row: unknown }>(
    'SELECT to_jsonb(o) AS row FROM delivery_outbox o WHERE school_id = $1',
    [school],
  )
  const haystacks: [string, string][] = [
    ...responses.map((text, index) => [`response ${index}`, text] as [string, string]),
    ...logLines.map((line, index) => [`log ${index}`, line] as [string, string]),
    ...audits.rows.map((row, index) => [`audit ${index}`, JSON.stringify(row)] as [string, string]),
    ...notes.rows.map((row, index) => [`note ${index}`, JSON.stringify(row)] as [string, string]),
    ...outbox.rows.map((row, index) => [`outbox ${index}`, JSON.stringify(row)] as [string, string]),
  ]
  for (const [label, text] of haystacks) {
    assert.ok(!text.includes('@student.invalid'), `${label} names a generated address`)
    for (const secret of secrets) assert.ok(!text.includes(secret), `${label} carries a password`)
    for (const address of addresses) assert.ok(!text.includes(address.split('@')[0] ?? address), `${label} carries an identity address`)
  }
  // The outbox rows say which pupil, never what was sent.
  for (const row of outbox.rows as { row: { event_type: string; payload: Record<string, unknown> } }[])
    if (row.row.event_type === 'student_password') assert.deepEqual(Object.keys(row.row.payload), ['studentId'])
  // The refused sign-ins were logged (counts and status only), so the capture saw real lines.
  assert.ok(logLines.some((line) => line.includes('student sign-in refused')))
})
