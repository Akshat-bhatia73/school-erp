import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { deflateSync } from 'node:zlib'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
  setFixturePassword,
  signInWithMfa,
  signInWithPassword,
  startTestServer,
  type TestServer,
} from './harness.ts'

const PASSWORD = 'Fixture-Pass!42'
// Unique per run: other test files rewrite the same fixture identities.
const OWNER_EMAIL = `photos-owner-${randomUUID()}@example.test`
const PARENT_EMAIL = `photos-parent-${randomUUID()}@example.test`
const TEACHER_EMAIL = `photos-teacher-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const studentA = fixtureIds.studentA as string
const studentA2 = fixtureIds.studentA2 as string
const guardianA = fixtureIds.guardianA as string
const guardianA2 = fixtureIds.guardianA2 as string
const staffA = fixtureIds.staffA as string
const sectionA = fixtureIds.sectionA as string
const gradeA = fixtureIds.gradeA as string
const yearA = fixtureIds.yearA as string
const ownerUserId = fixtureIds.ownerAUser as string
const parentUserId = fixtureIds.parentA2User as string

// Rows this file owns.
const teacherUser = '10000000-0000-4000-8000-0000000021a1'
const teacherMembership = '10000000-0000-4000-8000-0000000021a2'
const teacherStaff = '10000000-0000-4000-8000-0000000021a3'
const subjectId = '10000000-0000-4000-8000-0000000021a4'
const enrollmentA = '10000000-0000-4000-8000-0000000021a5'
// A second class of the same grade, which this file's teacher does not teach.
const sectionB = '10000000-0000-4000-8000-0000000021a6'

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let parent: Client
let teacher: Client

/* ------------------------------------------------------------------ */
/* Pictures. The same shapes the image checker's own tests use, so a   */
/* file here is structurally real and not a blob with a lucky prefix.  */
/* ------------------------------------------------------------------ */

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header[0] = 0xff
  header[1] = marker
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([header, payload])
}

/** A JPEG with a JFIF header, whatever blocks are asked for, and a scan. */
function jpeg(extra: readonly Buffer[] = [], scanBytes = 3): Buffer {
  const soi = Buffer.from([0xff, 0xd8])
  const app0 = jpegSegment(0xe0, Buffer.from('JFIF\0\x01\x02\0\0\x01\0\x01\0\0', 'latin1'))
  const sos = Buffer.concat([
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.alloc(scanBytes, 0x5a),
    Buffer.from([0xff, 0xd9]),
  ])
  return Buffer.concat([soi, app0, ...extra, sos])
}

/** The place a picture was taken, which must never reach the store. */
const EXIF_PLACE = 'GPSLatitude 12.9716 GPSLongitude 77.5946'
const EXIF = jpegSegment(0xe1, Buffer.from(`Exif\0\0MM\0*${EXIF_PLACE}`, 'latin1'))
const COMMENT = jpegSegment(0xfe, Buffer.from('Taken at home', 'latin1'))

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, data, Buffer.alloc(4)])
}

function png(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 0
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('tEXt', Buffer.from('Author\0Someone', 'latin1')),
    pngChunk('IDAT', deflateSync(Buffer.from([0x00, 0x00]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

interface PhotoRow {
  version: number
  photo_storage_key: string | null
  photo_content_type: string | null
  photo_updated_at: string | null
}

async function photoRow(table: 'students' | 'staff', id: string): Promise<PhotoRow> {
  // The storage key is server state, so the migrator connection is the only
  // way to see it at all.
  const found = await adminPool().query<PhotoRow>(
    `SELECT version, photo_storage_key, photo_content_type, photo_updated_at::text AS photo_updated_at
       FROM ${table} WHERE school_id = $1 AND id = $2`,
    [schoolA, id],
  )
  const row = found.rows[0]
  assert.ok(row, 'the record exists')
  return row
}

/** The bytes the store actually holds for a record, if any. */
async function storedBytes(key: string): Promise<Buffer | null> {
  const file = await server.documents.read(key)
  if (!file) return null
  const chunks: Uint8Array[] = []
  for await (const chunk of file.stream as ReadableStream<Uint8Array>) chunks.push(chunk)
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
}

function studentPhotoPath(id: string, version?: number): string {
  const base = `/api/schools/${schoolA}/students/${id}/photo`
  return version === undefined ? base : `${base}?expectedVersion=${version}`
}

function staffPhotoPath(id: string, version?: number): string {
  const base = `/api/schools/${schoolA}/staff/${id}/photo`
  return version === undefined ? base : `${base}?expectedVersion=${version}`
}

async function upload(
  client: Client,
  path: string,
  bytes: Buffer,
  contentType = 'image/jpeg',
): Promise<Response> {
  return client.fetch(path, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: new Uint8Array(bytes),
  })
}

/** Upload for a student that is already consented, and return the new key. */
async function uploadStudentPhoto(id: string, bytes = jpeg([EXIF])): Promise<string> {
  const before = await photoRow('students', id)
  const response = await upload(owner, studentPhotoPath(id, before.version), bytes)
  assert.equal(response.status, 204)
  const after = await photoRow('students', id)
  assert.ok(after.photo_storage_key)
  return after.photo_storage_key
}

async function recordConsent(
  client: Client,
  studentId: string,
  guardianId: string,
  status: 'given' | 'withdrawn',
): Promise<Response> {
  return client.fetch(`/api/schools/${schoolA}/students/${studentId}/consents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      guardianId,
      purpose: 'photographs',
      status,
      method: 'signed_form',
    }),
  })
}

/**
 * A student of this school in a class nobody in this file teaches, with a
 * guardian of her own who has agreed to photographs. Each caller gets a fresh
 * record, so one test's anonymisation cannot reach another's.
 */
let outsiderCount = 0
async function admitOutsider(): Promise<string> {
  outsiderCount += 1
  const phone = `+9198127${String(31000 + outsiderCount).padStart(5, '0')}`
  const response = await owner.fetch(`/api/schools/${schoolA}/students`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firstName: 'Photo',
      lastName: 'Outsider',
      dateOfBirth: '2015-06-01',
      gender: 'female',
      admissionDate: '2021-04-01',
      sectionId: sectionB,
      guardians: [
        {
          guardian: { firstName: 'Photo', lastName: 'Parent', phone },
          relation: 'mother',
          isPrimary: true,
        },
      ],
    }),
  })
  assert.equal(response.status, 201)
  const created = (await response.json()) as { id: string }

  const guardians = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/guardians`)
  assert.equal(guardians.status, 200)
  const first = ((await guardians.json()) as { id: string }[])[0]
  assert.ok(first)
  assert.equal((await recordConsent(owner, created.id, first.id, 'given')).status, 200)
  return created.id
}

async function countPhotoAudits(targetId: string): Promise<number> {
  const found = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events
      WHERE school_id = $1 AND target_id = $2 AND summary ILIKE '%photograph%'`,
    [schoolA, targetId],
  )
  return Number(found.rows[0]?.count ?? '0')
}

/** Clear a student's photograph straight in the row, between tests. */
async function forgetPhoto(table: 'students' | 'staff', id: string): Promise<void> {
  await adminPool().query(
    `UPDATE ${table} SET photo_storage_key = NULL, photo_content_type = NULL,
            photo_updated_at = NULL, version = version + 1
      WHERE school_id = $1 AND id = $2`,
    [schoolA, id],
  )
}

async function seedModuleRows(): Promise<void> {
  const pool = adminPool()
  await pool.query(
    `INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,'Drawing','DRW','co_scholastic')
     ON CONFLICT (school_id,code) DO NOTHING`,
    [subjectId, schoolA],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,'PB')
     ON CONFLICT (school_id,academic_year_id,grade_id,name) DO NOTHING`,
    [sectionB, schoolA, yearA, gradeA],
  )
  await pool.query(
    `INSERT INTO auth_user(id,name,email) VALUES ($1,'Photo Teacher',$2)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    [teacherUser, TEACHER_EMAIL],
  )
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')
     ON CONFLICT (school_id,user_id) DO NOTHING`,
    [teacherMembership, schoolA, teacherUser],
  )
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = 'teacher' ON CONFLICT DO NOTHING`,
    [schoolA, teacherMembership],
  )
  await pool.query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status)
     VALUES ($1,$2,'PH-A','Photo','teaching','Teacher','active')
     ON CONFLICT (school_id,employee_code) DO NOTHING`,
    [teacherStaff, schoolA],
  )
  await pool.query(
    `INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING`,
    [schoolA, teacherMembership, teacherStaff],
  )
  await pool.query(
    `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from)
     VALUES ($1,$2,$3,$4,$5,'2026-04-01') ON CONFLICT DO NOTHING`,
    [schoolA, teacherStaff, yearA, sectionA, subjectId],
  )
  // Only studentA sits in this teacher's section, so studentA2 is a pupil the
  // same teacher must not be able to see.
  await pool.query(
    `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
     VALUES ($5,$1,$2,$3,$4,1,'2026-04-01')
     ON CONFLICT (id) DO UPDATE SET left_on = NULL, outcome = 'ongoing'`,
    [schoolA, studentA, yearA, sectionA, enrollmentA],
  )
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [parentUserId, PARENT_EMAIL])
  await seedModuleRows()
  await setFixturePassword(server, teacherUser, PASSWORD)
  await setFixturePassword(server, parentUserId, PASSWORD)
  owner = await signInWithMfa(server, {
    userId: ownerUserId,
    email: OWNER_EMAIL,
    password: PASSWORD,
  })
  parent = await signInWithMfa(server, {
    userId: parentUserId,
    email: PARENT_EMAIL,
    password: PASSWORD,
  })
  teacher = await signInWithPassword(server, TEACHER_EMAIL, PASSWORD)
  // Both families have agreed to photographs; the one test that needs a
  // record with no agreement withdraws it again for itself.
  assert.equal((await recordConsent(owner, studentA, guardianA, 'given')).status, 200)
  assert.equal((await recordConsent(owner, studentA2, guardianA2, 'given')).status, 200)
})

after(async () => {
  const pool = adminPool()
  for (const userId of [ownerUserId, parentUserId]) {
    await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [userId])
    await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [userId])
  }
  await server.close()
  await closeAdminPool()
})

test('a photograph is stored without the place it was taken, and the row names it', async () => {
  const key = await uploadStudentPhoto(studentA, jpeg([EXIF, COMMENT]))
  const bytes = await storedBytes(key)
  assert.ok(bytes)
  assert.equal(bytes.includes(Buffer.from(EXIF_PLACE, 'latin1')), false)
  assert.equal(bytes.includes(Buffer.from('Taken at home', 'latin1')), false)
  // The picture itself survived: the scan bytes are still there.
  assert.equal(bytes.includes(Buffer.from([0x5a, 0x5a, 0x5a])), true)

  const row = await photoRow('students', studentA)
  assert.equal(row.photo_content_type, 'image/jpeg')
  assert.ok(row.photo_updated_at)
  // The key is a name nobody can guess and it says nothing about the person.
  assert.match(row.photo_storage_key ?? '', new RegExp(`^photos/${schoolA}/student/${studentA}-[0-9a-f]{32}$`))
})

test('a PNG is accepted and loses its text chunks', async () => {
  const key = await uploadStudentPhoto(studentA, png())
  const bytes = await storedBytes(key)
  assert.ok(bytes)
  assert.equal(bytes.includes(Buffer.from('Someone', 'latin1')), false)
  assert.equal((await photoRow('students', studentA)).photo_content_type, 'image/png')
})

test('a drawing, a page and an oversized file are all refused and nothing is stored', async () => {
  const key = await uploadStudentPhoto(studentA)
  const version = (await photoRow('students', studentA)).version

  const refused: [string, Buffer, string][] = [
    ['image/svg+xml', Buffer.from('<svg onload="alert(1)"></svg>'), 'a drawing that runs'],
    ['image/jpeg', Buffer.from('<!doctype html><script>alert(1)</script>'), 'a page in disguise'],
    ['image/jpeg', jpeg([], 1_100_000), 'more than a megabyte'],
  ]
  for (const [contentType, bytes, what] of refused) {
    // A file the server refuses mid-upload can close the connection, which
    // the client sees as a failed request: that is a refusal too.
    const status = await upload(owner, studentPhotoPath(studentA, version), bytes, contentType)
      .then((response) => response.status)
      .catch(() => 413)
    assert.ok(status === 400 || status === 413, `${what}: ${status}`)
  }

  // The record still names the picture it had, and no stray bytes were kept.
  const after = await photoRow('students', studentA)
  assert.equal(after.photo_storage_key, key)
  assert.equal(after.version, version)
})

test('the bytes are served with a private type and no storage key anywhere', async () => {
  const key = await uploadStudentPhoto(studentA)
  const response = await owner.fetch(studentPhotoPath(studentA))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/jpeg')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  // The route asks for "private, no-store"; the application-wide hook has the
  // last word and says "no-store", which keeps the bytes out of every cache.
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  assert.equal(response.headers.get('content-disposition'), 'inline; filename="photo"')

  const random = key.slice(key.lastIndexOf('-') + 1)
  for (const [, value] of response.headers) assert.equal(value.includes(random), false)

  const served = Buffer.from(await response.arrayBuffer())
  const stored = await storedBytes(key)
  assert.deepEqual(served, stored)
  assert.equal(served.includes(Buffer.from(random, 'latin1')), false)
})

test('a teacher sees a pupil of her own section and nobody else', async () => {
  await uploadStudentPhoto(studentA)
  const outsider = await admitOutsider()
  await uploadStudentPhoto(outsider)

  const mine = await teacher.fetch(studentPhotoPath(studentA))
  assert.equal(mine.status, 200)

  // Another class is not this teacher's to look at, and the answer is the
  // same one a student who does not exist would get.
  const other = await teacher.fetch(studentPhotoPath(outsider))
  assert.equal(other.status, 404)
  const missing = await teacher.fetch(studentPhotoPath('10000000-0000-4000-8000-0000000099ff'))
  assert.equal(missing.status, 404)
})

test('a parent sees her own child and not another family', async () => {
  await uploadStudentPhoto(studentA)
  await uploadStudentPhoto(studentA2)

  const mine = await parent.fetch(studentPhotoPath(studentA2))
  assert.equal(mine.status, 200)
  const other = await parent.fetch(studentPhotoPath(studentA))
  assert.equal(other.status, 404)
})

test('replacing a photograph destroys the bytes it replaced', async () => {
  const first = await uploadStudentPhoto(studentA, jpeg([EXIF]))
  const second = await uploadStudentPhoto(studentA, png())

  assert.notEqual(first, second)
  assert.equal(await storedBytes(first), null)
  assert.ok(await storedBytes(second))
})

test('removing a photograph clears the row and the bytes, and a second try finds nothing', async () => {
  const key = await uploadStudentPhoto(studentA)
  const version = (await photoRow('students', studentA)).version

  const removed = await owner.fetch(studentPhotoPath(studentA, version), { method: 'DELETE' })
  assert.equal(removed.status, 204)
  const row = await photoRow('students', studentA)
  assert.equal(row.photo_storage_key, null)
  assert.equal(row.photo_content_type, null)
  assert.equal(row.photo_updated_at, null)
  assert.equal(await storedBytes(key), null)

  const again = await owner.fetch(studentPhotoPath(studentA, row.version), { method: 'DELETE' })
  assert.equal(again.status, 404)
})

test('one audit row per write, and none for looking at a picture', async () => {
  await forgetPhoto('students', studentA)
  const before = await countPhotoAudits(studentA)

  await uploadStudentPhoto(studentA)
  const added = await countPhotoAudits(studentA)
  assert.equal(added, before + 1)

  await uploadStudentPhoto(studentA, png())
  assert.equal(await countPhotoAudits(studentA), before + 2)

  // Three readings, by three different people, leave no trace.
  for (const client of [owner, teacher, owner]) {
    const response = await client.fetch(studentPhotoPath(studentA))
    assert.equal(response.status, 200)
  }
  assert.equal(await countPhotoAudits(studentA), before + 2)

  // An audit row for a photograph says what happened and nothing more.
  const rows = await adminPool().query<{ safe_changes: unknown; summary: string }>(
    `SELECT safe_changes, summary FROM audit_events
      WHERE school_id = $1 AND target_id = $2 AND summary ILIKE '%photograph%'
      ORDER BY created_at DESC LIMIT 2`,
    [schoolA, studentA],
  )
  for (const row of rows.rows) {
    const text = JSON.stringify(row.safe_changes)
    assert.equal(/photos\//.test(text), false)
    assert.equal(/[0-9a-f]{32}/.test(text), false)
  }
  assert.deepEqual(
    rows.rows.map((row) => (row.safe_changes as { photo?: string }).photo).sort(),
    ['added', 'replaced'],
  )
})

test('a photograph may not be uploaded while the family has not agreed', async () => {
  await forgetPhoto('students', studentA)
  assert.equal((await recordConsent(owner, studentA, guardianA, 'withdrawn')).status, 200)

  const version = (await photoRow('students', studentA)).version
  const response = await upload(owner, studentPhotoPath(studentA, version), jpeg([EXIF]))
  assert.equal(response.status, 409)
  const code = ((await response.json()) as { error: { code: string } }).error.code
  assert.equal(code, 'NOT_ALLOWED_YET')
  assert.equal((await photoRow('students', studentA)).photo_storage_key, null)

  // Agreeing again makes it possible, and nothing else had to change.
  assert.equal((await recordConsent(owner, studentA, guardianA, 'given')).status, 200)
  await uploadStudentPhoto(studentA)
})

test('withdrawing the photograph consent takes the picture away', async () => {
  const key = await uploadStudentPhoto(studentA)
  assert.ok(await storedBytes(key))

  assert.equal((await recordConsent(owner, studentA, guardianA, 'withdrawn')).status, 200)

  const row = await photoRow('students', studentA)
  assert.equal(row.photo_storage_key, null)
  assert.equal(row.photo_content_type, null)
  assert.equal(await storedBytes(key), null)
  assert.equal((await owner.fetch(studentPhotoPath(studentA))).status, 404)

  assert.equal((await recordConsent(owner, studentA, guardianA, 'given')).status, 200)
})

test('anonymising a student destroys the photograph bytes', async () => {
  const student = await admitOutsider()
  const key = await uploadStudentPhoto(student)

  // The record is only ready once the pupil has left and the retention
  // period has run out.
  await adminPool().query(
    `UPDATE enrollments SET left_on = current_date, outcome = 'left'
      WHERE school_id = $1 AND student_id = $2`,
    [schoolA, student],
  )
  await adminPool().query(
    `UPDATE students SET status = 'left', left_on = current_date - interval '4 years',
            version = version + 1 WHERE school_id = $1 AND id = $2`,
    [schoolA, student],
  )
  const response = await owner.fetch(`/api/schools/${schoolA}/students/${student}/anonymise`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedVersion: (await photoRow('students', student)).version,
      reason: 'The retention period is over.',
    }),
  })
  assert.equal(response.status, 200)

  const row = await photoRow('students', student)
  assert.equal(row.photo_storage_key, null)
  assert.equal(await storedBytes(key), null)
})

test('a member of staff keeps her own picture and cannot look at another record', async () => {
  // staff.update_private reaches a person's own record, so a teacher may set
  // her own photograph without anybody else being involved.
  const mine = await photoRow('staff', teacherStaff)
  const put = await upload(teacher, staffPhotoPath(teacherStaff, mine.version), jpeg([EXIF, COMMENT]))
  assert.equal(put.status, 204)

  const row = await photoRow('staff', teacherStaff)
  assert.ok(row.photo_storage_key)
  const bytes = await storedBytes(row.photo_storage_key)
  assert.ok(bytes)
  assert.equal(bytes.includes(Buffer.from(EXIF_PLACE, 'latin1')), false)
  assert.equal(bytes.includes(Buffer.from('Taken at home', 'latin1')), false)

  const seen = await teacher.fetch(staffPhotoPath(teacherStaff))
  assert.equal(seen.status, 200)
  assert.equal(seen.headers.get('x-content-type-options'), 'nosniff')
  assert.match(seen.headers.get('cache-control') ?? '', /no-store/)
  assert.deepEqual(Buffer.from(await seen.arrayBuffer()), bytes)

  // Another staff record answers the photograph route exactly as it answers
  // the directory read: this teacher is not allowed either of them.
  const otherRecord = await teacher.fetch(`/api/schools/${schoolA}/staff/${staffA}`)
  assert.equal(otherRecord.status, 404)
  const otherPhoto = await teacher.fetch(staffPhotoPath(staffA))
  assert.equal(otherPhoto.status, 404)

  // A parent has no business in the staff directory at all.
  const refused = await parent.fetch(staffPhotoPath(teacherStaff))
  assert.equal(refused.ok, false)

  // The office may take it away again, and the bytes go with it.
  const removed = await owner.fetch(staffPhotoPath(teacherStaff, row.version), { method: 'DELETE' })
  assert.equal(removed.status, 204)
  assert.equal(await storedBytes(row.photo_storage_key), null)
  assert.equal((await photoRow('staff', teacherStaff)).photo_storage_key, null)
})

test('a refused upload never reaches the store', async () => {
  await uploadStudentPhoto(studentA)
  const outsider = await admitOutsider()
  const missing = '10000000-0000-4000-8000-0000000099ff'
  const version = (await photoRow('students', studentA)).version

  // Every refusal a caller can provoke: someone else's child, a record that
  // is not there, a family that has not agreed, and a version somebody else
  // already moved on from.
  await forgetPhoto('students', studentA2)
  assert.equal((await recordConsent(owner, studentA2, guardianA2, 'withdrawn')).status, 200)

  const refusals: [string, () => Promise<Response>][] = [
    [
      'a pupil this teacher does not teach',
      async () =>
        upload(teacher, studentPhotoPath(outsider, (await photoRow('students', outsider)).version), jpeg()),
    ],
    ['a record that is not there', async () => upload(owner, studentPhotoPath(missing, 1), jpeg())],
    [
      'a family that has not agreed',
      async () =>
        upload(owner, studentPhotoPath(studentA2, (await photoRow('students', studentA2)).version), jpeg()),
    ],
    ['a version somebody else moved on from', async () => upload(owner, studentPhotoPath(studentA, version + 5), jpeg())],
    [
      'a member of staff another teacher may not edit',
      async () => upload(teacher, staffPhotoPath(staffA, (await photoRow('staff', staffA)).version), jpeg()),
    ],
    ['a member of staff who is not there', async () => upload(owner, staffPhotoPath(missing, 1), jpeg())],
  ]

  for (const [what, attempt] of refusals) {
    const held = server.documents.count()
    const response = await attempt()
    assert.equal(response.ok, false, what)
    assert.equal(server.documents.count(), held, `${what} stored nothing`)
  }

  // The record the office may edit still names exactly the picture it had.
  assert.equal((await photoRow('students', studentA)).version, version)
  assert.equal((await recordConsent(owner, studentA2, guardianA2, 'given')).status, 200)
})

test('an upload that says it is too big is refused in plain words', async () => {
  const version = (await photoRow('students', studentA)).version
  const held = server.documents.count()
  const response = await upload(owner, studentPhotoPath(studentA, version), jpeg([], 1_100_000))
    .then((answer) => answer)
    .catch(() => null)
  assert.ok(response, 'the connection stayed open')
  assert.equal(response.status, 413)
  const body = (await response.json()) as { error: { code: string; message: string } }
  assert.equal(body.error.code, 'INVALID_REQUEST')
  assert.equal(body.error.message, 'Choose a photo smaller than 1 MB.')
  assert.equal(server.documents.count(), held)
})

test('the photograph route keeps its own cache rule', async () => {
  await uploadStudentPhoto(studentA)
  const response = await owner.fetch(studentPhotoPath(studentA))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')

  // Every other answer still says no-store in the application's own words.
  const list = await owner.fetch(`/api/schools/${schoolA}/students`)
  assert.equal(list.status, 200)
  assert.equal(list.headers.get('cache-control'), 'no-store')
})
