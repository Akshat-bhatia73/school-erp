/**
 * The API layer builds requests, and nothing else. These tests mock `request()` and assert the
 * method, path and query string each function produces, because a wrong path is the one mistake
 * the contract schemas cannot catch.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const http = vi.hoisted(() => ({
  request: vi.fn(),
  ApiRequestError: class extends Error {
    code: string
    status: number
    constructor(init: { code: string; status: number; message: string }) {
      super(init.message)
      this.code = init.code
      this.status = init.status
    }
  },
}))
vi.mock('@/lib/http', () => http)

const { api } = await import('./index')

const SCHOOL = 'school-1'
const PREFIX = '/api/schools/school-1'

function lastCall() {
  const call = http.request.mock.calls.at(-1)
  if (!call) throw new Error('request() was never called')
  return { path: call[0] as string, options: (call[1] ?? {}) as Record<string, unknown> }
}

function methodOf(): string {
  return (lastCall().options.method as string | undefined) ?? 'GET'
}

describe('api paths', () => {
  beforeEach(() => {
    http.request.mockReset()
    http.request.mockResolvedValue(undefined)
  })

  it('reads and updates the school profile', async () => {
    await api.setup.school(SCHOOL)
    expect(lastCall().path).toBe(`${PREFIX}/school`)
    await api.setup.updateSchool(SCHOOL, { name: 'SVM' } as never)
    expect(methodOf()).toBe('PUT')
    expect(lastCall().options.body).toEqual({ name: 'SVM' })
  })

  it('lists and creates academic years', async () => {
    await api.setup.academicYears(SCHOOL)
    expect(lastCall().path).toBe(`${PREFIX}/academic-years`)
    await api.setup.currentAcademicYear(SCHOOL)
    expect(lastCall().path).toBe(`${PREFIX}/academic-years/current`)
    await api.setup.createAcademicYear(SCHOOL, { name: '2025-26' } as never)
    expect(methodOf()).toBe('POST')
  })

  it('updates and deletes a grade', async () => {
    await api.setup.updateGrade(SCHOOL, 'g1', { expectedVersion: 1 } as never)
    expect(lastCall().path).toBe(`${PREFIX}/grades/g1`)
    await api.setup.deleteGrade(SCHOOL, 'g1')
    expect(methodOf()).toBe('DELETE')
    // A 204 route resolves to nothing at all.
    await expect(api.setup.deleteGrade(SCHOOL, 'g1')).resolves.toBeUndefined()
  })

  it('leaves undefined section filters out of the query', async () => {
    await api.setup.sections(SCHOOL, { academicYearId: 'y1' })
    expect(lastCall().path).toBe(`${PREFIX}/sections?academicYearId=y1`)
    await api.setup.sections(SCHOOL)
    expect(lastCall().path).toBe(`${PREFIX}/sections`)
  })

  it('reads section strengths and one section', async () => {
    await api.setup.sectionStrengths(SCHOOL, { academicYearId: 'y1' })
    expect(lastCall().path).toBe(`${PREFIX}/sections/strengths?academicYearId=y1`)
    await api.setup.section(SCHOOL, 'sec-1')
    expect(lastCall().path).toBe(`${PREFIX}/sections/sec-1`)
  })

  it('maps subjects onto a class', async () => {
    await api.setup.setGradeSubjects(SCHOOL, 'g1', { academicYearId: 'y1', subjectIds: [] })
    expect(lastCall().path).toBe(`${PREFIX}/grades/g1/subjects`)
    expect(methodOf()).toBe('PUT')
  })

  it('lists holidays for one year', async () => {
    await api.setup.holidays(SCHOOL, { academicYearId: 'y1' })
    expect(lastCall().path).toBe(`${PREFIX}/holidays?academicYearId=y1`)
  })

  it('lists, counts and searches students', async () => {
    await api.students.list(SCHOOL, { page: 2, sectionId: 'sec-1' })
    expect(lastCall().path).toBe(`${PREFIX}/students?page=2&sectionId=sec-1`)
    await api.students.count(SCHOOL, { status: 'active' })
    expect(lastCall().path).toBe(`${PREFIX}/students/count?status=active`)
    await api.students.search(SCHOOL, 'asha rao')
    expect(lastCall().path).toBe(`${PREFIX}/students/search?q=asha+rao`)
  })

  it('reads one student and its related lists', async () => {
    await api.students.get(SCHOOL, 'st-1')
    expect(lastCall().path).toBe(`${PREFIX}/students/st-1`)
    await api.students.guardians(SCHOOL, 'st-1')
    expect(lastCall().path).toBe(`${PREFIX}/students/st-1/guardians`)
    await api.students.siblings(SCHOOL, 'st-1')
    expect(lastCall().path).toBe(`${PREFIX}/students/st-1/siblings`)
    await api.students.documents(SCHOOL, 'st-1')
    expect(lastCall().path).toBe(`${PREFIX}/students/st-1/documents`)
    await api.students.enrollments(SCHOOL, 'st-1')
    expect(lastCall().path).toBe(`${PREFIX}/students/st-1/enrollments`)
  })

  it('writes a student', async () => {
    await api.students.create(SCHOOL, { firstName: 'Asha' } as never)
    expect(methodOf()).toBe('POST')
    expect(lastCall().path).toBe(`${PREFIX}/students`)
    await api.students.updateBasic(SCHOOL, 'st-1', { expectedVersion: 3, firstName: 'Asha' })
    expect(methodOf()).toBe('PUT')
    await api.students.updateSensitive(SCHOOL, 'st-1', { expectedVersion: 3, gender: 'female' })
    expect(lastCall().path).toBe(`${PREFIX}/students/st-1/sensitive`)
    await api.students.move(SCHOOL, 'st-1', { expectedVersion: 3, sectionId: 'sec-2', reason: 'Section change' })
    expect(lastCall().path).toBe(`${PREFIX}/students/st-1/move`)
    await api.students.leave(SCHOOL, 'st-1', { expectedVersion: 3, leftOn: '2026-03-31', reason: 'Moved city' })
    expect(lastCall().path).toBe(`${PREFIX}/students/st-1/leave`)
  })

  it('manages guardians', async () => {
    await api.students.addGuardian(SCHOOL, 'st-1', { relation: 'mother', guardianId: 'g1' })
    expect(lastCall().path).toBe(`${PREFIX}/students/st-1/guardians`)
    await api.students.updateGuardian(SCHOOL, 'st-1', 'g1', { expectedVersion: 1, relation: 'mother' })
    expect(lastCall().path).toBe(`${PREFIX}/students/st-1/guardians/g1`)
    expect(methodOf()).toBe('PUT')
  })

  it('previews and commits a bulk import', async () => {
    await api.students.importPreview(SCHOOL, { academicYearId: 'y1', rows: [] } as never)
    expect(lastCall().path).toBe(`${PREFIX}/students/import/preview`)
    await api.students.importCommit(SCHOOL, { previewId: 'p1', expectedVersion: 1 })
    expect(lastCall().path).toBe(`${PREFIX}/students/import/commit`)
  })

  it('previews and runs a promotion, and queues an export', async () => {
    await api.students.promotePreview(SCHOOL, {
      fromAcademicYearId: 'y1', toAcademicYearId: 'y2', fromSectionId: 's1', toSectionId: 's2', page: 2, pageSize: 100,
    })
    expect(lastCall().path).toBe(
      `${PREFIX}/students/promote/preview?fromAcademicYearId=y1&toAcademicYearId=y2&fromSectionId=s1&toSectionId=s2&page=2&pageSize=100`,
    )
    await api.students.promote(SCHOOL, { studentIds: ['st-1'] } as never)
    expect(lastCall().path).toBe(`${PREFIX}/students/promote`)
    await api.students.export(SCHOOL, { studentIds: ['st-1'] })
    expect(lastCall().path).toBe(`${PREFIX}/students/export`)
  })

  it('reads the staff directory', async () => {
    await api.staff.list(SCHOOL, { search: 'rao' })
    expect(lastCall().path).toBe(`${PREFIX}/staff?search=rao`)
    await api.staff.count(SCHOOL)
    expect(lastCall().path).toBe(`${PREFIX}/staff/count`)
    await api.staff.search(SCHOOL, 'rao')
    expect(lastCall().path).toBe(`${PREFIX}/staff/search?q=rao`)
    await api.staff.departments(SCHOOL)
    expect(lastCall().path).toBe(`${PREFIX}/staff/departments`)
    await api.staff.get(SCHOOL, 'sf-1')
    expect(lastCall().path).toBe(`${PREFIX}/staff/sf-1`)
  })

  it('reads and edits teaching assignments', async () => {
    await api.staff.assignments(SCHOOL, 'sf-1')
    expect(lastCall().path).toBe(`${PREFIX}/staff/sf-1/assignments`)
    await api.staff.sectionAssignments(SCHOOL, 'sec-1')
    expect(lastCall().path).toBe(`${PREFIX}/sections/sec-1/assignments`)
    await api.staff.unassign(SCHOOL, 'sf-1', 'a1')
    expect(lastCall().path).toBe(`${PREFIX}/staff/sf-1/assignments/a1`)
    expect(methodOf()).toBe('DELETE')
  })

  it('writes staff employment, private contact and pay', async () => {
    await api.staff.updateEmployment(SCHOOL, 'sf-1', { expectedVersion: 1, status: 'active' })
    expect(lastCall().path).toBe(`${PREFIX}/staff/sf-1/employment`)
    await api.staff.updatePrivate(SCHOOL, 'sf-1', { expectedVersion: 1, address: 'Pune' })
    expect(lastCall().path).toBe(`${PREFIX}/staff/sf-1/private`)
    await api.staff.updatePay(SCHOOL, 'sf-1', { expectedVersion: 1, monthlySalary: 50000, reason: 'Annual revision' })
    expect(lastCall().path).toBe(`${PREFIX}/staff/sf-1/pay`)
    await api.staff.export(SCHOOL, { staffIds: ['sf-1'] })
    expect(lastCall().path).toBe(`${PREFIX}/staff/export`)
  })

  it('reads the timetable grid and its helpers', async () => {
    await api.timetable.forSection(SCHOOL, 'sec-1', { academicYearId: 'y1' })
    expect(lastCall().path).toBe(`${PREFIX}/timetable/sections/sec-1?academicYearId=y1`)
    await api.timetable.forStaff(SCHOOL, 'sf-1', { academicYearId: 'y1' })
    expect(lastCall().path).toBe(`${PREFIX}/timetable/staff/sf-1?academicYearId=y1`)
    await api.timetable.freeTeachers(SCHOOL, { academicYearId: 'y1', dayOfWeek: 2, periodIndex: 3 })
    expect(lastCall().path).toBe(`${PREFIX}/timetable/free-teachers?academicYearId=y1&dayOfWeek=2&periodIndex=3`)
    await api.timetable.conflicts(SCHOOL, { academicYearId: 'y1' })
    expect(lastCall().path).toBe(`${PREFIX}/timetable/conflicts?academicYearId=y1`)
    await api.timetable.teacherLoads(SCHOOL, { academicYearId: 'y1' })
    expect(lastCall().path).toBe(`${PREFIX}/timetable/teacher-loads?academicYearId=y1`)
  })

  it('sets and clears one timetable slot', async () => {
    await api.timetable.setEntry(SCHOOL, {
      academicYearId: 'y1', sectionId: 'sec-1', dayOfWeek: 1, periodIndex: 0, subjectId: 'sub-1',
    })
    expect(methodOf()).toBe('PUT')
    expect(lastCall().path).toBe(`${PREFIX}/timetable/entries`)
    await api.timetable.clearEntry(SCHOOL, { academicYearId: 'y1', sectionId: 'sec-1', dayOfWeek: 1, periodIndex: 0 })
    expect(methodOf()).toBe('DELETE')
    expect(lastCall().path).toBe(`${PREFIX}/timetable/entries?academicYearId=y1&sectionId=sec-1&dayOfWeek=1&periodIndex=0`)
  })

  it('reads bell schedules and generates a week', async () => {
    await api.timetable.bellSchedules(SCHOOL, { academicYearId: 'y1' })
    expect(lastCall().path).toBe(`${PREFIX}/timetable/bell-schedules?academicYearId=y1`)
    await api.timetable.bellScheduleForGrade(SCHOOL, 'g1', { academicYearId: 'y1' })
    expect(lastCall().path).toBe(`${PREFIX}/timetable/bell-schedules/for-grade/g1?academicYearId=y1`)
    await api.timetable.generate(SCHOOL, 'sec-1', { academicYearId: 'y1', reason: 'First draft' })
    expect(lastCall().path).toBe(`${PREFIX}/timetable/sections/sec-1/generate`)
  })

  it('reads and writes substitutions', async () => {
    await api.timetable.substitutions(SCHOOL, '2026-01-12')
    expect(lastCall().path).toBe(`${PREFIX}/timetable/substitutions?date=2026-01-12`)
    await api.timetable.absentPeriods(SCHOOL, { staffId: 'sf-1', date: '2026-01-12' })
    expect(lastCall().path).toBe(`${PREFIX}/timetable/substitutions/absent-periods?staffId=sf-1&date=2026-01-12`)
    await api.timetable.deleteSubstitution(SCHOOL, 'sub-9')
    expect(lastCall().path).toBe(`${PREFIX}/timetable/substitutions/sub-9`)
    expect(methodOf()).toBe('DELETE')
    await api.timetable.notifySubstitutions(SCHOOL, { date: '2026-01-12' })
    expect(lastCall().path).toBe(`${PREFIX}/timetable/substitutions/notify`)
  })

  it('reads the dashboard and the command menu search', async () => {
    await api.dashboard.get(SCHOOL)
    expect(lastCall().path).toBe(`${PREFIX}/dashboard`)
    await api.search.run(SCHOOL, 'asha')
    expect(lastCall().path).toBe(`${PREFIX}/search?q=asha`)
  })

  it('reads and exports the audit log', async () => {
    await api.audit.list(SCHOOL, { page: 3, action: 'students.create' })
    expect(lastCall().path).toBe(`${PREFIX}/audit-events?page=3&action=students.create`)
    await api.audit.export(SCHOOL, { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' })
    expect(lastCall().path).toBe(`${PREFIX}/audit-events/export`)
  })

  it('reads members and explains access', async () => {
    await api.members.list(SCHOOL, { page: 1, pageSize: 25 })
    expect(lastCall().path).toBe(`${PREFIX}/members?page=1&pageSize=25`)
    await api.members.list(SCHOOL, { search: 'Priya', role: 'teacher', status: 'active', page: 1, pageSize: 25 })
    expect(lastCall().path).toBe(`${PREFIX}/members?search=Priya&role=teacher&status=active&page=1&pageSize=25`)
    await api.members.list(SCHOOL, { staffId: 'staff-1', pageSize: 1 })
    expect(lastCall().path).toBe(`${PREFIX}/members?staffId=staff-1&pageSize=1`)
    await api.members.accessExplanation(SCHOOL, 'm1', {
      permission: 'students.read_basic', resourceType: 'student', resourceId: 'st-1',
    })
    expect(lastCall().path).toBe(
      `${PREFIX}/members/m1/access-explanation?permission=students.read_basic&resourceType=student&resourceId=st-1`,
    )
  })

  it('lists, invites, resends and revokes invitations', async () => {
    await api.members.listInvitations(SCHOOL, { status: 'pending', page: 1, pageSize: 25 })
    expect(lastCall().path).toBe(`${PREFIX}/invitations?status=pending&page=1&pageSize=25`)
    await api.members.invite(SCHOOL, {
      displayName: 'Asha Rao', identifier: { kind: 'email', value: 'asha@example.test' }, roleKeys: ['teacher'], staffId: 'sf-1',
    })
    expect(lastCall().path).toBe(`${PREFIX}/invitations`)
    await api.members.resendInvitation(SCHOOL, 'inv-1', { expectedVersion: 1 })
    expect(lastCall().path).toBe(`${PREFIX}/invitations/inv-1/resend`)
    await api.members.revokeInvitation(SCHOOL, 'inv-1', { expectedVersion: 1 })
    expect(lastCall().path).toBe(`${PREFIX}/invitations/inv-1/revoke`)
  })

  it('changes roles and the membership lifecycle', async () => {
    await api.members.changeRoles(SCHOOL, 'm1', { roleKeys: ['teacher'], expectedVersion: 1, reason: 'New duty' })
    expect(methodOf()).toBe('PUT')
    expect(lastCall().path).toBe(`${PREFIX}/members/m1/roles`)
    await api.members.suspend(SCHOOL, 'm1', { expectedVersion: 1, reason: 'On leave' })
    expect(lastCall().path).toBe(`${PREFIX}/members/m1/suspend`)
    await api.members.remove(SCHOOL, 'm1', { expectedVersion: 1, reason: 'Left the school' })
    expect(lastCall().path).toBe(`${PREFIX}/members/m1/remove`)
    await api.members.restore(SCHOOL, 'm1', { roleKeys: ['teacher'], expectedVersion: 1, reason: 'Back' })
    expect(lastCall().path).toBe(`${PREFIX}/members/m1/restore`)
    await api.members.startRecovery(SCHOOL, 'm1', { expectedVersion: 1, reason: 'Lost the password' })
    expect(lastCall().path).toBe(`${PREFIX}/members/m1/recovery`)
    await api.members.transferOwnership(SCHOOL, {
      targetMembershipId: 'm2', expectedSchoolAccessVersion: 4, reason: 'Handover',
    })
    expect(lastCall().path).toBe(`${PREFIX}/ownership/transfer`)
  })

  it('reads, adds and lifts member restrictions', async () => {
    await api.members.restrictions(SCHOOL, 'm1')
    expect(methodOf()).toBe('GET')
    expect(lastCall().path).toBe(`${PREFIX}/members/m1/restrictions`)
    const body = { permission: 'students.read_medical' as const, reason: 'Not needed', expectedAccessVersion: 4 }
    await api.members.addRestriction(SCHOOL, 'm1', body)
    expect(methodOf()).toBe('POST')
    expect(lastCall().path).toBe(`${PREFIX}/members/m1/restrictions`)
    expect(lastCall().options.body).toEqual(body)
    await api.members.liftRestriction(SCHOOL, 'm1', 'r1', { expectedVersion: 2, reason: 'Back on duty' })
    expect(methodOf()).toBe('POST')
    expect(lastCall().path).toBe(`${PREFIX}/members/m1/restrictions/r1/lift`)
    expect(lastCall().options.body).toEqual({ expectedVersion: 2, reason: 'Back on duty' })
  })

  it('reads an export job', async () => {
    await api.files.exportJob(SCHOOL, 'job-1')
    expect(lastCall().path).toBe(`${PREFIX}/exports/job-1`)
  })

  it('asks for the three exports a screen can start', async () => {
    await api.students.exportProfile(SCHOOL, 'st-1')
    expect(methodOf()).toBe('POST')
    expect(lastCall().path).toBe(`${PREFIX}/students/st-1/export-profile`)
    await api.staff.exportProfile(SCHOOL, 'staff-1')
    expect(lastCall().path).toBe(`${PREFIX}/staff/staff-1/export-profile`)
    await api.timetable.export(SCHOOL, {
      academicYearId: 'year-1', format: 'pdf', view: { kind: 'teacher', staffId: 'staff-1' },
    })
    expect(lastCall().path).toBe(`${PREFIX}/timetable/export`)
  })

  it('reads and writes exams and their marks sheets', async () => {
    await api.exams.list(SCHOOL, { academicYearId: 'year-1' })
    expect(lastCall().path).toBe(`${PREFIX}/exams?academicYearId=year-1`)
    await api.exams.create(SCHOOL, { academicYearId: 'year-1', kind: 'half_yearly', startsOn: '2026-09-21', endsOn: '2026-09-30', recheckDeadline: '2026-10-10' })
    expect(methodOf()).toBe('POST')
    expect(lastCall().path).toBe(`${PREFIX}/exams`)
    await api.exams.update(SCHOOL, 'ex-1', { expectedVersion: 2, startsOn: '2026-09-21', endsOn: '2026-09-30', recheckDeadline: '2026-10-10' })
    expect(methodOf()).toBe('PUT')
    expect(lastCall().path).toBe(`${PREFIX}/exams/ex-1`)
    await api.exams.overview(SCHOOL, 'ex-1')
    expect(lastCall().path).toBe(`${PREFIX}/exams/ex-1`)
    await api.exams.papers(SCHOOL, { academicYearId: 'year-1', examId: undefined })
    expect(lastCall().path).toBe(`${PREFIX}/exams/papers?academicYearId=year-1`)
    await api.exams.sheet(SCHOOL, 'p-1')
    expect(lastCall().path).toBe(`${PREFIX}/exams/papers/p-1`)
    await api.exams.saveMarks(SCHOOL, 'p-1', { entries: [{ studentId: 'st-1', component: 'written', value: 71.5 }] })
    expect(methodOf()).toBe('PUT')
    expect(lastCall().path).toBe(`${PREFIX}/exams/papers/p-1/marks`)
    await api.exams.correct(SCHOOL, 'p-1', { entries: [{ studentId: 'st-1', component: 'written', value: 'absent' }], reasonKind: 'recheck', reason: 'Re-counted' })
    expect(methodOf()).toBe('POST')
    expect(lastCall().path).toBe(`${PREFIX}/exams/papers/p-1/corrections`)
    await api.exams.history(SCHOOL, 'p-1', 'st-1', { component: 'notebook' })
    expect(lastCall().path).toBe(`${PREFIX}/exams/papers/p-1/students/st-1/history?component=notebook`)
  })

  it('publishes an exam for a section, reads results and exports a register', async () => {
    await api.exams.publish(SCHOOL, 'ex-1', 'sec-1')
    expect(methodOf()).toBe('POST')
    expect(lastCall().path).toBe(`${PREFIX}/exams/ex-1/sections/sec-1/publish`)
    expect(lastCall().options.body).toEqual({})
    await api.exams.results(SCHOOL, 'st-1', { academicYearId: 'year-1' })
    expect(lastCall().path).toBe(`${PREFIX}/exams/students/st-1/results?academicYearId=year-1`)
    await api.exams.exportRegister(SCHOOL, 'p-1')
    expect(methodOf()).toBe('POST')
    expect(lastCall().path).toBe(`${PREFIX}/exams/papers/p-1/export`)
  })

  it('reads and writes report card settings, entries and sections', async () => {
    await api.reportCards.settings(SCHOOL)
    expect(lastCall().path).toBe(`${PREFIX}/report-cards/settings`)
    await api.reportCards.saveSettings(SCHOOL, { expectedVersion: 0 } as never)
    expect(methodOf()).toBe('PUT')
    await api.reportCards.entries(SCHOOL, 'sec-1', 'term_1')
    expect(lastCall().path).toBe(`${PREFIX}/report-cards/sections/sec-1/terms/term_1/entries`)
    await api.reportCards.saveEntries(SCHOOL, 'sec-1', 'term_2', { rows: [] } as never)
    expect(methodOf()).toBe('PUT')
    expect(lastCall().path).toBe(`${PREFIX}/report-cards/sections/sec-1/terms/term_2/entries`)
    await api.reportCards.sections(SCHOOL, { academicYearId: 'year-1', card: 'final' })
    expect(lastCall().path).toBe(`${PREFIX}/report-cards/sections?academicYearId=year-1&card=final`)
    await api.reportCards.section(SCHOOL, 'sec-1', 'term_1')
    expect(lastCall().path).toBe(`${PREFIX}/report-cards/sections/sec-1/cards/term_1`)
    await api.reportCards.publish(SCHOOL, 'sec-1', 'final')
    expect(methodOf()).toBe('POST')
    expect(lastCall().path).toBe(`${PREFIX}/report-cards/sections/sec-1/cards/final/publish`)
    expect(lastCall().options.body).toEqual({})
  })

  it('reads a pupil\'s report cards and one version, and starts their files', async () => {
    await api.reportCards.forStudent(SCHOOL, 'st-1', { academicYearId: 'year-1' })
    expect(lastCall().path).toBe(`${PREFIX}/report-cards/students/st-1?academicYearId=year-1`)
    await api.reportCards.version(SCHOOL, 'v-1')
    expect(lastCall().path).toBe(`${PREFIX}/report-cards/versions/v-1`)
    await api.reportCards.exportVersion(SCHOOL, 'v-1')
    expect(lastCall().path).toBe(`${PREFIX}/report-cards/versions/v-1/export`)
    await api.reportCards.exportSection(SCHOOL, 'sec-1', 'term_1')
    expect(methodOf()).toBe('POST')
    expect(lastCall().path).toBe(`${PREFIX}/report-cards/sections/sec-1/cards/term_1/export`)
  })
})

describe('document download', () => {
  beforeEach(() => {
    http.request.mockReset()
  })

  it('fetches bytes with credentials and takes the name from the header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('bytes', {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="transfer-certificate.pdf"',
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const file = await api.files.downloadStudentDocument(SCHOOL, 'st-1', 'doc-1')
    expect(fetchMock).toHaveBeenCalledWith(
      `${PREFIX}/students/st-1/documents/doc-1/content`,
      { credentials: 'same-origin' },
    )
    expect(file.fileName).toBe('transfer-certificate.pdf')
    expect(await file.blob.text()).toBe('bytes')
    vi.unstubAllGlobals()
  })

  it('fetches an export file the same way', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('sheet', {
        status: 200,
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-disposition': 'attachment; filename="students.xlsx"',
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const file = await api.files.downloadExportFile(SCHOOL, 'job-1')
    expect(fetchMock).toHaveBeenCalledWith(`${PREFIX}/exports/job-1/file`, { credentials: 'same-origin' })
    expect(file.fileName).toBe('students.xlsx')
    vi.unstubAllGlobals()
  })

  it('turns a refusal into the error envelope every screen already describes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'RESOURCE_NOT_FOUND', message: 'We could not find that.' } }), {
        status: 404, headers: { 'content-type': 'application/json' },
      }),
    ))
    await expect(api.files.downloadStudentDocument(SCHOOL, 'st-1', 'doc-1')).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
      status: 404,
    })
    vi.unstubAllGlobals()
  })
})

describe('school logo', () => {
  it('sends the file with its own type and the version in the query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const file = new Blob(['png'], { type: 'image/png' })
    await api.logo.upload(SCHOOL, file, 4)
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe(`${PREFIX}/school/logo?expectedVersion=4`)
    expect(init.method).toBe('PUT')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/png')
    await api.logo.remove(SCHOOL, 5)
    const [removePath, removeInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(removePath).toBe(`${PREFIX}/school/logo?expectedVersion=5`)
    expect(removeInit.method).toBe('DELETE')
    expect(api.logo.url(SCHOOL, '2026-09-23T10:00:00Z')).toBe(`${PREFIX}/school/logo?v=2026-09-23T10%3A00%3A00Z`)
    vi.unstubAllGlobals()
  })
})

describe('student logins', () => {
  beforeEach(() => {
    http.request.mockReset()
    http.request.mockResolvedValue(undefined)
  })

  it('reads and acts on one pupil login', async () => {
    await api.studentLogins.get(SCHOOL, 's1')
    expect(lastCall().path).toBe(`${PREFIX}/students/s1/login`)
    expect(methodOf()).toBe('GET')
    await api.studentLogins.issue(SCHOOL, 's1')
    expect(lastCall().path).toBe(`${PREFIX}/students/s1/login`)
    expect(methodOf()).toBe('POST')
    await api.studentLogins.resetPassword(SCHOOL, 's1')
    expect(lastCall().path).toBe(`${PREFIX}/students/s1/login/reset-password`)
    expect(methodOf()).toBe('POST')
    await api.studentLogins.switchOff(SCHOOL, 's1', { expectedVersion: 3, reason: 'Asked by parent' })
    expect(lastCall().path).toBe(`${PREFIX}/students/s1/login/switch-off`)
    expect(lastCall().options.body).toEqual({ expectedVersion: 3, reason: 'Asked by parent' })
    await api.studentLogins.switchOn(SCHOOL, 's1', { expectedVersion: 4 })
    expect(lastCall().path).toBe(`${PREFIX}/students/s1/login/switch-on`)
    expect(lastCall().options.body).toEqual({ expectedVersion: 4 })
  })

  it('issues every missing login at school level', async () => {
    await api.studentLogins.issueMissing(SCHOOL)
    expect(lastCall().path).toBe(`${PREFIX}/students/logins/issue`)
    expect(methodOf()).toBe('POST')
  })

  it('parses answers through the contract schemas', async () => {
    const { StudentLoginView, IssueStudentLoginsResult } = await import('@erp/contracts')
    await api.studentLogins.get(SCHOOL, 's1')
    expect(lastCall().options.schema).toBe(StudentLoginView)
    await api.studentLogins.issueMissing(SCHOOL)
    expect(lastCall().options.schema).toBe(IssueStudentLoginsResult)
  })
})
