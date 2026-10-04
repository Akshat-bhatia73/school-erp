import test from 'node:test'
import assert from 'node:assert/strict'
import * as c from '../src/index.ts'

const grantsOf = (role) =>
  c.ROLE_TEMPLATES[role].grants
    .filter((g) => g.permission.startsWith('homework.'))
    .map((g) => `${g.permission}:${g.scope}`)
    .sort()

test('homework grants are exactly the table in the plan', () => {
  const office = ['homework.check:school', 'homework.export:school', 'homework.read:school', 'homework.set:school']
  for (const role of ['owner', 'principal', 'admin']) assert.deepEqual(grantsOf(role), office, role)
  assert.deepEqual(grantsOf('teacher'), [
    'homework.check:assigned_sections',
    'homework.check:assigned_subjects',
    'homework.read:assigned_sections',
    'homework.read:assigned_subjects',
    'homework.set:assigned_sections',
    'homework.set:assigned_subjects',
  ])
  assert.deepEqual(grantsOf('parent'), ['homework.read:own_children'])
  assert.deepEqual(grantsOf('student'), ['homework.read:own_record'])
  assert.deepEqual(grantsOf('accountant'), [])
  for (const key of ['homework.read', 'homework.set', 'homework.check', 'homework.export'])
    assert.equal(c.PERMISSION_CATALOGUE[key].resourceType, 'homework', key)
  // A single-factor teacher sets and checks; only the school scope needs the second step.
  assert.deepEqual(c.PERMISSION_CATALOGUE['homework.set'].privilegedScopes, ['school'])
  assert.deepEqual(c.PERMISSION_CATALOGUE['homework.check'].privilegedScopes, ['school'])
  assert.deepEqual(c.PERMISSION_CATALOGUE['homework.read'].privilegedScopes, [])
})

test('setting homework: words within limits, general or one subject, never the set day from the browser', () => {
  const base = { sectionId: 'section-1', title: 'Exercise 4.2', dueOn: '2026-10-06' }
  assert.equal(c.HomeworkCreateRequest.safeParse(base).success, true)
  assert.equal(c.HomeworkCreateRequest.safeParse({ ...base, subjectId: null }).success, true)
  assert.equal(c.HomeworkCreateRequest.safeParse({ ...base, subjectId: 'maths' }).success, true)
  assert.equal(c.HomeworkCreateRequest.safeParse({ ...base, title: 'x'.repeat(121) }).success, false)
  assert.equal(c.HomeworkCreateRequest.safeParse({ ...base, instructions: 'x'.repeat(4001) }).success, false)
  assert.equal(c.HomeworkCreateRequest.safeParse({ ...base, setOn: '2026-10-01' }).success, false)
  // Edit never moves the item to another class or subject.
  assert.equal(c.HomeworkUpdateRequest.safeParse({ expectedVersion: 1, sectionId: 'section-2' }).success, false)
  assert.equal(c.HomeworkUpdateRequest.safeParse({ expectedVersion: 1, subjectId: 'science' }).success, false)
  assert.equal(c.HomeworkUpdateRequest.safeParse({ expectedVersion: 1 }).success, false)
  assert.equal(c.HomeworkUpdateRequest.safeParse({ expectedVersion: 1, dueOn: '2026-10-07' }).success, true)
})

test('check-offs: three statuses, a short remark, each pupil once', () => {
  const line = { studentId: 'pupil-1', status: 'done', expectedVersion: 0 }
  assert.equal(c.HomeworkCheckSaveRequest.safeParse({ entries: [line] }).success, true)
  assert.equal(c.HomeworkCheckSaveRequest.safeParse({ entries: [{ ...line, status: 'not_checked' }] }).success, false)
  assert.equal(c.HomeworkCheckSaveRequest.safeParse({ entries: [{ ...line, remark: 'x'.repeat(201) }] }).success, false)
  assert.equal(c.HomeworkCheckSaveRequest.safeParse({ entries: [{ ...line, remark: null }] }).success, true)
  assert.equal(c.HomeworkCheckSaveRequest.safeParse({ entries: [line, line] }).success, false)
  assert.equal(c.HomeworkCheckSaveRequest.safeParse({ entries: [] }).success, false)
})

test('the report covers at most a year and the list refuses contradictory filters', () => {
  assert.equal(c.HomeworkReportRequest.safeParse({ from: '2026-04-01', to: '2027-03-31' }).success, true)
  assert.equal(c.HomeworkReportRequest.safeParse({ from: '2026-04-01', to: '2027-04-03' }).success, false)
  assert.equal(c.HomeworkReportRequest.safeParse({ from: '2026-10-02', to: '2026-10-01' }).success, false)
  assert.equal(c.HomeworkListRequest.safeParse({ subjectId: 'maths', general: 'true' }).success, false)
  assert.equal(c.HomeworkListRequest.safeParse({ status: 'to_check', sectionId: 'section-1' }).success, true)
})

test('the digest is an automatic kind with its own wording and a time from noon to nine', () => {
  assert.ok(c.AUTOMATIC_MESSAGE_KINDS.includes('homework_digest'))
  const wording = c.DEFAULT_MESSAGE_WORDING.homework_digest
  assert.deepEqual(c.unknownPlaceholders(wording.title, 'homework_digest'), [])
  assert.deepEqual(c.unknownPlaceholders(wording.body, 'homework_digest'), [])
  assert.equal(c.DEFAULT_COMMUNICATION_SETTINGS.homeworkDigestEnabled, true)
  assert.equal(c.DEFAULT_COMMUNICATION_SETTINGS.homeworkDigestTime, '17:00')
  for (const time of ['12:00', '17:00', '20:59', '21:00']) assert.equal(c.HomeworkDigestTime.safeParse(time).success, true, time)
  for (const time of ['11:59', '21:01', '22:00', '5:00', '17:0']) assert.equal(c.HomeworkDigestTime.safeParse(time).success, false, time)
})

test('files: three per item, 4 MB each, PDF, JPEG or PNG', () => {
  assert.equal(c.HOMEWORK_ATTACHMENTS_MAX, 3)
  assert.equal(c.HOMEWORK_ATTACHMENT_MAX_BYTES, 4 * 1024 * 1024)
  const view = { id: 'file-1', fileName: 'sheet.pdf', contentType: 'application/pdf', sizeBytes: 4 * 1024 * 1024 }
  assert.equal(c.HomeworkAttachmentView.safeParse(view).success, true)
  assert.equal(c.HomeworkAttachmentView.safeParse({ ...view, sizeBytes: 4 * 1024 * 1024 + 1 }).success, false)
  assert.equal(c.HomeworkAttachmentView.safeParse({ ...view, contentType: 'image/gif' }).success, false)
})
