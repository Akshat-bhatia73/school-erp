import test from 'node:test'
import assert from 'node:assert/strict'
import * as c from '../src/index.ts'

const student = { id: 'student-1', schoolId: 'school-1', version: 1, firstName: 'Meera', admissionNumber: '2026/1', status: 'active', anonymised: false, hasPhoto: false }
const staff = { id: 'staff-1', schoolId: 'school-1', version: 1, displayName: 'Meera', designation: 'Teacher', anonymised: false, hasPhoto: false }
const invite = { displayName: 'Meera', identifier: { kind: 'email', value: 'meera@example.org' }, roleKeys: ['teacher'], staffId: 'staff-1' }
const rule = {
  id: 'rule-1', schoolId: 'school-1', membershipId: 'member-1', permission: 'students.read_basic',
  effect: 'allow', target: { kind: 'student', studentId: 'student-1' },
  validFrom: '2026-09-13T00:00:00Z', expiresAt: null, revokedAt: null,
  reason: 'Temporary approved cover', createdByMembershipId: 'member-owner', version: 1,
}

test('basic student and staff schemas reject hidden data instead of stripping it', () => {
  assert.equal(c.StudentBasic.safeParse(student).success, true)
  assert.equal(c.StaffDirectory.safeParse(staff).success, true)
  for (const [schema, data, fields] of [
    [c.StudentBasic, student, ['medicalNotes', 'aadhaarLast4', 'annualIncome', 'guardians']],
    [c.StaffDirectory, staff, ['monthlySalary', 'bankAccountLast4', 'phone', 'password']],
  ]) for (const field of fields) assert.equal(schema.safeParse({ ...data, [field]: 'private' }).success, false, field)
})

test('nested timetable projections cannot carry full staff records', () => {
  const cell = { section: { id: 'section-1', name: '6A' }, subject: { id: 'subject-1', name: 'Maths' }, teacher: { id: 'staff-1', name: 'Meera' }, dayOfWeek: 1, periodIndex: 0 }
  assert.equal(c.TimetableCell.safeParse(cell).success, true)
  assert.equal(c.TimetableCell.safeParse({ ...cell, teacher: { ...cell.teacher, monthlySalary: 45000 } }).success, false)
})

test('invite and role-change requests reject owner, student and client authority fields', () => {
  assert.equal(c.InviteMemberRequest.safeParse(invite).success, true)
  for (const roleKeys of [['owner'], ['student'], ['teacher', 'teacher'], []]) {
    assert.equal(c.InviteMemberRequest.safeParse({ ...invite, roleKeys }).success, false)
  }
  for (const field of ['schoolId', 'status', 'userId', 'emailVerified', 'permissions', 'roleIds']) {
    assert.equal(c.InviteMemberRequest.safeParse({ ...invite, [field]: 'injected' }).success, false, field)
  }
  assert.equal(c.InviteMemberRequest.safeParse({ ...invite, staffId: undefined }).success, false)
  assert.equal(c.ChangeRolesRequest.safeParse({ roleKeys: ['teacher'], expectedVersion: 1, reason: 'Assignment changed' }).success, true)
  assert.equal(c.ChangeRolesRequest.safeParse({ roleKeys: ['teacher'], reason: 'Assignment changed' }).success, false)
})

test('phone login uses normalized identifiers; client supplies no verification claim', () => {
  assert.equal(c.ContactIdentifier.safeParse({ kind: 'phone', value: '+919876543210' }).success, true)
  assert.equal(c.ContactIdentifier.safeParse({ kind: 'phone', value: '9876543210' }).success, false)
  assert.equal(c.ContactIdentifier.safeParse({ kind: 'phone', value: '+919876543210', verified: true }).success, false)
})

test('membership lifecycle changes do not accept role or identity patches', () => {
  const change = { expectedVersion: 1, reason: 'Teacher left school' }
  assert.equal(c.MembershipActionRequest.safeParse(change).success, true)
  for (const field of ['roleKeys', 'userId', 'schoolId', 'status']) {
    assert.equal(c.MembershipActionRequest.safeParse({ ...change, [field]: 'injected' }).success, false)
  }
  assert.equal(c.RestoreMembershipRequest.safeParse(change).success, false, 'restore requires explicit reviewed roles')
})

test('normal edits cannot change login access or payroll', () => {
  const change = { expectedVersion: 1, firstName: 'Meera' }
  assert.equal(c.UpdateStudentBasicRequest.safeParse(change).success, true)
  for (const field of ['sectionId', 'schoolId', 'medicalNotes', 'roleKeys']) {
    assert.equal(c.UpdateStudentBasicRequest.safeParse({ ...change, [field]: 'injected' }).success, false)
  }
  assert.equal(c.UpdateStaffPrivateRequest.safeParse({ expectedVersion: 1, phone: '+919876543210', monthlySalary: 99999 }).success, false)
  assert.equal(c.UpdateStudentBasicRequest.safeParse({ expectedVersion: 1 }).success, false)
})

test('search cannot be used to sort on hidden fields or request an unlimited dataset', () => {
  assert.equal(c.StudentListRequest.safeParse({}).success, true)
  for (const payload of [{ sort: 'medicalNotes' }, { fields: ['annualIncome'] }, { pageSize: 10000 }, { schoolId: 'other' }]) {
    assert.equal(c.StudentListRequest.safeParse(payload).success, false)
  }
})

test('bulk/import contracts reject duplicate, overlapping and client-certified records', () => {
  assert.equal(c.ExportStudentsRequest.safeParse({ studentIds: ['one', 'one'] }).success, false)
  assert.equal(c.CommitStudentImportRequest.safeParse({ previewId: 'preview-1', expectedVersion: 1, validRows: [student] }).success, false)
  const promotion = { fromAcademicYearId: 'year-1', toAcademicYearId: 'year-2', fromSectionId: 'section-1', toSectionId: 'section-2', studentIds: ['one'], detainedStudentIds: ['two'], reason: 'Year end promotion' }
  assert.equal(c.PromoteStudentsRequest.safeParse(promotion).success, true)
  assert.equal(c.PromoteStudentsRequest.safeParse({ ...promotion, detainedStudentIds: ['one'] }).success, false)
})

test('resource rules have typed exclusive targets and supported permissions', () => {
  assert.equal(c.ResourceAccessRule.safeParse(rule).success, true)
  for (const patch of [
    { target: { kind: 'student', studentId: 'student-1', staffId: 'staff-1' } },
    { permission: 'roles.assign' }, { permission: 'fees.read' }, { effect: 'override' },
    { expiresAt: rule.validFrom }, { target: { kind: 'sql', expression: 'TRUE' } },
  ]) assert.equal(c.ResourceAccessRule.safeParse({ ...rule, ...patch }).success, false)
})

test('MFA summaries represent completed verification, not an enrollment flag', () => {
  const session = { expiresAt: '2026-09-14T00:00:00Z', assurance: 'single_factor', mfaVerifiedAt: null }
  assert.equal(c.SessionSummary.safeParse(session).success, true)
  assert.equal(c.SessionSummary.safeParse({ ...session, assurance: 'mfa' }).success, false)
  assert.equal(c.SessionSummary.safeParse({ ...session, token: 'secret' }).success, false)
})

test('student activation is disabled in login choices and membership responses', () => {
  assert.equal(c.LOGIN_METHODS.student.enabled, false)
  assert.deepEqual(c.LOGIN_METHODS.student.methods, [])
  const membership = { id: 'member-1', school: { id: 'school-1', name: 'School', code: 'school' }, status: 'active', kind: 'adult', roleKeys: ['teacher'], accessVersion: 1 }
  assert.equal(c.MembershipSummary.safeParse(membership).success, true)
  assert.equal(c.MembershipSummary.safeParse({ ...membership, kind: 'student', roleKeys: ['student'] }).success, false)
  assert.equal(c.MembershipSummary.safeParse({ ...membership, roleKeys: ['teacher', 'student'] }).success, false)
})

test('documents and audit summaries cannot return storage credentials or raw private changes', () => {
  const document = { id: 'doc-1', studentId: 'student-1', fileName: 'record.pdf', type: 'birth_certificate', sizeBytes: 10, verified: true, allowedActions: [] }
  assert.equal(c.DocumentSummary.safeParse(document).success, true)
  for (const field of ['fileUrl', 'storageKey', 'signedUrl']) assert.equal(c.DocumentSummary.safeParse({ ...document, [field]: 'secret' }).success, false)
  assert.equal(c.AuditEventSummary.safeParse({ id: 'audit-1', at: rule.validFrom, actorDisplayName: 'Meera', action: 'staff.read_pay', summary: 'Viewed pay', outcome: 'allowed', changes: { monthlySalary: 123 } }).success, false)
})

test('advertised actions exclude reserved or duplicate permissions', () => {
  assert.equal(c.AllowedActions.safeParse(['students.read_basic']).success, true)
  assert.equal(c.AllowedActions.safeParse(['ai_assistant.use']).success, false)
  assert.equal(c.AllowedActions.safeParse(['students.read_basic', 'students.read_basic']).success, false)
})

test('output date ranges retain input refinements', () => {
  assert.equal(c.AcademicYear.safeParse({ id: 'year-1', schoolId: 'school-1', version: 1, name: '2026', status: 'current', startDate: '2026-04-01', endDate: '2025-03-31' }).success, false)
  assert.equal(c.Holiday.safeParse({ id: 'holiday-1', schoolId: 'school-1', academicYearId: 'year-1', version: 1, name: 'Break', type: 'school', startDate: '2026-09-15', endDate: '2026-09-14' }).success, false)
})

test('consent, reveal and anonymisation contracts refuse free-form or unscoped input', () => {
  const consent = { guardianId: 'guardian-1', purpose: 'photographs', status: 'given', method: 'portal' }
  assert.equal(c.RecordConsentRequest.safeParse(consent).success, true)
  for (const field of ['studentId', 'recordedBy', 'schoolId', 'recordedAt']) {
    assert.equal(c.RecordConsentRequest.safeParse({ ...consent, [field]: 'injected' }).success, false, field)
  }
  assert.equal(c.RecordConsentRequest.safeParse({ ...consent, purpose: 'anything' }).success, false)
  assert.equal(c.RecordConsentRequest.safeParse({ ...consent, evidenceReference: 'x'.repeat(201) }).success, false)
  assert.deepEqual(c.CONSENT_PURPOSES.length, 5)

  // The sensitive block carries the mask only; the full value has its own audited route.
  const sensitive = { dateOfBirth: '2014-05-02', gender: 'female', admissionDate: '2020-04-01' }
  assert.equal(c.StudentSensitive.safeParse({ ...sensitive, apaarMasked: 'XXXX-XXXX-4321' }).success, true)
  assert.equal(c.StudentSensitive.safeParse({ ...sensitive, apaarMasked: '1234-5678-4321' }).success, false)
  assert.equal(c.StudentSensitive.safeParse({ ...sensitive, apaarId: '123456784321' }).success, false)
  assert.equal(c.StudentApaarReveal.safeParse({ apaarId: '123456784321' }).success, true)

  const anonymise = { expectedVersion: 1, reason: 'Retention period has passed' }
  assert.equal(c.AnonymiseRequest.safeParse(anonymise).success, true)
  assert.equal(c.UnlinkGuardianRequest.safeParse(anonymise).success, true)
  for (const field of ['status', 'anonymisedAt', 'schoolId']) {
    assert.equal(c.AnonymiseRequest.safeParse({ ...anonymise, [field]: 'injected' }).success, false, field)
  }
  assert.equal(c.RedactAuditNoteRequest.safeParse({ reason: 'Contained a phone number' }).success, true)
  assert.equal(c.RedactAuditNoteRequest.safeParse({ reason: 'Contained a phone number', note: 'x' }).success, false)
  assert.equal(c.RETENTION.studentSensitiveYears, 3)
  assert.equal(c.RETENTION.staffPrivateYears, 8)
})

test('admission consents index the request guardians and stay bounded', () => {
  const admit = {
    firstName: 'Meera', dateOfBirth: '2014-05-02', gender: 'female', admissionDate: '2026-04-01',
    sectionId: 'section-1',
    guardians: [{ guardian: { firstName: 'Anil', phone: '+919876543210' }, relation: 'father' }],
    consents: [{ guardianIndex: 0, purpose: 'communication', method: 'signed_form' }],
  }
  assert.equal(c.StudentsAdmitRequest.safeParse(admit).success, true)
  assert.equal(c.StudentsAdmitRequest.safeParse({ ...admit, consents: [{ guardianIndex: -1, purpose: 'communication', method: 'signed_form' }] }).success, false)
  assert.equal(c.StudentsAdmitRequest.safeParse({ ...admit, consents: [{ guardianIndex: 0, purpose: 'communication', method: 'signed_form', guardianId: 'guardian-1' }] }).success, false)
  const many = Array.from({ length: 26 }, () => ({ guardianIndex: 0, purpose: 'communication', method: 'portal' }))
  assert.equal(c.StudentsAdmitRequest.safeParse({ ...admit, consents: many }).success, false)
})

test('a refusal reason is one of the named blockers, and never free text', () => {
  const error = { code: 'INVALID_REQUEST', message: 'This class still has sections.', requestId: 'req-1' }
  assert.equal(c.ApiError.safeParse({ error }).success, true)
  assert.equal(c.ApiError.safeParse({ error: { ...error, reason: 'grade_has_sections' } }).success, true)
  assert.equal(c.ApiError.safeParse({ error: { ...error, reason: 'section_has_students' } }).success, true)
  for (const reason of ['grade_is_busy', 'Grade has sections', '', 'students']) {
    assert.equal(c.ApiError.safeParse({ error: { ...error, reason } }).success, false, reason)
  }
})

test('the member directory filters are a closed list of narrowing keys', () => {
  const staffId = '3f1a2b4c-5d6e-4f70-8901-23456789abcd'
  assert.equal(c.MemberListRequest.safeParse({}).success, true)
  assert.equal(c.MemberListRequest.safeParse({ page: 2, pageSize: 50, search: 'Meera', role: 'teacher', status: 'active', staffId }).success, true)
  for (const bad of [{ status: 'asleep' }, { role: 'headmaster' }, { staffId: 'staff-1' }, { search: '' }, { department: 'maths' }, { search: 'x'.repeat(101) }]) {
    assert.equal(c.MemberListRequest.safeParse(bad).success, false, JSON.stringify(bad))
  }
})
