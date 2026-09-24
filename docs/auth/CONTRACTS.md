# Auth and RBAC contract handover

Task 0 defines the rules and shared TypeScript contracts for the auth work. It does not implement login, database isolation, authorization middleware or permission-driven screens. The current application still uses mock data and its legacy role switcher.

Read the [implementation plan](../AUTH_RBAC_IMPLEMENTATION_PLAN.md), [permission summary](PERMISSION_MATRIX.md), [exact generated matrix](PERMISSION_MATRIX.generated.md) and [operation coverage](OPERATION_COVERAGE.md) together. The executable catalogue and fixed templates are authoritative for Task 0 defaults where the earlier plan uses broader role descriptions.

## Package boundary

Import schemas and inferred types from `@erp/contracts`. Import trusted server interfaces from `@erp/contracts/server`. Existing shared-package consumers can opt in through `@erp/shared/contracts`; the legacy shared barrel and mock RBAC remain unchanged.

Requests use strict Zod objects: reject unknown keys, including caller-supplied roles, school ownership, access versions outside the specified concurrency field, and bypass flags. Identifiers are opaque strings, timestamps are ISO timestamps with a timezone, dates are calendar dates, and phone numbers use E.164. List inputs are bounded. Mutation versions are positive integers; services must compare them atomically, not merely parse them.

Response schemas are allowlists, not database row serializers. Separate student basic, sensitive and medical data; separate staff directory, employment, private and pay data. Optional response groups must be omitted when unauthorized. A schema accepting a group is not permission to send it. Domain agents may extend validated business fields as needed, but must update coverage and boundary tests when doing so.

`ACCESS_ENDPOINTS` specifies application access routes, schemas and success statuses. Provider login, OTP, MFA and recovery routes are configured in Task 2. Endpoint permission properties are necessary checks, not a complete authorization implementation.

## Login and trusted identity

Staff use email/password. Privileged roles require authenticator MFA before school data access. Teachers without email may use verified phone OTP. This fallback does not bypass MFA when a teacher is later assigned privileged access. Parents use verified phone OTP and approved guardian-child links. Pupils in Class 9 to 12 sign in with the school's login code, their admission number and a password the school texts to the primary guardian (Task 23); the student role reads the pupil's own published learning record and nothing financial or administrative.

The server derives identity from a verified session and reloads the selected school's active membership, roles and access version. A school ID in a URL selects a context; it never proves membership. Never construct `RequestContext` from request JSON or trust browser capabilities as policy. Its TypeScript brand helps prevent accidental construction; it is not a security boundary against malicious code.

School contact changes must not change a person's global verified login email or phone. Credential recovery must verify identity through the auth provider, return no secrets and cannot reset another person's MFA merely because a school administrator requested it. A multi-school identity must not lose other schools' memberships when removed from one school.

## Decision order and scopes

Deny by default. Reject unknown or reserved actions, a student membership carrying anything but the student role, invalid sessions, inactive memberships and mismatched schools before considering a grant. Apply MFA, field restrictions and business-state checks. Then evaluate applicable role grants and approved resource allows; a matching resource deny wins over either. No exception may bypass school isolation, MFA, inactive membership, reserved actions or ownership rules.

Scopes are independent predicates, never a hierarchy:

| Scope | Required relationship |
|---|---|
| `school` | Resource belongs to the selected school. Other checks still apply. |
| `self` | Resource belongs to the staff record linked to this membership, or is that person's own timetable. |
| `assigned_sections` | A current, effective teaching assignment links this member to the resource's section and academic year. |
| `assigned_subjects` | An effective assignment matches both the section and subject, within the same academic year. Teaching a subject elsewhere does not qualify. |
| `own_children` | An approved, active guardian link connects this member to the child in this school. It does not reveal other guardians' private details or unlinked siblings. |
| `own_record` | Resource belongs to the pupil a student membership is linked to (published rows only for results and report cards). |
| `finance` | Resource is in this school and the requested projection is approved for the finance workflow. This is not school-wide access to all fields. On the audit trail it is also a row filter: `audit.read` and `audit.export` select only the actions in `FINANCE_AUDIT_ACTIONS`. |

`FINANCE_AUDIT_ACTIONS` is exported from `@erp/contracts` (with the `FinanceAuditAction` type and the `isFinanceAuditAction` guard). It lists the audit actions a finance audience may read: `staff.update_pay`, `staff.export` and `audit.export` today, with the fee actions joining it when the fees module lands. Membership, role, invitation, student and setup actions are deliberately absent. Change the list here and the scope term, the API and the tests follow.

For teachers, historical enrollment rows are limited to the authorized assignment period; a current assignment must not reveal a child's unrelated historical sections. Parent enrollment summaries remain limited to their linked children. Subject and class labels may be returned only where needed by the authorized view.

Several applicable grants may union their authorized records. They must not combine independent relationships into broader access. Use `privilegedScopes` to decide action-level MFA; the `privileged` flag is descriptive shorthand. Any role with `requiredMfa` requires MFA for school data, even if another role provides a nonprivileged grant.

Filter in the database before pagination, counts, search and aggregates. Apply the same scope to nested joins, exports, file downloads and background jobs. Recheck current membership and access version when a job executes and when a result is downloaded. `AuthorizedReadPlan` is an opaque interface for the future policy engine and repositories, not an implemented query filter.

## Field restrictions

Basic student updates cannot change medical, guardian, enrollment, login or permission fields. Restricted edits require `students.update_sensitive`; medical writes additionally require `students.read_medical`. Apply that additional check to medical fields in admission and import too. An administrator without medical access cannot submit those fields indirectly.

`StudentsAdmitRequest` has no `admissionNumber` and `StaffCreateRequest` has no `employeeCode`: both are strict objects, so a client that sends one is refused with `INVALID_REQUEST`, and the server assigns the value from the school's counter. Both identifiers stay in every response and in search, and no update request carries either. `StudentsBulkImportRow` keeps an optional `admissionNumber` so a school can migrate its old register; `StudentImportPreview` answers with a `rows` list of the rows that passed, each with its sheet row number, name and the admission number it keeps, and a row without one is assigned its number at commit.

Document listing and download require their respective document permissions. A medical document also requires medical access; an identity document requires sensitive-record access. Filter metadata as well as content. Never return storage keys or permanent public URLs. A timetable may contain minimal teacher attribution without granting directory access.

Salary is available by default only to owner and accountant. Private contact and bank projections must be limited to the needs of the matched audience. Audit events must not expose raw before/after objects, credentials, medical data or salary to an audience without the corresponding access.

## Refusal reasons and the screen fields

`ApiError.error` carries an optional `reason` from the closed `ErrorReason` enum: `grade_has_sections`, `subject_has_classes`, `section_has_students` and the rest of the blockers a delete can hit. A reason names a kind of blocker and never a record, a count or a name, so it can be shown to the person who asked without telling them anything the list would not. It is only sent on a refusal the caller was allowed to make; an `ACCESS_DENIED` never carries one.

Task 18 also filled the fields several screens were missing. `MemberListRequest` adds `search`, `role`, `status` and `staffId` to `PageRequest`, strictly, so the directory filters on the server. `GuardianPrivate` requires `version`, so a guardian already on file can be corrected with the usual `expectedVersion`. `StaffEmployment` gains an optional `leavingDate`, so a sheet can tell "never set" from "cleared". `Section` gains an optional `classTeacher` `NamedReference` beside the id it already had. The school profile, academic year, grade, section, subject and holiday shapes all require `allowedActions`, so a setup screen gates a control on the record rather than on a school-wide capability. `AuditEventListRequest` takes `outcome` (`allowed` or `denied`). `StudentsPromotePreviewQuery` takes `page` and `pageSize` (1 and 100 by default, 100 at most) and `PromotionPreview` answers with `total`, `page` and `pageSize`, so a class of any size is read a page at a time.

## Fees

`module-fees.ts` holds every fee request and response. Three rules shape all of it.

Money is whole paise. `FeeAmountPaise` is a positive integer with the same ceiling as the database CHECK, `FeeTotalPaise` may be zero and `FeeBalancePaise` may be negative, because a family can pay ahead of what has fallen due. There is no decimal, no rupee field and no float anywhere; a screen formats for display and nothing else.

A fee head is the school's own: `FeeHead` has a free `name`, a `category` from a closed list that only groups heads, `appliesTo` (`class` for everybody in a class, `opt_in` for a pupil who takes it) and a `frequency`. `FEE_INSTALMENTS_PER_YEAR` says how many instalments a frequency means. `appliesTo` and `frequency` are absent from `FeeHeadUpdateRequest` on purpose: changing either would silently change what every pupil already owes.

The ledger takes no number from a caller. `FeeCollectRequest`, `FeeRefundRequest`, `FeeCancelRequest` and `FeeAdjustmentRequest` are strict objects with no receipt number, no school id and no actor, so an attempt to send one is `INVALID_REQUEST`. A `reason` is required on a concession, a refund, a cancellation and an adjustment, and it exists only in the request: the API writes it to the audit note and no response carries it. `FeeReceiptSummary.state` says what has happened to a payment since (`standing`, `partly_refunded`, `refunded`, `cancelled`), and `reverses` names the row a refund or a cancellation points at.

`FeeStatement` is one pupil in one year: a line per head with `chargedYearPaise`, `concessionYearPaise`, `adjustmentPaise`, `dueToDatePaise`, `paidPaise`, `balancePaise` and `yearBalancePaise`, the totals, the optional fees, the concessions and the ledger rows. `FeeDuesPage` and `FeeReceiptPage` carry `totals` over every row the filters and the caller's plan select, not over the page. `DashboardFees` is the money card block, optional on the office and accountant dashboards, and a parent's child carries an optional `feesDuePaise`. `SubjectAccessExport.fees` is an optional list of statements. Six refusal reasons joined `ErrorReason`: `fee_head_in_use`, `fee_structure_has_payments`, `fee_opt_in_has_payments`, `fee_amount_exceeds_balance`, `fee_receipt_already_reversed` and `fee_nothing_charged`.

`FINANCE_AUDIT_ACTIONS` now lists the four fee keys, so the accountant's audit list is the money trail. `ExportFileFormat` and `ExportJobSummary` moved to `responses.ts` (still re-exported from `response-families.ts`), so a module contract can name them without an import cycle.

## Attendance

`module-attendance.ts` holds every attendance request and response. `AttendanceMark` is the closed list of five marks and `attendancePercentage` is the one rounding rule for the monthly figure, exported so the web and the files draw the number the API sends. `AttendanceSummary` carries the counts (school days, present, absent, late, leave, half day, unmarked) and the percentage, null when there is no school day to count.

The register is one write of the whole roster. `AttendanceMarkRequest` is a list of `{ studentId, mark }` with no date, no section, no school id and no actor: those are the path and the session, and a strict object turns an attempt to send one into `INVALID_REQUEST`. `AttendanceCorrectionRequest` adds a `reason`, which exists only in the request: the API writes it to the audit note and no response carries it. `AttendanceDayResponse.window` says whether this caller may record or correct this day and, when not, why, with a reason from the same closed `ErrorReason` list the refusal would carry, so a screen can say it in the server's words before anybody presses Save. Ten reasons joined the list: `attendance_date_outside_year`, `attendance_not_a_school_day`, `attendance_date_in_future`, `attendance_marking_window_closed`, `attendance_pupil_not_on_roster`, `attendance_roster_incomplete`, `attendance_month_outside_year`, `staff_attendance_own_record`, `staff_attendance_not_on_register` and `staff_attendance_register_incomplete`.

A month is `YYYY-MM`. `AttendanceStudentMonthResponse` is one pupil's calendar and summary; `AttendanceSectionMonthResponse` is a section's register for the month, one row per pupil with a mark per day; the staff register has the same three shapes over `AttendanceStaffMember`, with `self` on the caller's own row. `DashboardAttendance`, `DashboardClassAttendance` and `DashboardChildAttendance` are the optional dashboard blocks, and `SubjectAccessExport.attendance` is an optional list of `AttendanceYearRecord`. Every list in a response is bounded (200 pupils on a roster, 31 days, 500 staff).

## Exams and report cards

`module-exams.ts` and `module-report-cards.ts` hold every Task 21 request and response, and the rules the API, the files and the screens share.

The pattern is code. `EXAM_PATTERN` names the four exams of a year and their components, `EXAM_COMPONENTS` what each is out of (periodic test 10, notebook 5, subject enrichment 5, written 80), `TERM_PATTERN` the two exams of each term and its main exam. No request can change them.

A mark is `MarkValue`: a number from 0 to 80 with at most one decimal place, or one of `absent`, `medical` and `exempt`. `markToTenths` is the only conversion to storage. `scoreParts` is the one scoring rule: absent counts as zero against its maximum; medical, exempt and a component with nothing entered are left out, and the rest is scaled to 100, one decimal, half up. `finalPercentage` is the mean of the two terms (or the one there is), `overallResult` the mean of the subjects' finals and `pass` when every subject reached `EXAM_PASS_PERCENTAGE` (33). `gradeFor` rounds half up to a whole number and takes the band holding it. `gradeBandsProblem` is the check a save of bands must pass (distinct labels, from 100 down to 0, each band ending one below the next one up), and `DEFAULT_GRADE_BANDS` is the CBSE 8-point scale. `DEFAULT_REPORT_CARD_LAYOUT` shows the logo and all four header lines, all five blocks in order, and three signatures: class teacher, principal, parent.

The marks sheet is one write. `ExamMarksSaveRequest.entries` lists every filled cell as `{ studentId, component, value }`, each cell once, and an optional `change: { reasonKind, reason }` that a save changing an already-saved cell must carry. `ExamMarksCorrectionRequest` always carries both. Neither names an exam, a section, a subject, a school or an actor: those are the path and the session. The `reason` exists only in the request; the API writes it to the audit note. `ExamPaperSummary.window` says what this caller may do with the paper today (`state` by the dates, `record` and `correct`, and the reason when not), so the screen says it in the server's words before anybody presses Save.

`ResultView` is `staff` or `family`, decided on the server; `ResultDisplayMode` is the school's `marks` or `grades`. In a family view under grades, `ExamResultsResponse` and `ReportCardView` carry grades only: every component value and percentage is taken out by the API, not hidden by a screen. `ReportCardContent` is the frozen content of a published card, parsed on the way in and on the way out; remarks travel beside it as `ReportCardRemarks`. `ExamSettings.version` is 0 while a school uses the defaults, and `ExamSettingsUpdateRequest.expectedVersion` is 0 for the first save.

Nineteen reasons joined `ErrorReason`: `exam_dates_outside_year`, `exam_already_published`, `exam_nothing_to_publish`, `exam_not_started`, `exam_recheck_deadline_passed`, `exam_change_needs_reason`, `exam_mark_above_maximum`, `exam_component_not_in_exam`, `exam_pupil_not_on_roster`, `exam_publish_before_deadline`, `exam_section_incomplete`, `grade_bands_overlap`, `grade_bands_gap`, `grade_bands_out_of_range`, `grade_bands_duplicate_label`, `report_card_exams_not_published`, `report_card_exams_changed`, `report_card_nothing_to_publish` and `report_card_pupil_not_on_roster`. `SchoolProfile.logo` says whether a logo exists and when it changed; the bytes come from their own route. The dashboard gains `DashboardMarksToEnter` (teacher), `DashboardExams` (office) and `DashboardReportCard` (a parent's child), and `SubjectAccessExport` gains `exams` and `reportCards`, all optional.

The nine exam and report card permissions are active. `exams.record_marks`, `exams.export`, `report_cards.manage` and `report_cards.export` are privileged at school scope only, so a teacher enters their marks and a parent downloads their child's card on one factor, while the office does both behind a second step; `exams.manage`, `exams.publish` and `report_cards.publish` are privileged at their only scope. The permission matrix is regenerated from the catalogue.

## Messages

`module-communication.ts` holds every Task 22 request and response and the wording rules the API, the pump and the screens share. `MessageKind` is `notice` plus the seven automatic kinds; `MessageAudienceInput` is what a person may choose (`school`, `staff`, `grade`, `section`, `pupil`), and `staff_member` exists only for the school's own birthday wishes. `MessageStatus` is `draft`, `scheduled`, `sent`, `withdrawn` or `cancelled`; `RecipientOutcome` is `delivered`, `no_consent`, `not_receiving` or `no_contact`; `EmailStatus` is `none`, `pending`, `sent`, `failed` or `cancelled`. Placeholders are words in braces: `MESSAGE_PLACEHOLDERS` names them, `PLACEHOLDERS_BY_KIND` says which each kind may use, `unknownPlaceholders` refuses the rest (a notice names a pupil only when it goes to one pupil's family) and `renderMessageText` fills them once, when a message is written. `DEFAULT_MESSAGE_WORDING` is the built-in wording of each automatic kind and `DEFAULT_COMMUNICATION_SETTINGS` the defaults of the settings. The limits (`MESSAGE_ATTACHMENT_MAX_BYTES` 2 MB, `MESSAGE_ATTACHMENTS_MAX` 3, a schedule from 5 minutes to 60 days, five email attempts) are constants here. `MessageDetail.counts` and the recipient list are present only for the author and a reader who reaches the message other than as a recipient; `myReceipt` only for a recipient. `SubjectAccessExport.messages` is the new optional block. Eleven reasons joined `ErrorReason`, all starting `message_`. The four `communication.*` keys are active; `communication.read` gained the `self` scope and `communication.send` is privileged at school scope only, so a teacher writes to their own sections with one factor.

## Consent, retention and anonymisation

`module-lifecycle.ts` holds the data lifecycle contracts. Five permissions go with them: `students.read_consents` and `students.manage_consents` over a student at `school` or `own_children`, `students.anonymise` over a student, `staff.anonymise` over a staff record and `audit.redact_notes` over an audit event, the last three at `school` scope and privileged. Owner holds all five, principal all but the redaction, administrator the two consent keys at school scope and parent the two at `own_children`. Teacher, accountant and student hold none.

`CONSENT_PURPOSES` is a closed list of five: education records, health information, photographs, communication and third-party services. A `ConsentRecord` is one event — guardian, purpose, `given` or `withdrawn`, the method (`in_person`, `signed_form` or `portal`), an optional evidence reference and who recorded it, `office` or `guardian`. `ConsentList` returns only the newest row per guardian and purpose, because that is the current answer; the history behind it is a table, not a response. Recording answers with the whole `ConsentList` and 200, since the screen needs the current answer for every purpose after a write, not the one row it sent. `RecordConsentRequest` is the same shape without the derived fields, and `AdmitConsent` carries a `guardianIndex` into the admission request's own `guardians` array, since the guardians have no ids yet; an index outside that array is `INVALID_REQUEST`.

`StudentSensitive` carries `apaarMasked` (`XXXX-XXXX-1234`) and no longer carries the full APAAR id at all. `StudentApaarReveal` is the one schema that does, answered only by the audited reveal route. Write requests still take `apaarId` as trimmed input, because the school types the number once.

`AnonymiseRequest` and `UnlinkGuardianRequest` are `{ expectedVersion, reason }`; the version is always the student's or the staff record's, and the reason becomes a note rather than an audit field. `RedactAuditNoteRequest` is `{ reason }`, and that reason is deliberately not stored. `AuditEventSummary` gains an optional `note`, and `StudentBasic` and `StaffDirectory` gain a required `anonymised` flag, so a screen can tell an empty record from a cleared one.

`RETENTION` is the schedule as numbers: three years of student sensitive fields after leaving, eight years of staff private and pay fields, thirty days of credentials after the last membership ends, ninety days for invitations and outbox rows, twenty-four hours for import previews. The API, the sweep and the screens all read the same constants, so no period is written down twice. They are the earliest moment an anonymisation may be taken, not an automatic deletion.

## Inviting, changing and removing members

Role assignment needs both `roles.assign` and `ROLE_DELEGATION_RULES`. Membership lifecycle actions also need `ROLE_MANAGEMENT_RULES`. Check every current role on the target and every proposed role. Principal and admin can manage teacher-only targets; a target who is both teacher and owner does not qualify. Deny self-service privilege changes. Generic role assignment cannot create an owner or enable a student.

Invite, resend and restore recheck assignment authority. Store hashed invitation tokens, bind them to the normalized verified destination, school and proposed roles, and enforce expiry and single use. Acceptance must recheck the inviter's current authority and the school's current state. Resend rotates the token; it cannot revive a revoked, accepted or expired invitation. Mask destinations in management responses. Link an existing staff record before activating a staff login; verify parent links separately.

Suspending or removing a school membership immediately invalidates that school's access and queued work. Restore explicitly reviews roles instead of silently restoring old privileges. Lock and compare versions in the transaction, increment access versions, invalidate caches and write audit events with the change. Keep employment records and historical audit records when removing login access.

Ownership transfer is a separate transaction requiring fresh MFA, a verified active adult target and a last-owner lock. It cannot be emulated through role assignment, removal, suspension or a resource exception. The DB and service tasks must implement the session freshness policy and concurrent last-owner tests before exposing this route.

## Resource exceptions

`ResourceAccessRule` defines a limited future allow/deny record with school, membership, action, typed target, validity window, revocation, author, reason and version. Target/action compatibility is validated. No public exception editor or active `access.manage` grant is included. Task 3 implements evaluation; a later feature can add administration without replacing the role model. Any future writer must verify grant authority and all referenced records' school membership.

## Implementation baseline

Use PostgreSQL with Drizzle for the next database task, and Node with Fastify and Better Auth for backend/auth work. Tenant foreign keys, scoped queries and PostgreSQL row-level security must reinforce each other. Application database roles must not bypass RLS. Auth-provider tables do not replace school membership and permission tables.

The workspace was checked with Node 24.15.0, pnpm 10.34.4, TypeScript 6.0.3 and Zod 4.5.4. Zod and TypeScript are pinned for this package. Package metadata reviewed during planning identified Fastify 5.12.4, Better Auth 1.7.4, Drizzle ORM 0.45.2 and pg 8.23.0 as a candidate backend baseline. Those backend packages are not installed or integration-tested by Task 0. Task 2 must pin its final versions and test sessions, OTP, MFA, the Drizzle adapter and transaction behavior together before proceeding.

## Checks and next owners

Run `pnpm test:contracts`, `pnpm typecheck`, `pnpm lint` and `pnpm build:web`. After changing the catalogue or templates, run `pnpm --filter @erp/contracts docs:generate`. Tests check schema boundaries, role defaults, delegation envelopes, generated-matrix drift and coverage of current mock operations and routes. These are contract tests; they do not prove live tenant isolation.

Task 1 implements PostgreSQL schema, tenant constraints and RLS. Task 2 implements verified sessions and login methods. Task 3 implements the authorization evaluator and scoped repositories. Task 4 implements membership workflows. Task 5 replaces mock APIs with protected endpoints and safe projections. Tasks 6 and 7 integrate session state and permission-driven UI. Task 8 makes admission numbers and employee codes server-assigned. Task 9 proves cross-school, cross-person, field, export, concurrency and revocation boundaries against the running stack.

`module-student-logins.ts` (Task 23) holds the pupil login contracts: `StudentSignInRequest` (`schoolCode`, `admissionNumber`, `password`, `sharedDevice?`, strict) and `StudentSignInResponse`; `StudentLoginView`, the office's view of one pupil's login (state `none`, `active`, `switched_off`, `ended`; the admission number as username; a `blocker` of `not_on_roll`, `not_senior` or `no_guardian_phone`; the guardian phone masked; never a password or the generated address); the switch requests; `IssueStudentLoginsResult` (counts only); `STUDENT_LOGIN_LEVELS` (9 to 12) and `STUDENT_PLACEHOLDER_EMAIL_DOMAIN`. One new permission, `students.manage_login` (student, school, privileged), for owner, principal and admin. `SessionSummary.passwordChangeRequired`, `SchoolContextResponse.ownStudentId` and the `PASSWORD_CHANGE_REQUIRED` error code carry the first-sign-in rule. `GradeInput.level`, the `student` dashboard audience (`StudentDashboard`), and on messages `MessageRecipients`, the `grade_range` audience, `pupils` counts and the `student` recipient kind complete it.
