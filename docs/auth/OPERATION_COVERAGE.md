# Current operation coverage

This inventory covers every route in `apps/web/src/routes` and every exported operation in `apps/web/src/api/client.ts` as of 13 September 2026. Task 5 owns protected school APIs and safe response DTO enforcement. Task 6 owns session/bootstrap HTTP integration. Task 7 owns permission-driven screens. Platform bootstrap operations are operator-only and do not become school-member permissions.

Safe response families below are contract names for implementation ownership; they deliberately do not reuse storage models.

## Status

Task 7 is built. Every feature screen now calls the protected APIs, and `apps/web` has no mock
client: `src/api/client.ts`, `seed.ts` and `store.ts` are deleted, so the operation rows below are
a record of what each screen used to call and where it went. See
[the feature screens](./WEB_SCREENS.md).

Task 5 is built. Every operation below marked `Task 5` now has a real endpoint in `apps/api/src/modules`; see [protected school APIs](./PROTECTED_APIS.md) for the route tables, the read and write protocols, the projection rules and the known gaps. This inventory stays the statement of intent and is not rewritten to match the code. Where the two differ, the differences are these.

Owner or permission changed:

- `staff.assignments` is gated on `staff.read_employment` (school or self) and `staff.sectionAssignments` on `sections.read`, not `timetable.read`. Both are at least as strict for the callers that matter.
- `/staff/:staffId` is gated on `staff.read_directory`, not `staff.read_employment`, because the four staff projection keys are separate checks and the gate must be the weakest of them. Employment, private and pay are still decided per record.
- `timetable.absentTeacherPeriods` is gated on `timetable.manage_substitutions`, not `timetable.read`.
- `timetable.freeTeachers` accepts `timetable.manage_entries` or `timetable.manage_substitutions` inside the handler, but its route gate names `manage_entries` only, because the route helper takes one permission.
- `students.update` is two endpoints, `students.update_basic` and `students.update_sensitive`, rather than one endpoint that sorts fields; medical fields on the sensitive write also need `students.read_medical`.
- `students.enrollments` scope is now also applied to the class summary carried on a student hit in the roster, the search and the detail read, so a caller with no enrolment grant sees the pupil without the class.
- Attaching an existing guardian during admission needs `students.manage_guardians` as well as `students.create`.
- `subjects.setGradeSubjects` answers `GradeSubjectList`, not `Subject` or `EmptySuccess`.
- Export job status polling (`GET /api/schools/:schoolId/exports/:jobId`) and the export file download (`GET /api/schools/:schoolId/exports/:jobId/file`) are endpoints this inventory does not list. Each requires one of `students.export`, `staff.export`, `audit.export`, `timetable.read`, `fees.export`, `fees.read`, `attendance.export`, `attendance.read` or `staff_attendance.export` and then re-decides the permission the job itself recorded. The download also needs the job to be ready and to belong to the caller, and it writes one audit row.
- Three export endpoints this inventory does not list were added by decision on 19 September 2026: `POST /students/:studentId/export-profile` (`students.export`) and `POST /staff/:staffId/export-profile` (`staff.export`) turn one record into a document, and `POST /timetable/export` (`timetable.read`) turns one week into a spreadsheet or a document. Exporting a timetable is reading it in another format, so it carries the read permission rather than an export permission of its own.
- `auditLogs.list` redaction by audience is the scope term: `audit.read` and `audit.export` at the `finance` scope select only rows whose action is in `FINANCE_AUDIT_ACTIONS`, so an accountant's list, count and export never exceed the money trail.
- `timetable.bellSchedules` and `timetable.bellFor` are school-wide rather than matched scope: `timetable.read` is a permission over timetable entries, so no read plan can be built for a bell schedule.
- Search merges the student and staff search rows into one command-menu endpoint, returns at most ten hits of each kind with no count, and answers `staff: []` rather than a refusal for a caller who holds no staff key.
- `students.get` no longer carries the APAAR id in the sensitive block. It carries `apaarMasked`, and the full value is a separate audited read (`students.apaar` below).
- `students.list`, `students.count`, `students.search` and the search endpoint select no sensitive or medical column at all, rather than selecting them and dropping them in the projection.
- `auditLogs.list` also carries the note attached to an event, joined under the same predicate and omitted once it has been redacted.
- `dashboard.summary` has no `clerk` audience, because there is no `clerk` role key in this build; the office audience is owner, principal and admin.
- `dashboard.summary` answers a whole home screen per audience rather than a couple of counts, and takes an optional `?date=YYYY-MM-DD` that moves the calendar without widening what is read. A member with more than one role lands on the first home their roles earn (office, accountant, teacher, parent) and may ask for another of their own with `?audience=`; an audience the roles do not earn is `INVALID_REQUEST`. Every block sits behind the permission of the data it is made of, and a block the caller may not read is left out of the response instead of being sent as zero.

## Routes

| Current route | Entry permission and scope | Safe response family | Future owner |
|---|---|---|---|
| `/` | public redirect only | none | Task 6 |
| `/login` | public; no session required | none | Task 6 |
| `/verify-otp` | public; phone one-time code exchange | none | Task 6 |
| `/forgot-password` | public; always answers generically | none | Task 6 |
| `/reset-password` | public; reset token in the link only | none | Task 6 |
| `/test-codes` | public page; test builds only. Held text messages are read with the `HELD_SMS_TOKEN` access code, and the route behind it is absent without that setting | none | Task 11 |
| `/mfa/verify` | pending or active session; second factor challenge | `SessionSummary` | Task 6 |
| `/mfa/setup` | authenticated session; authenticator enrolment | `SessionSummary` | Task 6 |
| `/select-school` | authenticated session; lists own memberships only | `MeResponse` | Task 6 |
| `/accept-invite` | authenticated session; invitation token in the link only | `MemberSummary` | Task 6 |
| `/account/security` | authenticated session; no school context needed | `MeResponse`, `SessionSummary` | Task 6 |
| `/access-unavailable` | authenticated or public failure state | none | Task 6 |
| `/_app` shell | authenticated active membership | `AuthenticatedContext` | Task 6 |
| `/dashboard` | `dashboard.read` / matched template scope, then every block through its own plan | `DashboardByAudience` | Tasks 5, 7, dashboard redesign |
| `/settings/audit-log` | `audit.read` / school or finance | `AuditEventPage` | Tasks 5, 7 |
| `/settings/roles` | `roles.read` / school; mutations also `roles.assign` plus delegation | `FixedRoleSummaryList` | Tasks 4, 7 |
| `/settings/users` | `members.read` / school; lifecycle action permission per action | `MembershipDirectory` | Tasks 4, 7 |
| `/setup/school` | `school.read` / school; update `school.update` | `SchoolProfile` | Tasks 5, 7 |
| `/setup/academic-years` | `academic_years.read` / school; writes `academic_years.manage`; the current-year read is `holidays.read` so every role can ask which year it is | `AcademicYearList` | Tasks 5, 7 |
| `/setup/classes` | `grades.read`, `sections.read` / school; counts `sections.read_strengths`; writes respective manage key | `ClassSectionSetup` | Tasks 5, 7 |
| `/setup/subjects` | `subjects.read` / school; writes `subjects.manage` | `SubjectSetup` | Tasks 5, 7 |
| `/setup/holidays` | `holidays.read` / school; writes `holidays.manage` | `HolidayList` | Tasks 5, 7 |
| `/staff` | `staff.read_directory` / school | `StaffDirectoryPage` | Tasks 5, 7 |
| `/staff/new` | `staff.create` / school | `StaffEmploymentCreated` | Tasks 5, 7 |
| `/staff/:staffId` | `staff.read_employment` / school or self; private/pay projections require separate keys | `StaffDetailByAudience` | Tasks 5, 7 |
| `/students` | `students.read_basic` / school, assigned sections, own children, or finance (audience-specific roster) | `StudentRosterPage` | Tasks 5, 7 |
| `/students/new` | `students.create` / school | `StudentCreated` | Tasks 5, 7 |
| `/students/:studentId` | `students.read_basic` / matched record scope; each sensitive tab checks its own key | `StudentDetailByAudience` | Tasks 5, 7 |
| `/students/import` | `students.import` / school | `StudentImportPreview`, `BulkCommitResult` | Tasks 5, 7 |
| `/students/promote` | `students.promote` / school | `PromotionPreview`, `PromotionResult` | Tasks 5, 7 |
| `/timetable` | `timetable.read` / school or relationship scope; edit/generate uses distinct keys | `SectionTimetable` | Tasks 5, 7 |
| `/timetable/periods` | `timetable.read` / school; write `timetable.manage_periods` | `BellScheduleList` | Tasks 5, 7 |
| `/timetable/substitutions` | `timetable.read` / school; writes `timetable.manage_substitutions` or `notify_substitutions` | `SubstitutionDay` | Tasks 5, 7 |
| `/timetable/teachers` | `timetable.read_teacher_loads` / school and `timetable.read` / school | `TeacherLoadList`, `StaffTimetable` | Tasks 5, 7 |
| `/fees` | `fees.read` / school, finance or own children (a parent sees only their own children); export uses `fees.export` | `FeeDuesPage` | Task 19 |
| `/fees/collections` | `fees.read` / school, finance or own children; export uses `fees.export` | `FeeReceiptPage` | Task 19 |
| `/fees/setup` | `fees.read` / school or finance; writes `fees.manage` | `FeeHeadList`, `FeeStructureList` | Task 19 |
| `/fees/students/:studentId` | `fees.read` / matched record scope; collect uses `fees.collect`, every other write `fees.manage` | `FeeStatement` | Task 19 |
| `/fees/receipts/:receiptId` | `fees.read` / matched record scope; refund and cancel use `fees.manage` | `FeeReceiptDetail` | Task 19 |
| `/attendance` | `attendance.read` / school, assigned sections or own children (a parent sees their own children; a caller with `staff_attendance.read` alone is sent to the staff register) | `AttendanceSectionsResponse` | Task 20 |
| `/attendance/sections/:sectionId` | `attendance.read` / matched record scope; save uses `attendance.record` on today, corrections `attendance.manage` | `AttendanceDayResponse` | Task 20 |
| `/attendance/sections/:sectionId/month` | `attendance.read` / matched record scope; export uses `attendance.export` | `AttendanceSectionMonthResponse` | Task 20 |
| `/attendance/students/:studentId` | `attendance.read` / matched record scope; the PDF is the same read | `AttendanceStudentMonthResponse` | Task 20 |
| `/attendance/staff` | `staff_attendance.read` / school or self; save uses `staff_attendance.record`, corrections `staff_attendance.manage` | `StaffAttendanceDayResponse` | Task 20 |
| `/attendance/staff/month` | `staff_attendance.read` / school or self; export uses `staff_attendance.export` | `StaffAttendanceMonthResponse` | Task 20 |
| `/attendance/staff/:staffId` | `staff_attendance.read` / matched record scope | `StaffAttendanceMemberMonthResponse` | Task 20 |

## API client operations

| Current operation | Permission / scope | Safe response family | Future owner |
|---|---|---|---|
| `schools.list` | platform bootstrap only | `OperatorSchoolList` | Task 1/operator tooling |
| `schools.create` | platform bootstrap only | `OperatorSchoolCreated` | Task 1/operator tooling |
| `schools.get`, `schools.update` | `school.read`, `school.update` / school | `SchoolProfile` | Task 5 |
| `academicYears.list`, `academicYears.current` | `academic_years.read` / school | `AcademicYearList`, `CurrentAcademicYear` | Task 5 |
| `academicYears.create`, `academicYears.update` | `academic_years.manage` / school | `AcademicYear` | Task 5 |
| `grades.list` | `grades.read` / matched scope | `GradeList` | Task 5 |
| `grades.create`, `grades.update`, `grades.remove` | `grades.manage` / school | `Grade`, `EmptySuccess` | Task 5 |
| `sections.list`, `sections.get` | `sections.read` / matched scope | `SectionList`, `SectionDetail` | Task 5 |
| `sections.strengths` | `sections.read_strengths` / school or assigned sections | `AuthorizedSectionCounts` | Task 5 |
| `sections.create`, `sections.update`, `sections.remove` | `sections.manage` / school | `Section`, `EmptySuccess` | Task 5 |
| `subjects.list`, `subjects.gradeSubjects` | `subjects.read` / matched scope | `SubjectList`, `GradeSubjectList` | Task 5 |
| `subjects.create`, `subjects.update`, `subjects.remove`, `subjects.setGradeSubjects` | `subjects.manage` / school | `Subject`, `EmptySuccess` | Task 5 |
| `holidays.list` | `holidays.read` / school | `HolidayList` | Task 5 |
| `holidays.create`, `holidays.update`, `holidays.remove` | `holidays.manage` / school | `Holiday`, `EmptySuccess` | Task 5 |
| `students.list` | `students.read_basic` / school, assigned sections, own children, or finance (audience-specific roster); filters/search limited to visible fields | `StudentRosterPage` | Task 5 |
| `students.get` | `students.read_basic` / school, assigned sections, own children, or own record | `StudentBasicDetail` | Task 5 |
| `students.guardians` | `students.read_guardians` / school, own children, or own record | `GuardianDetailList` | Task 5 |
| `students.siblings` | `students.read_siblings` / school, own children, or own record | `AuthorizedSiblingList` | Task 5 |
| `students.documents` | `students.read_documents` / school, own children, or own record | `StudentDocumentMetadataList` | Task 5 |
| document content download (required replacement) | `students.download_documents` / matched record scope | authenticated file stream | Task 5 |
| `students.enrollments` | `students.read_enrollments` / matched record scope | `EnrollmentSummaryList` | Task 5 |
| `students.create` | `students.create` / school | `StudentCreated` | Task 5 |
| `students.update` | `students.update_basic` or `students.update_sensitive` by allowlisted fields / school | `StudentBasicDetail` | Task 5 |
| `students.move`, `students.markLeft` | `students.manage_enrollment` / school | `EmptySuccess` | Task 5 |
| `students.addGuardian`, `students.updateGuardian` | `students.manage_guardians` / school | `GuardianDetail` | Task 5 |
| `students.importPreview`, `students.importCommit` | `students.import` / school | `StudentImportPreview`, `BulkCommitResult` | Task 5 |
| `students.promote` | `students.promote` / school | `PromotionResult` | Task 5 |
| required student export/search/count replacements | `students.export` or `students.read_basic` / same authorized query predicate | `StudentExportJob`, `StudentSearchResults`, `AuthorizedCount` | Task 5 |
| `staff.list` | `staff.read_directory` / school; search limited to directory fields | `StaffDirectoryPage` | Task 5 |
| `staff.get` | projection keys checked separately: `staff.read_directory`, `read_employment`, `read_private`, `read_pay` | `StaffDetailByAudience` | Task 5 |
| `staff.departments` | `staff.read_directory` / school | `DepartmentSuggestionList` | Task 5 |
| `staff.assignments` | `timetable.read` / school or self | `TeachingAssignmentList` | Task 5 |
| `staff.sectionAssignments` | `timetable.read` / school or assigned sections | `SectionTeachingAssignmentList` | Task 5 |
| `staff.setAssignment` | `staff.manage_assignments` / school | `EmptySuccess` | Task 5 |
| `staff.create` | `staff.create` / school | `StaffEmploymentCreated` | Task 5 |
| `staff.update` | `staff.update_employment`, `update_private`, or `update_pay` by allowlisted fields and scope | `StaffDetailByAudience` | Task 5 |
| required staff export/search/count replacements | `staff.export` or `staff.read_directory` / same authorized query predicate | `StaffExportJob`, `StaffSearchResults`, `AuthorizedCount` | Task 5 |
| `users.list`, `users.get` | `members.read` / school | `MembershipDirectory`, `MembershipDetail` | Task 4 |
| `users.create` | replaced by `members.invite` plus `roles.assign` and delegation / school | `InvitationCreated` | Task 4 |
| `users.update` | replaced by the exact membership lifecycle permission; role change also `roles.assign` and delegation | `MembershipDetail` | Task 4 |
| `roles.list` | `roles.read` / school | `FixedRoleSummaryList` | Task 4 |
| `roles.create`, `roles.update`, `roles.remove` | unavailable: `roles.manage` is reserved | no endpoint | Task 4 contract rejection |
| effective access explanation (required replacement) | `access.explain` / school | `AccessExplanation` | Task 4 |
| `auditLogs.list` | `audit.read` / school or finance; redact by audience | `AuditEventPage` | Task 5 |
| required audit export | `audit.export` / school or finance | `AuditExportJob` | Task 5 |
| `timetable.bellSchedules`, `timetable.bellFor` | `timetable.read` / matched scope | `BellScheduleList`, `BellSchedule` | Task 5 |
| `timetable.saveBellSchedule` | `timetable.manage_periods` / school | `BellSchedule` | Task 5 |
| `timetable.forSection`, `timetable.forStaff` | `timetable.read` / matched section, subject, self, child, or school scope | `SectionTimetable`, `StaffTimetable` | Task 5 |
| `timetable.freeTeachers` | `timetable.manage_entries` or `manage_substitutions` / school | `AvailableTeacherSuggestionList` | Task 5 |
| `timetable.setEntry`, `timetable.clearEntry` | `timetable.manage_entries` / school | `TimetableEntry`, `EmptySuccess` | Task 5 |
| `timetable.generateForSection` | `timetable.generate` / school | `TimetableGenerationResult` | Task 5 |
| `timetable.conflicts` | `timetable.read_conflicts` / school | `TimetableConflictList` | Task 5 |
| `timetable.teacherLoads` | `timetable.read_teacher_loads` / school | `TeacherLoadList` | Task 5 |
| `timetable.substitutions`, `timetable.absentTeacherPeriods` | `timetable.read` / school | `SubstitutionDay`, `AbsentTeacherPeriodList` | Task 5 |
| `timetable.addSubstitution`, `timetable.removeSubstitution` | `timetable.manage_substitutions` / school | `Substitution`, `EmptySuccess` | Task 5 |
| `timetable.markNotified` | `timetable.notify_substitutions` / school | `NotificationMarkResult` | Task 5 |
| `dashboard.summary` | `dashboard.read` / matched audience scope; optional `?date=` and `?audience=` (one of the caller's own homes, else `INVALID_REQUEST`), blocks omitted rather than zeroed | `DashboardByAudience` | Task 5, dashboard redesign, view switcher |

## Operations added after this inventory

The data lifecycle work (Task 12) added operations this inventory never had, because the mock client
had no consent, no anonymisation and no maintenance. Task 13 added one more, and the office feedback
work of September 2026 added the two reveals and the two photograph routes. They are listed here in
the same shape so the inventory stays a complete statement of what the API answers.

| Operation | Permission / scope | Safe response family | Owner |
|---|---|---|---|
| `students.consents` | `students.read_consents` / school or own children | `ConsentList` | Task 12 |
| `students.recordConsent` | `students.manage_consents` / school or own children | `ConsentList` | Task 12 |
| `students.revealApaar` | `students.read_sensitive` / matched record scope; every reveal audited | `StudentApaarReveal` | Task 12 |
| `students.anonymise` | `students.anonymise` / school; privileged | `StudentDetailByAudience` | Task 12 |
| `students.unlinkGuardian` | `students.manage_guardians` / school | `StudentDetailByAudience` | Task 12 |
| `staff.anonymise` | `staff.anonymise` / school; privileged | `StaffDetailByAudience` | Task 12 |
| `auditLogs.redactNote` | `audit.redact_notes` / school; privileged | `{ status: 'redacted' }` | Task 12 |
| maintenance sweep | no membership; `Authorization: Bearer <CRON_SECRET>` only, and the route is absent without it | counts per swept item, now including `access_log` | Task 12, extended by Task 13 |
| `students.revealAadhaar` | `students.read_sensitive` / matched record scope; every reveal audited | `StudentAadhaarReveal` | Office feedback, September 2026 |
| `students.revealGuardianIdentity` | `students.read_guardians` / matched record scope; the guardian must be linked to that student; every reveal audited | `GuardianIdentityReveal` | Office feedback, September 2026 |
| `students.photo` (fetch, upload, remove) | `students.read_basic` to fetch, `students.update_basic` to change / matched record scope | image bytes, or `204`; the record's own `hasPhoto` and `photoUpdatedAt` say what happened | Office feedback, September 2026 |
| `staff.photo` (fetch, upload, remove) | `staff.read_directory` to fetch, `staff.update_private` to change / matched record scope, so a teacher may set their own | image bytes, or `204` | Office feedback, September 2026 |
| `students.subjectAccess` | `students.export_subject` / school for owner and principal, own children for a parent; privileged at school scope | `SubjectAccessExport`, assembled from existing families (`StudentBasic`, `StudentSensitive` with the full APAAR, `StudentMedical`, `GuardianPrivate` or `GuardianContact`, `EnrollmentSummary`, `DocumentSummary`, `ConsentRecord`) | Task 13 |

The fees module (Task 19) added these. Every one is a `protectedRoute` under `/fees`; the route table
with its extra checks is in [protected school APIs](./PROTECTED_APIS.md#fees).

| Operation | Permission / scope | Safe response family | Owner |
|---|---|---|---|
| `fees.heads` (list) | `fees.read` / school or finance; a parent's plan selects none | `FeeHeadList` | Task 19 |
| `fees.createHead`, `fees.updateHead`, `fees.removeHead` | `fees.manage` / school or finance; privileged | `FeeHead`, or `204` | Task 19 |
| `fees.structures` (list) | `fees.read` / school or finance | `FeeStructureList` | Task 19 |
| `fees.createStructure`, `fees.updateStructure`, `fees.removeStructure` | `fees.manage` / school or finance; privileged | `FeeStructure`, or `204` | Task 19 |
| `fees.addOptIn`, `fees.updateOptIn`, `fees.removeOptIn` | `fees.manage` / matched record scope; privileged | `FeeOptIn`, or `204` | Task 19 |
| `fees.addConcession`, `fees.removeConcession` | `fees.manage` / matched record scope; privileged; the reason is an audit note | `FeeConcession`, or `204` | Task 19 |
| `fees.statement` | `fees.read` / school, finance or own children; every read audited | `FeeStatement` | Task 19 |
| `fees.dues` | `fees.read` / the same scopes; totals under the same plan | `FeeDuesPage` | Task 19 |
| `fees.receipts` (list) and `fees.receipt` | `fees.read` / the same scopes; one receipt audited | `FeeReceiptPage`, `FeeReceiptDetail` | Task 19 |
| `fees.collect` | `fees.collect` / school or finance; privileged; the receipt number is assigned by the server | `FeeReceiptDetail` | Task 19 |
| `fees.refund`, `fees.cancelReceipt`, `fees.adjust` | `fees.manage` / matched record scope; privileged; the reason is an audit note | `FeeReceiptDetail` | Task 19 |
| `fees.exportReceipt` | `fees.read` / matched record scope: the same read in another format | `FeeExportJob` | Task 19 |
| `fees.exportDues`, `fees.exportCollections` | `fees.export` / school or finance; privileged | `FeeExportJob` | Task 19 |

The attendance module (Task 20) added these. Every one is a `protectedRoute` under `/attendance` or
`/staff-attendance`; the route table with its extra checks is in
[protected school APIs](./PROTECTED_APIS.md#attendance).

| Operation | Permission / scope | Safe response family | Owner |
|---|---|---|---|
| `attendance.sections` (the day list) | `attendance.read` / school, assigned sections or own children | `AttendanceSectionsResponse` | Task 20 |
| `attendance.day` | `attendance.read` / matched record scope (the section) | `AttendanceDayResponse` | Task 20 |
| `attendance.mark` | `attendance.record` / matched record scope; privileged at school scope; today only, the whole roster | `AttendanceDayResponse` | Task 20 |
| `attendance.correct` | `attendance.manage` / matched record scope; privileged; the reason is an audit note | `AttendanceDayResponse` | Task 20 |
| `attendance.studentMonth` | `attendance.read` / matched record scope (the pupil); every read audited | `AttendanceStudentMonthResponse` | Task 20 |
| `attendance.sectionMonth` | `attendance.read` / matched record scope (the section) | `AttendanceSectionMonthResponse` | Task 20 |
| `attendance.exportSectionMonth` | `attendance.export` / matched record scope; privileged at school scope | `AttendanceExportJob` | Task 20 |
| `attendance.exportStudentMonth` | `attendance.read` / matched record scope: the same read in another format | `AttendanceExportJob` | Task 20 |
| `attendance.staffDay`, `attendance.staffMonth` | `staff_attendance.read` / school or self | `StaffAttendanceDayResponse`, `StaffAttendanceMonthResponse` | Task 20 |
| `attendance.markStaff`, `attendance.correctStaff` | `staff_attendance.record`, `staff_attendance.manage` / school; privileged; never the caller's own row | `StaffAttendanceDayResponse` | Task 20 |
| `attendance.staffMemberMonth` | `staff_attendance.read` / matched record scope; every read audited | `StaffAttendanceMemberMonthResponse` | Task 20 |
| `attendance.exportStaffMonth` | `staff_attendance.export` / school; privileged | `AttendanceExportJob` | Task 20 |

## Read auditing

Task 13 made reads visible in the same trail as writes. A detail read of one person's record leaves
one `allowed` audit row through `auditRead` on the route definition, naming the record and which
blocks were returned: student detail, student guardians, student consents, staff detail, the APAAR
reveal, the Aadhaar reveal, the guardian identity reveal, the subject-access export, and the
document download through its own row. Lists leave none, and so does looking at a photograph.
Every refusal a member receives leaves one `denied` row with the permission and the route pattern,
written outside the transaction that refused. Neither adds a response family and neither changes any
operation above. The full description is in [protected APIs](./PROTECTED_APIS.md#read-auditing-and-denials).

## Coverage constraints

List, detail, joins, suggestions, search, count, pagination, sort, import preview/commit, promotion, and export are all explicit above. A list contains a record only when its corresponding detail predicate permits that record. Bulk writes reject the whole request if any record fails authorization. Inaccessible records use the same safe not-found response family. Parent timetable teacher labels and teacher guardian contact are minimal nested DTOs; neither opens a directory or full related record. The mock client remains unchanged during Task 0.
