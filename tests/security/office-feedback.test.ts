/**
 * Matrix rows: photo-record-scope, identifier-field-masking, identifier-never-whole.
 *
 * The office feedback work added two new kinds of personal data: photographs,
 * which are bytes in the private store behind a streaming route, and the
 * Aadhaar and PAN numbers, which are sealed and only ever shown as their last
 * digits. This file asks the adversarial questions about both: who may fetch
 * a picture, who may replace one, and whether a number that was typed in once
 * can be found again through a detail read, a list, a search, an export file,
 * a PDF or an audit row.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { deflateSync, inflateRawSync, inflateSync } from 'node:zlib'
import test, { after, before } from 'node:test'
import { isVerhoeffValid } from '@erp/contracts'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
  startTestServer,
  type TestServer,
} from '../../apps/api/tests/harness.ts'
import {
  body,
  codeOf,
  createEnrolledStudent,
  createMember,
  createTeacher,
  ensureSection,
  ensureSubject,
  forgetTwoFactor,
  grantPortalAccess,
  postBody,
  signInMember,
  signInOffice,
  writeExceptionRule,
  type Client,
  type Member,
} from './support.ts'

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const studentB = fixtureIds.studentB as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string

const suffix = randomUUID().slice(0, 8)

/** A twelve digit number this run owns, ending in the check digit Aadhaar wants. */
function makeAadhaar(): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const base = String(2 + Math.floor(Math.random() * 8)) +
      String(Math.floor(Math.random() * 1e10)).padStart(10, '0')
    for (let digit = 0; digit <= 9; digit += 1) {
      const candidate = `${base}${digit}`
      if (isVerhoeffValid(candidate)) return candidate
    }
  }
  throw new Error('no valid Aadhaar could be built')
}

/** The numbers this suite types in once and then hunts for everywhere. */
const SECRET = {
  studentAadhaar: makeAadhaar(),
  guardianAadhaar: makeAadhaar(),
  guardianPan: `ABCDE${String(1000 + Math.floor(Math.random() * 8999))}Z`,
  officeAddress: `Office block ${suffix}, second floor`,
}

/** Everything a response, a file or an audit row must never contain whole. */
const WHOLE_VALUES = [SECRET.studentAadhaar, SECRET.guardianAadhaar, SECRET.guardianPan]

const studentLast4 = SECRET.studentAadhaar.slice(-4)
const guardianPanLast4 = SECRET.guardianPan.slice(-4)

/** A PNG chunk: length, type, data, and a checksum the reader does not verify. */
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, data, Buffer.alloc(4)])
}

/** A tiny but structurally real one pixel PNG, the picture every upload sends. */
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
    pngChunk('IDAT', deflateSync(Buffer.from([0x00, 0x00]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const PICTURE = png()

function photoBody(method: 'PUT'): RequestInit {
  return {
    method,
    headers: { 'content-type': 'image/png' },
    body: new Uint8Array(PICTURE),
  }
}

/**
 * The words a spreadsheet really holds. An .xlsx file is a zip of packed XML,
 * so each member is unpacked before the search; anything unreadable is left as
 * it stands so nothing is quietly skipped.
 */
function xlsxText(bytes: Buffer): string {
  const parts: string[] = [bytes.toString('latin1')]
  let at = 0
  while (at >= 0 && at + 30 <= bytes.length) {
    const found = bytes.indexOf('PK\u0003\u0004', at, 'latin1')
    if (found < 0 || found + 30 > bytes.length) break
    const method = bytes.readUInt16LE(found + 8)
    const packed = bytes.readUInt32LE(found + 18)
    const nameLength = bytes.readUInt16LE(found + 26)
    const extraLength = bytes.readUInt16LE(found + 28)
    const start = found + 30 + nameLength + extraLength
    if (packed > 0 && start + packed <= bytes.length) {
      const member = bytes.subarray(start, start + packed)
      try {
        parts.push(method === 0 ? member.toString('latin1') : inflateRawSync(member).toString('latin1'))
      } catch {
        // A member this reader cannot unpack; the raw copy above still covers it.
      }
    }
    at = found + 4
  }
  return parts.join('\n')
}

let server: TestServer
let owner: Member
let ownerClient: Client
let masked: Member
let maskedClient: Client
let accountant: Member
let accountantClient: Client
let teacher: Awaited<ReturnType<typeof createTeacher>>
let teacherClient: Client
let parent: Member
let parentClient: Client

let ownSection = ''
let otherSection = ''
let pupilId = ''
let pupilVersion = 0
let otherPupilId = ''
let childId = ''
let guardianId = ''
let colleagueStaffId = ''
let colleagueStaffVersion = 0

interface StudentBasic { id: string; version: number; hasPhoto: boolean }
interface Page<T> { items: T[]; total: number }
interface Job { id: string; status: string; format?: string }

/** The student's current row version, which every write has to name. */
async function studentVersion(id: string): Promise<number> {
  const found = await adminPool().query<{ version: number }>(
    'SELECT version FROM students WHERE id = $1',
    [id],
  )
  return Number(found.rows[0]?.version)
}

async function staffVersion(id: string): Promise<number> {
  const found = await adminPool().query<{ version: number }>(
    'SELECT version FROM staff WHERE id = $1',
    [id],
  )
  return Number(found.rows[0]?.version)
}

/** Download a finished export job and hand back its bytes. */
async function exportedBytes(client: Client, path: string, request: unknown): Promise<Buffer> {
  const requested = await client.fetch(path, postBody(request))
  assert.equal(requested.status, 202, `${path} was accepted`)
  const job = await body<Job>(requested)
  assert.equal(job.status, 'ready')
  const file = await client.fetch(`/api/schools/${schoolA}/exports/${job.id}/file`)
  assert.equal(file.status, 200)
  return Buffer.from(await file.arrayBuffer())
}

/**
 * The words a PDF really shows. Its page content is compressed, so reading the
 * file as text would find neither the masked ending nor a leaked number: every
 * stream is unpacked first, and what cannot be unpacked is kept as it stands.
 */
function pdfText(bytes: Buffer): string {
  const raw = bytes.toString('latin1')
  const parts: string[] = [raw]
  const pattern = /stream\r?\n/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    const start = match.index + match[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) break
    const chunk = Buffer.from(raw.slice(start, end), 'latin1')
    try {
      parts.push(inflateSync(chunk).toString('latin1'))
    } catch {
      // Not a packed stream: the raw copy above already covers it.
    }
  }
  return parts.join('\n')
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()

  const subjectId = await ensureSubject(schoolA, `OFF-SUB-${suffix}`)
  ownSection = await ensureSection(schoolA, yearA, gradeA, `OFF-1-${suffix}`)
  otherSection = await ensureSection(schoolA, yearA, gradeA, `OFF-2-${suffix}`)

  owner = await createMember(schoolA, ['owner'], 'Office Owner')
  ownerClient = await signInOffice(server, owner)

  // An office member who may read the whole roster and export it, and holds
  // neither of the two keys that open the identity numbers. The exception
  // catalogue does not take a deny on those keys, so the widest caller without
  // them is built the other way round: a role that never had them, opened up
  // to the whole school for the reads an export needs.
  masked = await createMember(schoolA, ['accountant'], 'Office Masked')
  for (const permission of ['students.read_basic', 'students.export']) {
    await writeExceptionRule({
      schoolId: schoolA,
      membershipId: masked.membershipId,
      permission,
      effect: 'allow',
      targetType: 'school',
      authorMembershipId: owner.membershipId,
    })
  }
  maskedClient = await signInOffice(server, masked)

  accountant = await createMember(schoolA, ['accountant'], 'Office Accountant')
  accountantClient = await signInOffice(server, accountant)

  teacher = await createTeacher({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionIds: [ownSection],
    subjectId,
    employeeCode: `OFF-T-${suffix}`,
  })
  teacherClient = await signInMember(server, teacher)

  // A colleague of the teacher, whose picture the teacher has no key for.
  colleagueStaffId = randomUUID()
  await adminPool().query(
    `INSERT INTO staff (id, school_id, employee_code, first_name, staff_type, designation, status)
     VALUES ($1, $2, $3, 'Office Colleague', 'teaching', 'Teacher', 'active')`,
    [colleagueStaffId, schoolA, `OFF-C-${suffix}`],
  )

  otherPupilId = await createEnrolledStudent({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionId: otherSection,
    firstName: 'Office Other',
    admissionNumber: `OFF/${suffix}/2`,
    rollNumber: 2,
  })
  childId = await createEnrolledStudent({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionId: otherSection,
    firstName: 'Office Child',
    admissionNumber: `OFF/${suffix}/3`,
    rollNumber: 3,
  })
  parent = await createMember(schoolA, ['parent'], 'Office Parent')
  await grantPortalAccess({
    schoolId: schoolA,
    membershipId: parent.membershipId,
    studentId: childId,
    approvedBy: owner.membershipId,
  })
  parentClient = await signInMember(server, parent)
})

after(async () => {
  await forgetTwoFactor([owner.userId, masked.userId, accountant.userId])
  await server.close()
  await closeAdminPool()
})

test('[identifier-never-whole] admission takes the whole numbers and answers with none of them', async () => {
  const admitted = await ownerClient.fetch(
    `/api/schools/${schoolA}/students`,
    postBody({
      firstName: 'Office',
      lastName: 'Pupil',
      dateOfBirth: '2015-06-01',
      gender: 'female',
      admissionDate: '2026-04-01',
      // Typed the way an office types it, in groups of four.
      aadhaar: `${SECRET.studentAadhaar.slice(0, 4)} ${SECRET.studentAadhaar.slice(4, 8)} ${SECRET.studentAadhaar.slice(8)}`,
      sectionId: ownSection,
      rollNumber: 1,
      guardians: [
        {
          guardian: {
            firstName: 'Office',
            lastName: 'Parent',
            phone: `+919${String(Math.floor(100000000 + Math.random() * 899999999))}`,
            occupation: 'Engineer',
            officeAddress: SECRET.officeAddress,
            pan: SECRET.guardianPan,
            aadhaar: SECRET.guardianAadhaar,
          },
          relation: 'mother',
          isPrimary: true,
        },
      ],
      consents: [{ guardianIndex: 0, purpose: 'photographs', method: 'signed_form' }],
    }),
  )
  assert.equal(admitted.status, 201)
  const created = await body<StudentBasic>(admitted)
  pupilId = created.id
  pupilVersion = created.version

  // The record kept the last four digits and nothing more.
  const stored = await adminPool().query<{ aadhaar_last4: string | null }>(
    'SELECT aadhaar_last4 FROM students WHERE id = $1',
    [pupilId],
  )
  assert.equal(stored.rows[0]?.aadhaar_last4, studentLast4)

  // The sealed column never holds the plain number.
  const sealed = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM students
      WHERE id = $1 AND aadhaar_ciphertext LIKE '%' || $2 || '%'`,
    [pupilId, SECRET.studentAadhaar],
  )
  assert.equal(sealed.rows[0]?.count, '0')

  const guardians = await ownerClient.fetch(
    `/api/schools/${schoolA}/students/${pupilId}/guardians`,
  )
  assert.equal(guardians.status, 200)
  const guardianText = await guardians.text()
  // The positive control: the office really does see the masked forms.
  assert.ok(guardianText.includes(guardianPanLast4), 'the office sees the PAN ending')
  assert.ok(guardianText.includes(SECRET.officeAddress), 'the office sees the office address')
  for (const value of WHOLE_VALUES) {
    assert.equal(guardianText.includes(value), false, `the guardian read leaked ${value}`)
  }
  const guardianRow = await adminPool().query<{ id: string }>(
    `SELECT g.id FROM guardians g
       JOIN student_guardians sg ON sg.guardian_id = g.id
      WHERE sg.student_id = $1 LIMIT 1`,
    [pupilId],
  )
  guardianId = guardianRow.rows[0]?.id as string
  assert.ok(guardianId, 'the guardian was created')
})

test('[identifier-never-whole] no response, export file, PDF or audit row carries a whole number', async () => {
  // Every channel the office itself can reach, which is the widest reader there is.
  const detail = await ownerClient.fetch(`/api/schools/${schoolA}/students/${pupilId}`)
  assert.equal(detail.status, 200)
  const detailText = await detail.text()
  assert.ok(detailText.includes(studentLast4), 'the office sees the Aadhaar ending')

  const list = await ownerClient.fetch(`/api/schools/${schoolA}/students?sectionId=${ownSection}`)
  const search = await ownerClient.fetch(`/api/schools/${schoolA}/search?q=Office%20Pupil`)
  const subject = await ownerClient.fetch(
    `/api/schools/${schoolA}/students/${pupilId}/subject-access`,
  )
  const texts: Record<string, string> = {
    detail: detailText,
    list: await list.text(),
    search: await search.text(),
    subject: await subject.text(),
    studentsExport: xlsxText(await exportedBytes(
      ownerClient,
      `/api/schools/${schoolA}/students/export`,
      { studentIds: [pupilId] },
    )),
    profilePdf: pdfText(await exportedBytes(
      ownerClient,
      `/api/schools/${schoolA}/students/${pupilId}/export-profile`,
      {},
    )),
  }
  // The PDF draws its words with a cut-down font, so the letters on the page
  // are glyph numbers and no phrase can be looked up in the file. The scan
  // below is therefore a byte-level one: it proves the file carries no copy of
  // a whole number in its streams, its title or its metadata. That the page
  // prints the masked ending is checked where the document is built.

  for (const [label, text] of Object.entries(texts)) {
    for (const value of WHOLE_VALUES) {
      // The one deliberate exception: a subject access export is the answer to
      // the person the record is about, so their own Aadhaar number is whole
      // in that file. A guardian is a different person and stays masked.
      if (label === 'subject' && value === SECRET.studentAadhaar) continue
      assert.equal(text.includes(value), false, `${label} leaked ${value}`)
    }
  }
  assert.ok(
    texts.subject?.includes(SECRET.studentAadhaar),
    'the record the pupil is given holds their own number in full',
  )

  // The audit log, read through the route and straight from the table.
  const audit = await ownerClient.fetch(`/api/schools/${schoolA}/audit-events?pageSize=100`)
  assert.equal(audit.status, 200)
  const auditPage = await body<Page<{ action: string }>>(audit)
  assert.ok(auditPage.items.some((row) => row.action === 'students.create'), 'admission is audited')
  const auditText = JSON.stringify(auditPage)
  const rows = await adminPool().query<{ summary: string; safe_changes: unknown }>(
    `SELECT summary, safe_changes FROM audit_events WHERE school_id = $1`,
    [schoolA],
  )
  const storedAudit = JSON.stringify(rows.rows)
  for (const value of WHOLE_VALUES) {
    assert.equal(auditText.includes(value), false, `an audit row leaked ${value}`)
    assert.equal(storedAudit.includes(value), false, `a stored audit row leaked ${value}`)
  }
})

test('[identifier-field-masking] a reader without the sensitive key sees no identity field at all', async () => {
  // The positive control: this member really can read and export the record.
  const detail = await maskedClient.fetch(`/api/schools/${schoolA}/students/${pupilId}`)
  assert.equal(detail.status, 200)
  const detailText = await detail.text()
  assert.ok(detailText.includes('Office'), 'the masked office member reads the student')

  const list = await maskedClient.fetch(`/api/schools/${schoolA}/students?sectionId=${ownSection}`)
  assert.equal(list.status, 200)
  // The guardian block is a key of its own, and this caller does not hold it.
  const guardians = await maskedClient.fetch(
    `/api/schools/${schoolA}/students/${pupilId}/guardians`,
  )
  assert.ok([403, 404].includes(guardians.status), `refused, got ${guardians.status}`)

  const texts: Record<string, string> = {
    detail: detailText,
    list: await list.text(),
    guardians: await guardians.text(),
    search: await (await maskedClient.fetch(`/api/schools/${schoolA}/search?q=Office%20Pupil`)).text(),
    studentsExport: xlsxText(await exportedBytes(
      maskedClient,
      `/api/schools/${schoolA}/students/export`,
      { studentIds: [pupilId] },
    )),
    profilePdf: pdfText(await exportedBytes(
      maskedClient,
      `/api/schools/${schoolA}/students/${pupilId}/export-profile`,
      {},
    )),
  }
  for (const [label, text] of Object.entries(texts)) {
    for (const marker of ['aadhaarLast4', 'panLast4', 'officeAddress', SECRET.officeAddress]) {
      assert.equal(text.includes(marker), false, `${label} showed ${marker}`)
    }
    assert.equal(text.includes(`ending ${studentLast4}`), false, `${label} showed the ending`)
    assert.equal(text.includes(`ending ${guardianPanLast4}`), false, `${label} showed the ending`)
    for (const value of WHOLE_VALUES) {
      assert.equal(text.includes(value), false, `${label} leaked ${value}`)
    }
  }

  // The two reveal routes are the only way to the whole number, and they are
  // shut to the same caller.
  for (const path of [
    `/api/schools/${schoolA}/students/${pupilId}/aadhaar`,
    `/api/schools/${schoolA}/students/${pupilId}/guardians/${guardianId}/identity`,
  ]) {
    const response = await maskedClient.fetch(path)
    assert.ok([403, 404].includes(response.status), `${path} refused, got ${response.status}`)
  }

  // A teacher who may read the pupil has no reveal either.
  const teacherDetail = await teacherClient.fetch(`/api/schools/${schoolA}/students/${pupilId}`)
  assert.equal(teacherDetail.status, 200)
  const teacherText = await teacherDetail.text()
  for (const marker of ['aadhaarLast4', 'panLast4', ...WHOLE_VALUES]) {
    assert.equal(teacherText.includes(marker), false, `the teacher saw ${marker}`)
  }
  const reveal = await teacherClient.fetch(`/api/schools/${schoolA}/students/${pupilId}/aadhaar`)
  assert.ok([403, 404].includes(reveal.status), `the teacher is refused, got ${reveal.status}`)
})

test('[photo-record-scope] a student photograph needs the photographs consent and is served privately', async () => {
  const photoPath = `/api/schools/${schoolA}/students/${pupilId}/photo`

  // The consent given at admission is what makes this allowed at all.
  const uploaded = await ownerClient.fetch(
    `${photoPath}?expectedVersion=${pupilVersion}`,
    photoBody('PUT'),
  )
  assert.equal(uploaded.status, 204)

  const fetched = await ownerClient.fetch(photoPath)
  assert.equal(fetched.status, 200)
  assert.equal(fetched.headers.get('content-type'), 'image/png')
  // The route's own rule survives the application-wide hook: a picture is one
  // person's and is never kept by a cache.
  assert.equal(fetched.headers.get('cache-control'), 'private, no-store')
  assert.equal(fetched.headers.get('x-content-type-options'), 'nosniff')
  // The storage key is server state: it is in no header and in no body.
  for (const [, value] of fetched.headers) {
    assert.equal(value.includes('photos/'), false, 'a header named the storage key')
  }
  assert.ok((await fetched.arrayBuffer()).byteLength > 0)

  // The record now says so, and still never names the key.
  const detail = await ownerClient.fetch(`/api/schools/${schoolA}/students/${pupilId}`)
  const detailText = await detail.text()
  assert.ok(detailText.includes('"hasPhoto":true'))
  assert.equal(detailText.includes('photos/'), false)

  // Withdrawing the consent takes the picture away in the same breath.
  const withdrawn = await ownerClient.fetch(
    `/api/schools/${schoolA}/students/${pupilId}/consents`,
    postBody({
      guardianId,
      purpose: 'photographs',
      status: 'withdrawn',
      method: 'signed_form',
    }),
  )
  assert.equal(withdrawn.status, 200)
  const gone = await ownerClient.fetch(photoPath)
  assert.equal(gone.status, 404)
  assert.equal(await codeOf(gone), 'RESOURCE_NOT_FOUND')

  // And a fresh upload is refused while the answer stands at withdrawn.
  const refused = await ownerClient.fetch(
    `${photoPath}?expectedVersion=${await studentVersion(pupilId)}`,
    photoBody('PUT'),
  )
  assert.equal(refused.status, 409)
  assert.equal(await codeOf(refused), 'NOT_ALLOWED_YET')

  // Given again, the office may set one again: the refusal was the consent
  // and not the route.
  const again = await ownerClient.fetch(
    `/api/schools/${schoolA}/students/${pupilId}/consents`,
    postBody({ guardianId, purpose: 'photographs', status: 'given', method: 'signed_form' }),
  )
  assert.equal(again.status, 200)
  const reuploaded = await ownerClient.fetch(
    `${photoPath}?expectedVersion=${await studentVersion(pupilId)}`,
    photoBody('PUT'),
  )
  assert.equal(reuploaded.status, 204)
})

test('[photo-record-scope] a picture that is not an image, or is too big, is refused', async () => {
  const photoPath = `/api/schools/${schoolA}/students/${pupilId}/photo`
  const version = await studentVersion(pupilId)

  for (const [label, bytes] of [
    ['a renamed program', Buffer.from('MZ\x90\0this is an exe', 'latin1')],
    ['an SVG', Buffer.from('<svg onload="alert(1)"></svg>')],
    ['two megabytes', Buffer.alloc(2 * 1024 * 1024, 0x41)],
  ] as const) {
    const response = await ownerClient.fetch(`${photoPath}?expectedVersion=${version}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array(bytes),
    })
    assert.ok([400, 413].includes(response.status), `${label} was refused, got ${response.status}`)
    // Whatever the refusal, it is our own envelope and not a closed door.
    const body = (await response.json()) as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'INVALID_REQUEST')
    if (response.status === 413) {
      assert.equal(body.error.message, 'Choose a photo smaller than 1 MB.')
    }
  }
  // Nothing about the record moved.
  assert.equal(await studentVersion(pupilId), version)
})

test('[photo-record-scope] another school answers exactly like a missing record', async () => {
  // School B in the path: the membership gate refuses before any record is read.
  for (const method of ['GET', 'PUT', 'DELETE'] as const) {
    const init = method === 'GET' ? {} : method === 'PUT' ? photoBody('PUT') : { method }
    const response = await ownerClient.fetch(
      `/api/schools/${schoolB}/students/${studentB}/photo?expectedVersion=1`,
      init,
    )
    assert.equal(response.status, 403, method)
    assert.equal(await codeOf(response), 'SCHOOL_ACCESS_UNAVAILABLE', method)
  }

  // School B's student under school A's path is simply a record that is not here.
  for (const method of ['GET', 'PUT', 'DELETE'] as const) {
    const init = method === 'GET' ? {} : method === 'PUT' ? photoBody('PUT') : { method }
    const response = await ownerClient.fetch(
      `/api/schools/${schoolA}/students/${studentB}/photo?expectedVersion=1`,
      init,
    )
    assert.equal(response.status, 404, method)
    assert.equal(await codeOf(response), 'RESOURCE_NOT_FOUND', method)
  }

  // No bytes were stored under school A for a record of school B.
  const leaked = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM students
      WHERE id = $1 AND photo_storage_key IS NOT NULL`,
    [studentB],
  )
  assert.equal(leaked.rows[0]?.count, '0')
})

test('[photo-record-scope] a teacher outside the section and a parent of another child get nothing', async () => {
  // The permitted half: the teacher teaches this pupil, so the picture is hers to see.
  const mine = await teacherClient.fetch(`/api/schools/${schoolA}/students/${pupilId}/photo`)
  assert.equal(mine.status, 200)

  // A pupil in the class next door reads exactly like a pupil who is not there.
  const theirs = await teacherClient.fetch(
    `/api/schools/${schoolA}/students/${otherPupilId}/photo`,
  )
  assert.equal(theirs.status, 404)
  assert.equal(await codeOf(theirs), 'RESOURCE_NOT_FOUND')

  // A parent may look at their own child and at nobody else's.
  const notMyChild = await parentClient.fetch(
    `/api/schools/${schoolA}/students/${pupilId}/photo`,
  )
  assert.equal(notMyChild.status, 404)
  assert.equal(await codeOf(notMyChild), 'RESOURCE_NOT_FOUND')
  // Their own child has no picture, which is the same answer: nothing about
  // another family's record is distinguishable from an empty one.
  const myChild = await parentClient.fetch(`/api/schools/${schoolA}/students/${childId}/photo`)
  assert.equal(myChild.status, 404)
})

test('[photo-record-scope] a member who may read a record cannot replace or remove its picture', async () => {
  const photoPath = `/api/schools/${schoolA}/students/${pupilId}/photo`
  const version = await studentVersion(pupilId)

  for (const [label, init] of [
    ['upload', photoBody('PUT')],
    ['remove', { method: 'DELETE' }],
  ] as const) {
    const response = await teacherClient.fetch(`${photoPath}?expectedVersion=${version}`, init)
    assert.ok([403, 404].includes(response.status), `${label} refused, got ${response.status}`)
  }
  // The picture the office put there is still the one on file.
  assert.equal(await studentVersion(pupilId), version)
  const still = await ownerClient.fetch(photoPath)
  assert.equal(still.status, 200)

  // The office may remove it, so the refusal above was about the key.
  const removed = await ownerClient.fetch(`${photoPath}?expectedVersion=${version}`, {
    method: 'DELETE',
  })
  assert.equal(removed.status, 204)
  const afterwards = await ownerClient.fetch(photoPath)
  assert.equal(afterwards.status, 404)
})

test('[photo-record-scope] a staff picture follows the staff keys, not the student ones', async () => {
  const photoPath = `/api/schools/${schoolA}/staff/${colleagueStaffId}/photo`
  colleagueStaffVersion = await staffVersion(colleagueStaffId)

  const uploaded = await ownerClient.fetch(
    `${photoPath}?expectedVersion=${colleagueStaffVersion}`,
    photoBody('PUT'),
  )
  assert.equal(uploaded.status, 204)

  // The accountant reads the whole directory, so the picture is hers to see.
  const read = await accountantClient.fetch(photoPath)
  assert.equal(read.status, 200)
  assert.ok(read.headers.get('cache-control')?.includes('no-store'), 'the picture is not cached')

  // She holds no key to change a colleague's record.
  const version = await staffVersion(colleagueStaffId)
  for (const [label, init] of [
    ['upload', photoBody('PUT')],
    ['remove', { method: 'DELETE' }],
  ] as const) {
    const response = await accountantClient.fetch(`${photoPath}?expectedVersion=${version}`, init)
    assert.ok([403, 404].includes(response.status), `${label} refused, got ${response.status}`)
  }
  assert.equal(await staffVersion(colleagueStaffId), version)

  // A teacher reads only her own staff record, so a colleague's picture is a
  // record that is not there. Her own is the positive control.
  const colleague = await teacherClient.fetch(photoPath)
  assert.ok([403, 404].includes(colleague.status), `refused, got ${colleague.status}`)
  const own = await teacherClient.fetch(
    `/api/schools/${schoolA}/staff/${teacher.staffId}/photo?expectedVersion=${await staffVersion(teacher.staffId)}`,
    photoBody('PUT'),
  )
  assert.equal(own.status, 204)

  // A parent holds no directory key at all.
  const asParent = await parentClient.fetch(photoPath)
  assert.ok([403, 404].includes(asParent.status), `refused, got ${asParent.status}`)
})

test('[photo-record-scope] every photograph write leaves one audit row and no storage key', async () => {
  const rows = await adminPool().query<{ action: string; summary: string; safe_changes: unknown }>(
    `SELECT action, summary, safe_changes FROM audit_events
      WHERE school_id = $1 AND target_id = ANY($2::uuid[])
        AND summary LIKE '%photograph%'`,
    [schoolA, [pupilId, colleagueStaffId, teacher.staffId]],
  )
  assert.ok(rows.rows.length >= 4, 'each upload and removal wrote a row')
  const text = JSON.stringify(rows.rows)
  assert.equal(text.includes('photos/'), false, 'an audit row named the storage key')
  for (const row of rows.rows) {
    assert.ok(['students.update_basic', 'staff.update_private'].includes(row.action), row.action)
  }

  // Looking at a picture is not an event: the reads above added nothing.
  const before = rows.rows.length
  await ownerClient.fetch(`/api/schools/${schoolA}/staff/${colleagueStaffId}/photo`)
  const after = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events
      WHERE school_id = $1 AND target_id = ANY($2::uuid[])
        AND summary LIKE '%photograph%'`,
    [schoolA, [pupilId, colleagueStaffId, teacher.staffId]],
  )
  assert.equal(Number(after.rows[0]?.count), before)
})

/** The fixture class's name, the way a sheet names it. */
async function gradeName(): Promise<string> {
  const found = await adminPool().query<{ name: string }>(
    'SELECT name FROM grades WHERE school_id = $1 AND id = $2',
    [schoolA, gradeA],
  )
  return found.rows[0]?.name as string
}

test('[identifier-never-whole] a teacher or a parent cannot stage a student sheet', async () => {
  const sheet = {
    academicYearId: yearA,
    rows: [
      {
        rowNumber: 1,
        firstName: 'Refused',
        dateOfBirth: '2015-06-01',
        gender: 'male',
        grade: await gradeName(),
        section: `OFF-1-${suffix}`,
        guardianPhone: '9876543210',
        guardianPan: SECRET.guardianPan,
      },
    ],
  }
  for (const [label, client] of [['teacher', teacherClient], ['parent', parentClient]] as const) {
    const response = await client.fetch(
      `/api/schools/${schoolA}/students/import/preview`,
      postBody(sheet),
    )
    assert.equal(response.status, 403, `${label} is refused`)
    assert.equal(await codeOf(response), 'ACCESS_DENIED')
  }
})

test('[identifier-field-masking] an imported guardian PAN is shown only to a guardian reader', async () => {
  // Numbers of this test's own, so a hit can only come from the imported row.
  const imported = {
    studentAadhaar: makeAadhaar(),
    guardianAadhaar: makeAadhaar(),
    guardianPan: `IMPRT${String(1000 + Math.floor(Math.random() * 8999))}Q`,
    officeAddress: `Import office ${suffix}`,
  }
  const whole = [imported.studentAadhaar, imported.guardianAadhaar, imported.guardianPan]
  const panLast4 = imported.guardianPan.slice(-4)
  const firstName = `Imported ${suffix}`

  const preview = await ownerClient.fetch(
    `/api/schools/${schoolA}/students/import/preview`,
    postBody({
      academicYearId: yearA,
      rows: [
        {
          rowNumber: 1,
          firstName,
          dateOfBirth: '2015-06-01',
          gender: 'female',
          grade: await gradeName(),
          section: `OFF-1-${suffix}`,
          motherName: 'Imported Mother',
          guardianPhone: '9876501234',
          studentAadhaar: imported.studentAadhaar,
          guardianAadhaar: imported.guardianAadhaar,
          guardianPan: imported.guardianPan,
          guardianOfficeAddress: imported.officeAddress,
        },
      ],
    }),
  )
  assert.equal(preview.status, 201)
  const staged = await body<{ id: string; version: number; validRows: number }>(preview)
  assert.equal(staged.validRows, 1)
  const committed = await ownerClient.fetch(
    `/api/schools/${schoolA}/students/import/commit`,
    postBody({ previewId: staged.id, expectedVersion: staged.version }),
  )
  assert.equal(committed.status, 201)

  const found = await adminPool().query<{ student_id: string; guardian_id: string }>(
    `SELECT s.id AS student_id, sg.guardian_id
       FROM students s
       JOIN student_guardians sg ON sg.school_id = s.school_id AND sg.student_id = s.id
      WHERE s.school_id = $1 AND s.first_name = $2`,
    [schoolA, firstName],
  )
  const importedId = found.rows[0]?.student_id as string
  const importedGuardian = found.rows[0]?.guardian_id as string
  assert.ok(importedId && importedGuardian, 'the sheet admitted the pupil and the guardian')

  // The positive control: the office, which holds the guardian key, sees the ending.
  const officeGuardians = await ownerClient.fetch(
    `/api/schools/${schoolA}/students/${importedId}/guardians`,
  )
  assert.equal(officeGuardians.status, 200)
  const officeText = await officeGuardians.text()
  assert.ok(officeText.includes(`"panLast4":"${panLast4}"`), 'the office sees the PAN ending')
  for (const value of whole) {
    assert.equal(officeText.includes(value), false, `the office guardian read leaked ${value}`)
  }

  // The masked office member reads and exports the pupil but holds no guardian key.
  const detail = await maskedClient.fetch(`/api/schools/${schoolA}/students/${importedId}`)
  assert.equal(detail.status, 200)
  const guardians = await maskedClient.fetch(
    `/api/schools/${schoolA}/students/${importedId}/guardians`,
  )
  assert.ok([403, 404].includes(guardians.status), `refused, got ${guardians.status}`)
  const reveal = await maskedClient.fetch(
    `/api/schools/${schoolA}/students/${importedId}/guardians/${importedGuardian}/identity`,
  )
  assert.ok([403, 404].includes(reveal.status), `reveal refused, got ${reveal.status}`)

  const texts: Record<string, string> = {
    detail: await detail.text(),
    guardians: await guardians.text(),
    reveal: await reveal.text(),
    studentsExport: xlsxText(await exportedBytes(
      maskedClient,
      `/api/schools/${schoolA}/students/export`,
      { studentIds: [importedId] },
    )),
  }
  for (const [label, text] of Object.entries(texts)) {
    for (const marker of ['panLast4', 'aadhaarLast4', 'officeAddress', imported.officeAddress]) {
      assert.equal(text.includes(marker), false, `${label} showed ${marker}`)
    }
    assert.equal(text.includes(`ending ${panLast4}`), false, `${label} showed the PAN ending`)
    for (const value of whole) {
      assert.equal(text.includes(value), false, `${label} leaked ${value}`)
    }
  }

  // Neither import audit row carries a number.
  const audit = await adminPool().query<{ summary: string; safe_changes: unknown }>(
    `SELECT summary, safe_changes FROM audit_events
      WHERE school_id = $1 AND action = 'students.import' AND target_id = $2`,
    [schoolA, staged.id],
  )
  assert.equal(audit.rowCount, 2)
  const auditText = JSON.stringify(audit.rows)
  for (const value of [...whole, imported.officeAddress]) {
    assert.equal(auditText.includes(value), false, `an import audit row holds ${value}`)
  }
})
