import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
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
const OWNER_EMAIL = `files-owner-${randomUUID()}@example.test`
const ADULT_EMAIL = `files-adult-${randomUUID()}@example.test`
const PARENT_EMAIL = `files-parent-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const studentA = fixtureIds.studentA as string
const studentB = fixtureIds.studentB as string
const documentA = fixtureIds.documentA as string
const ownerUserId = fixtureIds.ownerAUser as string
const ownerMembership = fixtureIds.ownerA as string
const adultUserId = fixtureIds.adultUser as string
const adultMembership = fixtureIds.adult as string
const parentUserId = fixtureIds.parentA2User as string

const BYTES = new TextEncoder().encode('%PDF-1.4 fixture bytes')

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let adult: Client
let parent: Client
/** Rows this run inserted itself, so assertions never count fixture totals. */
let documentB = ''
let missingBytesDocument = ''
/** A document of studentA2, whose stored name needs sanitising in a header. */
let ownChildDocument = ''
/** Every export job this suite inserts, removed again in after(). */
const insertedJobs: string[] = []
let ownerAccessVersion = 0

interface ErrorBody {
  error: { code: string; requestId: string }
}

async function auditCountFor(targetId: string): Promise<number> {
  const result = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events
      WHERE school_id = $1 AND target_id = $2 AND action = 'students.download_documents'`,
    [schoolA, targetId],
  )
  return Number(result.rows[0]?.count ?? '0')
}

async function insertJob(opts: {
  membershipId: string
  accessVersion: number
  permission: string
  status?: string
  expiresAt?: string
}): Promise<string> {
  const id = randomUUID()
  insertedJobs.push(id)
  await adminPool().query(
    `INSERT INTO export_jobs
       (id, school_id, requested_by_membership_id, kind, status, access_version, permission, expires_at)
     VALUES ($1, $2, $3, 'students', $4, $5, $6, $7)`,
    [
      id,
      schoolA,
      opts.membershipId,
      opts.status ?? 'ready',
      opts.accessVersion,
      opts.permission,
      opts.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
    ],
  )
  return id
}

/** The bytes of a job that already holds a file, and the key they sit under. */
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * A job with a file behind it. The key is built the way the runner builds one
 * and the bytes are put into the same in-memory store the server reads, so the
 * download route finds a real file without any producer running.
 */
async function insertJobWithFile(opts: {
  membershipId: string
  accessVersion: number
  permission: string
  kind: string
  contentType: string
  fileName: string
  status?: string
  expiresAt?: string
  /** What the producer was told to build; a job naming one record needs it. */
  criteria?: Record<string, unknown>
}): Promise<string> {
  const id = randomUUID()
  insertedJobs.push(id)
  const extension = opts.contentType === XLSX_TYPE ? 'xlsx' : 'pdf'
  const storageKey = `exports/${schoolA}/${id}.${extension}`
  await adminPool().query(
    `INSERT INTO export_jobs
       (id, school_id, requested_by_membership_id, kind, status, access_version, permission,
        criteria, storage_key, file_name, content_type, row_count, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $12::jsonb, $8, $9, $10, 1, $11)`,
    [
      id,
      schoolA,
      opts.membershipId,
      opts.kind,
      opts.status ?? 'ready',
      opts.accessVersion,
      opts.permission,
      storageKey,
      opts.fileName,
      opts.contentType,
      opts.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
      JSON.stringify(opts.criteria ?? {}),
    ],
  )
  server.documents.put(storageKey, BYTES, opts.contentType)
  return id
}

async function exportAuditCount(jobId: string): Promise<number> {
  const result = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events
      WHERE school_id = $1 AND target_id = $2 AND target_type = 'export_job'`,
    [schoolA, jobId],
  )
  return Number(result.rows[0]?.count ?? '0')
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()
  for (const [userId, email] of [
    [ownerUserId, OWNER_EMAIL],
    [adultUserId, ADULT_EMAIL],
    [parentUserId, PARENT_EMAIL],
  ] as const) {
    await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [userId, email])
    await setFixturePassword(server, userId, PASSWORD)
  }

  // School B's own document, and a school A document whose bytes were never
  // stored, so both safe not-found paths have a real row behind them.
  documentB = randomUUID()
  await pool.query(
    `INSERT INTO student_documents(id, school_id, student_id, document_type, file_name, storage_key, size_bytes)
     VALUES ($1, $2, $3, 'birth_certificate', 'b.pdf', 'fixtures/b.pdf', 1)`,
    [documentB, schoolB, studentB],
  )
  missingBytesDocument = randomUUID()
  await pool.query(
    `INSERT INTO student_documents(id, school_id, student_id, document_type, file_name, storage_key, size_bytes)
     VALUES ($1, $2, $3, 'birth_certificate', 'gone"\r\n.pdf', $4, 1)`,
    [missingBytesDocument, schoolA, studentA, `fixtures/${randomUUID()}.pdf`],
  )
  ownChildDocument = randomUUID()
  await pool.query(
    `INSERT INTO student_documents(id, school_id, student_id, document_type, file_name, storage_key, size_bytes)
     VALUES ($1, $2, $3, 'birth_certificate', 'own"\r\nx.pdf', 'fixtures/own.pdf', 1)`,
    [ownChildDocument, schoolA, fixtureIds.studentA2 as string],
  )
  const version = await pool.query<{ access_version: number }>(
    'SELECT access_version FROM school_memberships WHERE id = $1',
    [ownerMembership],
  )
  ownerAccessVersion = version.rows[0]?.access_version ?? 0

  server.documents.put('fixtures/a.pdf', BYTES, 'application/pdf')
  server.documents.put('fixtures/own.pdf', BYTES, 'application/pdf')

  owner = await signInWithMfa(server, {
    userId: ownerUserId,
    email: OWNER_EMAIL,
    password: PASSWORD,
  })
  adult = await signInWithPassword(server, ADULT_EMAIL, PASSWORD)
  parent = await signInWithPassword(server, PARENT_EMAIL, PASSWORD)
})

after(async () => {
  const pool = adminPool()
  // Leave the shared database as this suite found it, so a later suite that
  // lists a student's documents sees only the fixture row.
  await pool.query('DELETE FROM export_jobs WHERE id = ANY($1::uuid[])', [insertedJobs])
  await pool.query('DELETE FROM student_documents WHERE id = ANY($1::uuid[])', [
    [documentB, missingBytesDocument, ownChildDocument].filter((id) => id.length > 0),
  ])
  for (const userId of [ownerUserId, parentUserId]) {
    await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [userId])
    await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [userId])
  }
  await server.close()
  await closeAdminPool()
})

const contentPath = (school: string, student: string, document: string) =>
  `/api/schools/${school}/students/${student}/documents/${document}/content`

test('an anonymous caller cannot download a document', async () => {
  const response = await server.fetch(contentPath(schoolA, studentA, documentA))
  assert.equal(response.status, 401)
})

test('a school A member cannot use school B in the path', async () => {
  const response = await owner.fetch(contentPath(schoolB, studentB, documentB))
  assert.equal(response.status, 403)
  const body = (await response.json()) as ErrorBody
  assert.equal(body.error.code, 'SCHOOL_ACCESS_UNAVAILABLE')
})

test("a school B document id through school A's path is not found", async () => {
  const response = await owner.fetch(contentPath(schoolA, studentA, documentB))
  assert.equal(response.status, 404)
  const body = (await response.json()) as ErrorBody
  assert.equal(body.error.code, 'RESOURCE_NOT_FOUND')
  assert.equal(await auditCountFor(documentB), 0)
})

test('a document of another student in the same school is not found', async () => {
  const response = await owner.fetch(
    contentPath(schoolA, fixtureIds.studentA2 as string, documentA),
  )
  assert.equal(response.status, 404)
})

test('the owner downloads the document and gets the bytes and headers', async () => {
  const before_ = await auditCountFor(documentA)
  const response = await owner.fetch(contentPath(schoolA, studentA, documentA))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/pdf')
  assert.equal(response.headers.get('content-length'), String(BYTES.byteLength))
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="fixture.pdf"')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = new Uint8Array(await response.arrayBuffer())
  assert.deepEqual([...body], [...BYTES])
  assert.equal(await auditCountFor(documentA), before_ + 1)
  const audit = await adminPool().query<{ summary: string; target_type: string }>(
    `SELECT summary, target_type FROM audit_events
      WHERE school_id = $1 AND target_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [schoolA, documentA],
  )
  assert.equal(audit.rows[0]?.target_type, 'student_document')
  assert.equal(audit.rows[0]?.summary, 'Downloaded a student document')
})

test('a guardian without a download grant is refused at the gate', async () => {
  // The adult membership is teacher and parent; neither template grants
  // students.download_documents anywhere, so the module action itself is
  // refused before any record is considered.
  const response = await adult.fetch(contentPath(schoolA, studentA, documentA))
  assert.equal(response.status, 403)
  const body = (await response.json()) as ErrorBody
  assert.equal(body.error.code, 'ACCESS_DENIED')
})

test("a parent without the grant cannot download another child's document", async () => {
  const response = await parent.fetch(contentPath(schoolA, studentA, documentA))
  assert.equal(response.status, 403)
  const body = (await response.json()) as ErrorBody
  assert.equal(body.error.code, 'ACCESS_DENIED')
})

test('a document whose bytes are missing is not found and writes no audit row', async () => {
  const response = await owner.fetch(contentPath(schoolA, studentA, missingBytesDocument))
  assert.equal(response.status, 404)
  const body = (await response.json()) as ErrorBody
  assert.equal(body.error.code, 'RESOURCE_NOT_FOUND')
  assert.equal(await auditCountFor(missingBytesDocument), 0)
})

test('a malformed document id answers like a missing record', async () => {
  const response = await owner.fetch(contentPath(schoolA, studentA, 'not-a-uuid'))
  assert.equal(response.status, 404)
})

test('every shape of malformed id gets the same answer', async () => {
  // A value outside the identifier charset must not answer differently from a
  // well-formed but non-uuid one, or the two codes would say something.
  const response = await owner.fetch(
    contentPath(schoolA, studentA, encodeURIComponent('not a"uuid')),
  )
  assert.equal(response.status, 404)
  const body = (await response.json()) as ErrorBody
  assert.equal(body.error.code, 'RESOURCE_NOT_FOUND')
})

test('an anonymous caller cannot read an export job', async () => {
  const jobId = await insertJob({
    membershipId: ownerMembership,
    accessVersion: ownerAccessVersion,
    permission: 'students.export',
  })
  const response = await server.fetch(`/api/schools/${schoolA}/exports/${jobId}`)
  assert.equal(response.status, 401)
})

test('the requester reads the status of their own job', async () => {
  const jobId = await insertJob({
    membershipId: ownerMembership,
    accessVersion: ownerAccessVersion,
    permission: 'students.export',
  })
  const response = await owner.fetch(`/api/schools/${schoolA}/exports/${jobId}`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as Record<string, unknown>
  assert.deepEqual(body, { id: jobId, status: 'ready' })
})

test("another member's job is not found", async () => {
  const jobId = await insertJob({
    membershipId: adultMembership,
    accessVersion: 1,
    permission: 'students.export',
  })
  const response = await owner.fetch(`/api/schools/${schoolA}/exports/${jobId}`)
  assert.equal(response.status, 404)
  const body = (await response.json()) as ErrorBody
  assert.equal(body.error.code, 'RESOURCE_NOT_FOUND')
})

test('a job made under an older access version has expired', async () => {
  const jobId = await insertJob({
    membershipId: ownerMembership,
    accessVersion: ownerAccessVersion + 1,
    permission: 'students.export',
  })
  const response = await owner.fetch(`/api/schools/${schoolA}/exports/${jobId}`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { id: jobId, status: 'expired' })
  const stored = await adminPool().query<{ status: string }>(
    'SELECT status FROM export_jobs WHERE id = $1',
    [jobId],
  )
  assert.equal(stored.rows[0]?.status, 'expired')
})

test('a job that has aged out has expired', async () => {
  const jobId = await insertJob({
    membershipId: ownerMembership,
    accessVersion: ownerAccessVersion,
    permission: 'students.export',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  })
  const response = await owner.fetch(`/api/schools/${schoolA}/exports/${jobId}`)
  assert.deepEqual(await response.json(), { id: jobId, status: 'expired' })
})

test('a job whose permission the caller lacks has expired, not refused', async () => {
  const jobId = await insertJob({
    membershipId: ownerMembership,
    accessVersion: ownerAccessVersion,
    permission: 'not.a.permission',
  })
  const response = await owner.fetch(`/api/schools/${schoolA}/exports/${jobId}`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { id: jobId, status: 'expired' })
})

test('an export job cannot be read through another school path', async () => {
  const jobId = await insertJob({
    membershipId: ownerMembership,
    accessVersion: ownerAccessVersion,
    permission: 'students.export',
  })
  const response = await owner.fetch(`/api/schools/${schoolB}/exports/${jobId}`)
  assert.equal(response.status, 403)
  const body = (await response.json()) as ErrorBody
  assert.equal(body.error.code, 'SCHOOL_ACCESS_UNAVAILABLE')
})

test('a member who may export their timetable but not students gets an expired job', async () => {
  // The student reads their own timetable, so they pass the floor the route
  // applies before it reads a row. The job's own permission is decided again
  // straight after, and students.export is not theirs, so the job expires
  // instead of handing over a file.
  const jobId = await insertJob({
    membershipId: adultMembership,
    accessVersion: ownerAccessVersion,
    permission: 'students.export',
  })
  const response = await adult.fetch(`/api/schools/${schoolA}/exports/${jobId}`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { id: jobId, status: 'expired' })
  const stored = await adminPool().query<{ status: string }>(
    'SELECT status FROM export_jobs WHERE id = $1',
    [jobId],
  )
  assert.equal(stored.rows[0]?.status, 'expired')
})

test('a failed job stays failed instead of being rewritten as expired', async () => {
  const jobId = await insertJob({
    membershipId: ownerMembership,
    accessVersion: ownerAccessVersion + 1,
    permission: 'students.export',
    status: 'failed',
  })
  const response = await owner.fetch(`/api/schools/${schoolA}/exports/${jobId}`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { id: jobId, status: 'failed' })
  const stored = await adminPool().query<{ status: string }>(
    'SELECT status FROM export_jobs WHERE id = $1',
    [jobId],
  )
  assert.equal(stored.rows[0]?.status, 'failed')
})

test('the requester downloads their own spreadsheet and it is audited once', async () => {
  const jobId = await insertJobWithFile({
    membershipId: ownerMembership,
    accessVersion: ownerAccessVersion,
    permission: 'students.export',
    kind: 'students',
    contentType: XLSX_TYPE,
    fileName: 'Students 07 Apr 2026.xlsx',
  })
  const response = await owner.fetch(`/api/schools/${schoolA}/exports/${jobId}/file`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), XLSX_TYPE)
  assert.equal(
    response.headers.get('content-disposition'),
    'attachment; filename="Students 07 Apr 2026.xlsx"',
  )
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...BYTES])
  assert.equal(await exportAuditCount(jobId), 1)

  const audit = await adminPool().query<{
    action: string
    summary: string
    safe_changes: Record<string, unknown>
  }>(
    `SELECT action, summary, safe_changes FROM audit_events
      WHERE school_id = $1 AND target_id = $2`,
    [schoolA, jobId],
  )
  assert.equal(audit.rows[0]?.action, 'students.export')
  assert.equal(audit.rows[0]?.summary, 'Downloaded an export file')
  // The key the bytes sit under is server state: it is in no header, no body
  // and no audit row.
  const stored = await adminPool().query<{ storage_key: string }>(
    'SELECT storage_key FROM export_jobs WHERE id = $1',
    [jobId],
  )
  const key = stored.rows[0]?.storage_key as string
  assert.ok(key.length > 0)
  assert.ok(!JSON.stringify(audit.rows[0]?.safe_changes ?? {}).includes(key))
  assert.ok(![...response.headers].some(([, value]) => value.includes(key)))
})

test('the requester downloads their own document', async () => {
  const jobId = await insertJobWithFile({
    membershipId: ownerMembership,
    accessVersion: ownerAccessVersion,
    permission: 'students.export',
    kind: 'student_profile',
    contentType: 'application/pdf',
    fileName: 'student-2026-4001-2026-04-07.pdf',
    // A job that names one record: the download decides that record again, so
    // the criteria has to name a student this owner may still export.
    criteria: { studentId: studentA },
  })
  const status = await owner.fetch(`/api/schools/${schoolA}/exports/${jobId}`)
  assert.deepEqual(await status.json(), {
    id: jobId,
    status: 'ready',
    fileName: 'student-2026-4001-2026-04-07.pdf',
    format: 'pdf',
  })
  const response = await owner.fetch(`/api/schools/${schoolA}/exports/${jobId}/file`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/pdf')
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...BYTES])
  assert.equal(await exportAuditCount(jobId), 1)
})

test("another member's export file is not found and is not audited", async () => {
  const jobId = await insertJobWithFile({
    membershipId: adultMembership,
    accessVersion: 1,
    permission: 'students.export',
    kind: 'students',
    contentType: XLSX_TYPE,
    fileName: 'Students.xlsx',
  })
  const response = await owner.fetch(`/api/schools/${schoolA}/exports/${jobId}/file`)
  assert.equal(response.status, 404)
  assert.equal(((await response.json()) as ErrorBody).error.code, 'RESOURCE_NOT_FOUND')
  assert.equal(await exportAuditCount(jobId), 0)
})

test('a file made before an access change is refused and the job is marked expired', async () => {
  const jobId = await insertJobWithFile({
    membershipId: ownerMembership,
    accessVersion: ownerAccessVersion + 1,
    permission: 'students.export',
    kind: 'students',
    contentType: XLSX_TYPE,
    fileName: 'Students.xlsx',
  })
  const response = await owner.fetch(`/api/schools/${schoolA}/exports/${jobId}/file`)
  assert.equal(response.status, 404)
  assert.equal(((await response.json()) as ErrorBody).error.code, 'RESOURCE_NOT_FOUND')
  const stored = await adminPool().query<{ status: string }>(
    'SELECT status FROM export_jobs WHERE id = $1',
    [jobId],
  )
  assert.equal(stored.rows[0]?.status, 'expired')
  assert.equal(await exportAuditCount(jobId), 0)
})

test('a file whose job has aged out is refused', async () => {
  const jobId = await insertJobWithFile({
    membershipId: ownerMembership,
    accessVersion: ownerAccessVersion,
    permission: 'students.export',
    kind: 'students',
    contentType: XLSX_TYPE,
    fileName: 'Students.xlsx',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  })
  const response = await owner.fetch(`/api/schools/${schoolA}/exports/${jobId}/file`)
  assert.equal(response.status, 404)
  assert.equal(await exportAuditCount(jobId), 0)
})

test('a queued or failed job has no file to download', async () => {
  for (const status of ['queued', 'failed']) {
    const jobId = await insertJobWithFile({
      membershipId: ownerMembership,
      accessVersion: ownerAccessVersion,
      permission: 'students.export',
      kind: 'students',
      contentType: XLSX_TYPE,
      fileName: 'Students.xlsx',
      status,
    })
    const response = await owner.fetch(`/api/schools/${schoolA}/exports/${jobId}/file`)
    assert.equal(response.status, 404, status)
    assert.equal(((await response.json()) as ErrorBody).error.code, 'RESOURCE_NOT_FOUND')
    assert.equal(await exportAuditCount(jobId), 0)
  }
})

test("a school B job id through school A's path is not found", async () => {
  const jobId = randomUUID()
  insertedJobs.push(jobId)
  await adminPool().query(
    `INSERT INTO export_jobs
       (id, school_id, requested_by_membership_id, kind, status, access_version, permission, expires_at)
     VALUES ($1, $2, $3, 'students', 'ready', 1, 'students.export', now() + interval '1 hour')`,
    [jobId, schoolB, fixtureIds.ownerB as string],
  )
  const response = await owner.fetch(`/api/schools/${schoolA}/exports/${jobId}`)
  assert.equal(response.status, 404)
  const body = (await response.json()) as ErrorBody
  assert.equal(body.error.code, 'RESOURCE_NOT_FOUND')
})

// Kept last: granting a permission bumps the school's access version, which
// retires every session signed in before it.
test('a scoped download grant reaches only the caller\'s own child', async () => {
  // With the grant the aggregate gate passes, so this is the only case that
  // exercises the per-record decision: the same member, the same permission,
  // one document allowed and one not.
  const pool = adminPool()
  await pool.query(
    `INSERT INTO role_permissions(school_id, role_id, permission, scope)
     SELECT $1, id, 'students.download_documents', 'own_children' FROM roles
      WHERE school_id = $1 AND key = 'parent'`,
    [schoolA],
  )
  try {
    // The permission is privileged, so the session must carry a second factor.
    const scoped = await signInWithMfa(server, {
      userId: parentUserId,
      email: PARENT_EMAIL,
      password: PASSWORD,
    })

    const allowed = await scoped.fetch(
      contentPath(schoolA, fixtureIds.studentA2 as string, ownChildDocument),
    )
    assert.equal(allowed.status, 200)
    // The stored name carries header terminators; the header must not.
    assert.equal(allowed.headers.get('content-disposition'), 'attachment; filename="ownx.pdf"')
    assert.deepEqual([...new Uint8Array(await allowed.arrayBuffer())], [...BYTES])

    const before_ = await auditCountFor(documentA)
    const refused = await scoped.fetch(contentPath(schoolA, studentA, documentA))
    // A real document outside the caller's scope must be indistinguishable
    // from an id that does not exist.
    assert.equal(refused.status, 404)
    const body = (await refused.json()) as ErrorBody
    assert.equal(body.error.code, 'RESOURCE_NOT_FOUND')
    assert.equal(await auditCountFor(documentA), before_)
  } finally {
    await pool.query(
      `DELETE FROM role_permissions
        WHERE school_id = $1 AND permission = 'students.download_documents'`,
      [schoolA],
    )
  }
})
