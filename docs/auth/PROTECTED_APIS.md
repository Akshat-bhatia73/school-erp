# Protected school APIs: setup, students, staff, timetable and the rest

Task 5 adds `apps/api/src/modules`: the read and write endpoints for the records a school keeps about itself, its pupils, its people and its week. It sits on the Task 2 session service and the Task 3 policy service, so every route is decided by [the policy service](./AUTHORIZATION.md), every list is bounded by the same predicate its detail read uses, and every write is recorded in the audit log exactly as [access management](./ACCESS_MANAGEMENT.md) does. The operations it replaces are the mock client operations inventoried in [operation coverage](./OPERATION_COVERAGE.md). It is defined in [the implementation plan](../AUTH_RBAC_IMPLEMENTATION_PLAN.md) (sections 9 and 13, and the Task 5 checklist).

Source files: [modules/index.ts](../../apps/api/src/modules/index.ts), [modules/shared](../../apps/api/src/modules/shared) (`route.ts`, `authorize.ts`, `audit.ts`, `version.ts`, `errors.ts`), then one folder per module: [setup](../../apps/api/src/modules/setup), [students](../../apps/api/src/modules/students), [students-bulk](../../apps/api/src/modules/students-bulk), [staff](../../apps/api/src/modules/staff), [timetable](../../apps/api/src/modules/timetable), [dashboard](../../apps/api/src/modules/dashboard), [search](../../apps/api/src/modules/search), [audit](../../apps/api/src/modules/audit), [files](../../apps/api/src/modules/files). Their request and response contracts are the `module-*.ts` files in [`@erp/contracts`](./CONTRACTS.md).

## Scope

In scope: school profile and academic setup, the student roster and one student's record, bulk admission and promotion, the staff directory and one person's record, the timetable and its substitutions, the dashboard, the command-menu search, the audit log, export jobs and the private document download. Eighty-three routes in nine modules: eighty-one through the shared route helper and two registered by hand in the files module.

Out of scope, deliberately. There is no web UI: nothing in `apps/web` calls any of these routes, and the web app still runs on its mock client, which is Tasks 6 to 8. There is no attendance, fee, exam or communication module; those screens do not exist in the mock either. No export produces a file: an export endpoint records a job and the producer and the download of its bytes are later work. There is no custom role and no new permission: the catalogue is the fixed one in `@erp/contracts`, and a route that names a reserved permission fails at startup. Nothing here changes a membership, a role or an exception; that is access management, and a module that needs a parent to reach a new child has to ask for it there.

## The route helper and the gate

`protectedRoute(app, deps, definition)` in [`modules/shared/route.ts`](../../apps/api/src/modules/shared/route.ts) is the only way a module registers a route. A definition names a method, a path, one permission, an optional query schema, an optional body schema, a response schema and a handler. Five things happen around every handler, and none of them is a module's to skip.

1. At startup the declared permission is checked against `PERMISSION_CATALOGUE`. An unknown or reserved key throws before the server listens, so a route that could never be authorized never exists.
2. `requireMembership` runs as the preHandler, so a session, an active membership in the path school, the access version check and the role level MFA rule are already satisfied. An anonymous caller is `AUTHENTICATION_REQUIRED`; a member of another school using this school in the path is `SCHOOL_ACCESS_UNAVAILABLE`.
3. The declared permission is decided against the school as a whole, in its own short transaction, before the handler starts. A member who holds it nowhere is refused with the evaluator's own code, usually `ACCESS_DENIED` and sometimes `MFA_REQUIRED`. This gate is the floor, never the ceiling.
4. The query string and the body are parsed. Query values arrive as strings and only the keys the schema declares numeric are converted, so a schema stays the single description of a query. Every body and query contract is a `z.strictObject`, so an unknown key, including `schoolId`, is `INVALID_REQUEST` before the handler sees it.
5. The handler's result is parsed through the response schema before it is sent. A mismatch is logged and answered `SERVICE_UNAVAILABLE`: an unexpected field is a leak, so the unchecked object is never sent. Optional fields are omitted rather than sent as null unless the contract says nullable.

Two routes are registered by hand instead, both in the files module, and both still run `requireMembership` and an aggregate decision of their own: the document download streams bytes and so has no parseable response contract, and the export status route cannot name one gate permission without excluding the staff or audit exporter.

## The read protocol

A handler opens exactly one `withTenantTransaction(deps.pools.runtime, context, ...)` and decides everything inside it.

`readPlan(conn, context, permission, resourceType)` builds the caller's plan for that permission, and `planPredicate(plan, scopedTableFor(resourceType))` turns it into the SQL boolean the query must AND into its `WHERE` clause. The predicate already pins `school_id`, adds the scope terms the caller's grants allow, and subtracts every deny exception, so a list, a count, a search, an export candidate set and a detail read all agree by construction. Nothing is ever fetched school-wide and filtered in JavaScript. **A list contains a row if and only if the matching detail read allows it**, and the test suites are written to fail if a predicate is removed.

Where one read exposes more than one record kind, it builds more than one plan. A student hit carries its class only when the caller also passes the `students.read_enrollments` plan on `enrollment`; the curriculum list ANDs a `subjects.read` plan and a `grades.read` plan; the substitution day is bounded by the covering timetable entry the caller may read. A caller who holds the extra permission nowhere gets the record without that block, not a refusal, because the gate permission of the route is the one the caller asked for.

A single record that the plan does not reach is `RESOURCE_NOT_FOUND`, never `ACCESS_DENIED`: a 403 on a real id and a 404 on an invented one is an existence oracle, so record-scoped reads and writes report both the same way. A module-level refusal, decided before any id is involved, stays `ACCESS_DENIED`. An identifier of the wrong shape in a path is `RESOURCE_NOT_FOUND`; a malformed value in a query filter or a body reference is `INVALID_REQUEST`, because that is bad input rather than a missing collection.

`allowedActionsFor(conn, context, { schoolId, resourceType, id })` fills the `allowedActions` field of a detail response, and `decideAction(..., aggregate: true)` does the same for a view that is not one row, such as a section's timetable.

## The write protocol

Every write follows the same order inside one tenant transaction, mirroring access management.

1. `lockSchool(conn, schoolId)` before a write that touches more than one row, so two writers in one school serialise.
2. Decide again inside the transaction: `authorizeSchoolAction` for a school-wide action, `authorizeResource` or `decideResource` for a named record. The gate decided the module action; this decides the record.
3. Validate the proposed new state. Every section, grade, subject, academic year, staff member, guardian or student a body names must exist in this school and must fit the row it is going into. A cross-school or unknown reference is `INVALID_REQUEST`, never a database error turned into a 503. A leaving date before a joining date, a move across academic years, a delete of a record something still points at and a teacher who is already busy in that period are all refused the same way.
4. Take the optimistic lock. `bumpVersion(conn, table, { schoolId, id, expectedVersion, set })` writes and increments in one statement; a caller who read an older row gets `VERSION_CONFLICT`. Two tables have no version column, so their update compares a version derived from `updated_at` instead (see the gaps).
5. `writeAudit(conn, context, ...)` exactly once per committed write, in the same transaction. The summary is plain English and `safe_changes` carries ids, keys, counts and statuses, never a name, a date of birth, a phone number, an address, an amount, a storage key or a token.
6. Return committed state, parsed through the response contract.

A bulk write authorizes every id before the first row changes and rejects the whole request if any one fails, so there is no partial write. The grade-subject replacement, the import commit, the promotion and both export endpoints are written that way and tested for it.

Bodies are allowlists, not filters. No endpoint accepts `schoolId`, the actor's own ids, a version it does not own, a salary, a role key or a relationship field unless its permission covers exactly that field group. Field groups that need their own key get their own endpoint: a student's basic and sensitive updates are two routes, and a staff record's employment, private and pay updates are three.

## Endpoints

All paths are under `/api/schools/:schoolId`. The permission column is the gate permission; the extra checks column is what the handler decides beyond it. Every route can answer `AUTHENTICATION_REQUIRED`, `SCHOOL_ACCESS_UNAVAILABLE` and `ACCESS_DENIED`, so those are not repeated per row.

### Setup

| Method and path | Permission | Extra checks | Success | Error codes |
|---|---|---|---|---|
| `GET /school` | `school.read` | none | 200 | — |
| `PUT /school` | `school.update` | derived version from the last save | 200 | `INVALID_REQUEST`, `VERSION_CONFLICT` |
| `GET /academic-years` | `academic_years.read` | plan predicate | 200 | — |
| `GET /academic-years/current` | `academic_years.read` | plan predicate | 200 | `RESOURCE_NOT_FOUND` |
| `POST /academic-years` | `academic_years.manage` | dates ordered, one current year | 201 | `INVALID_REQUEST` |
| `PUT /academic-years/:academicYearId` | `academic_years.manage` | the same, plus `expectedVersion` | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `GET /grades` | `grades.read` | plan predicate | 200 | — |
| `POST /grades` | `grades.manage` | unique name and short name | 201 | `INVALID_REQUEST` |
| `PUT /grades/:gradeId` | `grades.manage` | `expectedVersion` | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `DELETE /grades/:gradeId` | `grades.manage` | nothing may still refer to it | 204 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `GET /sections` | `sections.read` | plan predicate; filters must be ids | 200 | `INVALID_REQUEST` |
| `GET /sections/strengths` | `sections.read_strengths` | plan predicate; counts only visible sections | 200 | `INVALID_REQUEST` |
| `GET /sections/:sectionId` | `sections.read` | plan predicate | 200 | `RESOURCE_NOT_FOUND` |
| `POST /sections` | `sections.manage` | year, grade and class teacher in this school | 201 | `INVALID_REQUEST` |
| `PUT /sections/:sectionId` | `sections.manage` | the same, plus `expectedVersion`; no re-parenting once it holds rows | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `DELETE /sections/:sectionId` | `sections.manage` | nothing may still refer to it | 204 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `GET /subjects` | `subjects.read` | plan predicate | 200 | — |
| `GET /grade-subjects` | `subjects.read` | `subjects.read` and `grades.read` plans, both ANDed | 200 | `INVALID_REQUEST` |
| `POST /subjects` | `subjects.manage` | unique code | 201 | `INVALID_REQUEST` |
| `PUT /subjects/:subjectId` | `subjects.manage` | `expectedVersion` | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `DELETE /subjects/:subjectId` | `subjects.manage` | nothing may still refer to it | 204 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `PUT /grades/:gradeId/subjects` | `subjects.manage` | whole-set replace; every id validated before the first delete | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `GET /holidays` | `holidays.read` | plan predicate | 200 | `INVALID_REQUEST` |
| `POST /holidays` | `holidays.manage` | year in this school | 201 | `INVALID_REQUEST` |
| `PUT /holidays/:holidayId` | `holidays.manage` | derived version from the last save | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `DELETE /holidays/:holidayId` | `holidays.manage` | none | 204 | `RESOURCE_NOT_FOUND` |

### Students

| Method and path | Permission | Extra checks | Success | Error codes |
|---|---|---|---|---|
| `GET /students` | `students.read_basic` | plan predicate; enrolment block needs `students.read_enrollments` | 200 | `INVALID_REQUEST` |
| `GET /students/count` | `students.read_basic` | the same predicate as the list | 200 | `INVALID_REQUEST` |
| `GET /students/search` | `students.read_basic` | the same predicate, capped at 20 | 200 | `INVALID_REQUEST` |
| `GET /students/:studentId` | `students.read_basic` | `read_sensitive`, `read_medical` and `read_guardian_contact` decided per block | 200 | `RESOURCE_NOT_FOUND` |
| `GET /students/:studentId/guardians` | `students.read_guardians` | student visible first, then the guardian plan | 200 | `RESOURCE_NOT_FOUND` |
| `GET /students/:studentId/siblings` | `students.read_siblings` | every sibling re-checked under `students.read_basic` | 200 | `RESOURCE_NOT_FOUND` |
| `GET /students/:studentId/documents` | `students.read_documents` | document plan; `allowedActions` per row | 200 | `RESOURCE_NOT_FOUND` |
| `GET /students/:studentId/enrollments` | `students.read_enrollments` | enrolment plan | 200 | `RESOURCE_NOT_FOUND` |
| `POST /students` | `students.create` | section in this school; an existing guardian also needs `students.manage_guardians` | 201 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `PUT /students/:studentId` | `students.update_basic` | `expectedVersion` | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `PUT /students/:studentId/sensitive` | `students.update_sensitive` | medical fields also need `students.read_medical` | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `POST /students/:studentId/move` | `students.manage_enrollment` | target section in this school and this year; roll number kept when omitted | 204 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `POST /students/:studentId/leave` | `students.manage_enrollment` | leaving date not before the joining date; reason stored and audited | 204 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `POST /students/:studentId/guardians` | `students.manage_guardians` | named guardian decided per record; one primary per student | 201 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `PUT /students/:studentId/guardians/:guardianId` | `students.manage_guardians` | the link must exist | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |

### Students in bulk

| Method and path | Permission | Extra checks | Success | Error codes |
|---|---|---|---|---|
| `POST /students/import/preview` | `students.import` | every row validated server-side; only valid rows are staged, for one hour | 201 | `INVALID_REQUEST` |
| `POST /students/import/commit` | `students.import` | preview pending, unexpired, this school, same author, `expectedVersion`; every row re-validated before the first insert | 201 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `GET /students/promote/preview` | `students.promote` | roster bounded by the `students.read_basic` plan | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `POST /students/promote` | `students.promote` | every named pupil distinct and currently seated in that class, with no open enrolment next year | 200 | `INVALID_REQUEST` |
| `POST /students/export` | `students.export` | every requested id must pass the export plan, or none is written | 202 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |

### Staff

| Method and path | Permission | Extra checks | Success | Error codes |
|---|---|---|---|---|
| `GET /staff` | `staff.read_directory` | plan predicate | 200 | `INVALID_REQUEST` |
| `GET /staff/count` | `staff.read_directory` | the same predicate | 200 | — |
| `GET /staff/search` | `staff.read_directory` | the same predicate, directory fields only | 200 | `INVALID_REQUEST` |
| `GET /staff/departments` | `staff.read_directory` | the same predicate | 200 | — |
| `GET /staff/:staffId` | `staff.read_directory` | `read_employment`, `read_private` and `read_pay` decided per block | 200 | `RESOURCE_NOT_FOUND` |
| `GET /staff/:staffId/assignments` | `staff.read_employment` | that record decided, denial reported as not found | 200 | `RESOURCE_NOT_FOUND` |
| `GET /sections/:sectionId/assignments` | `sections.read` | that section decided, denial reported as not found | 200 | `RESOURCE_NOT_FOUND` |
| `PUT /staff/:staffId/assignments` | `staff.manage_assignments` | staff, year, subject and section-in-year all in this school; `expectedVersion` on the staff row | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `DELETE /staff/:staffId/assignments/:assignmentId` | `staff.manage_assignments` | the assignment must belong to that staff member | 204 | `RESOURCE_NOT_FOUND` |
| `POST /staff` | `staff.create` | employee code free, school locked first | 201 | `INVALID_REQUEST` |
| `PUT /staff/:staffId/employment` | `staff.update_employment` | leaving date not before the stored joining date; `expectedVersion` | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `PUT /staff/:staffId/private` | `staff.update_private` | that record decided, so the self scope works | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `PUT /staff/:staffId/pay` | `staff.update_pay` | audit row carries the reason and never the amount | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `POST /staff/export` | `staff.export` | every requested id must pass the export plan, or none is written | 202 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |

### Timetable

| Method and path | Permission | Extra checks | Success | Error codes |
|---|---|---|---|---|
| `GET /timetable/bell-schedules` | `timetable.read` | school setup, decided school-wide | 200 | `INVALID_REQUEST` |
| `GET /timetable/bell-schedules/for-grade/:gradeId` | `timetable.read` | the same | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `POST /timetable/bell-schedules` | `timetable.manage_periods` | periods ordered, grades in this school | 201 | `INVALID_REQUEST` |
| `PUT /timetable/bell-schedules/:bellScheduleId` | `timetable.manage_periods` | the table holds no version, so only version 1 is accepted | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `GET /timetable/sections/:sectionId` | `timetable.read` | entry plan predicate; `sections.read` justifies an empty grid | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `GET /timetable/staff/:staffId` | `timetable.read` | entry plan predicate; `staff.read_directory` justifies an empty week | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `GET /timetable/free-teachers` | `timetable.manage_entries` | `manage_entries` or `manage_substitutions` inside the handler | 200 | `INVALID_REQUEST` |
| `PUT /timetable/entries` | `timetable.manage_entries` | section, subject, staff and year in this school; the teacher must be assigned and free | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `DELETE /timetable/entries` | `timetable.manage_entries` | the slot must exist | 204 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `POST /timetable/sections/:sectionId/generate` | `timetable.generate` | existing entries kept; only active, assigned teachers placed | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `GET /timetable/conflicts` | `timetable.read_conflicts` | entry plan predicate | 200 | `INVALID_REQUEST` |
| `GET /timetable/teacher-loads` | `timetable.read_teacher_loads` | entry plan predicate | 200 | `INVALID_REQUEST` |
| `GET /timetable/substitutions` | `timetable.read` | bounded by the covering entry the caller may read | 200 | `INVALID_REQUEST` |
| `GET /timetable/substitutions/absent-periods` | `timetable.manage_substitutions` | the date must fall in an academic year of this school | 200 | `INVALID_REQUEST` |
| `POST /timetable/substitutions` | `timetable.manage_substitutions` | stand-in free in that period, absent teacher scheduled | 201 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `DELETE /timetable/substitutions/:substitutionId` | `timetable.manage_substitutions` | the row must exist | 204 | `RESOURCE_NOT_FOUND` |
| `POST /timetable/substitutions/notify` | `timetable.notify_substitutions` | audits only when it actually marked something | 200 | `INVALID_REQUEST` |

### Dashboard, search, audit and files

| Method and path | Permission | Extra checks | Success | Error codes |
|---|---|---|---|---|
| `GET /dashboard` | `dashboard.read` | audience fixed from the caller's roles; every figure through its own plan | 200 | — |
| `GET /search?q=` | `students.read_basic` | student rows through `students.read_basic`, staff rows through `staff.read_directory`, the class through `students.read_enrollments` | 200 | `INVALID_REQUEST` |
| `GET /audit-events` | `audit.read` | plan predicate on `audit_event`; filters only narrow it | 200 | `INVALID_REQUEST` |
| `POST /audit-events/export` | `audit.export` | window ordered and at most 366 days | 202 | `INVALID_REQUEST` |
| `GET /students/:studentId/documents/:documentId/content` | `students.download_documents` | record decided again; the document must belong to that student | 200, a byte stream | `RESOURCE_NOT_FOUND` |
| `GET /exports/:jobId` | one of `students.export`, `staff.export`, `audit.export` | the job's own recorded permission re-decided, plus freshness | 200 | `RESOURCE_NOT_FOUND` |

## Projection rules per field group

A response carries a field group only when the caller holds the key for that group, decided against that record, and never as a side effect of holding a different key.

- **Student basic** (`students.read_basic`): id, name, admission number, status and version. The class summary rides along only when the `students.read_enrollments` plan also allows that enrolment row.
- **Student sensitive** (`students.read_sensitive`): date of birth, gender and admission date, as one block that is present or absent.
- **Student medical** (`students.read_medical`): blood group and medical notes, a separate block and a separate write check.
- **Guardian contact** (`students.read_guardian_contact`): a minimal contact, never a guardian directory.
- **Student documents** (`students.read_documents`): metadata only. The storage key is server state and appears in no body, no header, no log line and no error.
- **Staff directory** (`staff.read_directory`): display name, designation and department. Nothing else.
- **Staff employment, private and pay** (`staff.read_employment`, `read_private`, `read_pay`): three separate blocks behind three separate keys, each decided on that record, so a teacher reads their own employment and contact and never anybody's pay.
- **Audit events** (`audit.read`): time, actor label, action, summary and outcome. `safe_changes`, target ids, the request id and the actor ids are read by the handler and never projected.
- **Nested references** everywhere else are a `NamedReference`: an id and a label, so a parent seeing a teacher's name on a period does not thereby get a staff directory.

A stored value the contract cannot carry drops its block rather than failing the request, with two exceptions: an audit action or summary is projected verbatim, because a value that outgrew the contract should be loud rather than quietly truncated.

## Jobs: import preview and export

An import preview validates the sheet server-side, stages only the rows that passed together with the errors for the rest, and expires in an hour. The client cannot mark a row valid; there is no such field in the contract. The commit locks the school, takes `FOR UPDATE` on the preview, checks it is pending, unexpired, in this school, created by this membership and at the stated version, re-validates every stored row, and only then inserts. A row that has become impossible since the preview, usually an admission number taken meanwhile, rejects the whole commit with nothing written.

An export endpoint records a job and no file. It counts the requested ids through the export plan in SQL and refuses the whole set if any one is unreachable, then writes an `export_jobs` row carrying the permission it was authorized under, the caller's access version, the criteria, a row count and an expiry. `GET /exports/:jobId` re-decides that recorded permission on every poll and answers `expired`, persisting it, when the job has aged out, when the caller's access version has moved, when the recorded permission is no longer known or when the caller may no longer do that thing. A job of another membership is `RESOURCE_NOT_FOUND`; its existence is never revealed.

## Document download

`GET /students/:studentId/documents/:documentId/content` is the only route that returns bytes. It decides the module action, then the record, and reports every denial as `RESOURCE_NOT_FOUND` so that a real id and an invented one look the same. The document must belong to the student in the path, or it is not found. Missing bytes roll the transaction back and write no audit row: nothing was delivered, so there is no download to record, and a caller cannot write audit rows by guessing ids. A successful read writes exactly one audit row and commits before the stream is attached, so the record says an authorized read began, not that the transfer finished. The filename in the `content-disposition` header is sanitised of newlines, quotes, backslashes and non-printable characters, the response is `no-store`, and the storage key never leaves the server.

## What is deliberately not built

- No web UI and no change to the mock client. Tasks 6 to 8 own that.
- No export producer and no export download. A job is a record of an authorized request; its bytes are later work, and whoever writes the producer has to repeat the freshness checks before handing anything over.
- No attendance, fee, exam, communication or report module.
- No new permission, no custom role and no membership change. A module that needs a parent linked to a new child has to ask access management for it.
- No expiry sweeper for staged previews or export jobs: both are refused when used, and nothing collects them.
- No audience redaction inside the audit log beyond the row-level plan.

## Known gaps

Storage and contract mismatches:

- `schools` and `holidays` have no version column, so their updates compare a version derived from `updated_at` at microsecond granularity. Both paths lock the school first, so they are serialised, but a real version column is the better answer and needs a migration.
- `bell_schedules` has no version column either, and its update refuses any `expectedVersion` other than 1 rather than pretending to check. `PUT /grades/:gradeId/subjects` carries no version at all; the whole-set replace plus the pre-write validation is its concurrency story.
- `bell_schedules.grade_ids` is forbidden by a check constraint, so the grade mapping lives in `bell_schedule_grades`.
- `schools.address` and `students.address` and `staff.address` are `jsonb`. A string value is returned as text; any other shape reads as empty or is omitted.
- `StudentSensitive` makes date of birth, gender and admission date mandatory while the columns are nullable, so an old row shows no sensitive block at all. `GuardianPrivate` and `GuardianContact` make an E.164 phone mandatory, so a guardian with no usable number is dropped from a contact list and cannot be linked.
- `export_jobs.status` has no check constraint, so a producer writing a status outside the four contract values would answer `SERVICE_UNAVAILABLE`.
- `AuditEventSummary.action` was widened from `PermissionKey` to a bounded string, because Task 4 writes workflow actions such as `members.invite.accept`. A closed union of permission keys and workflow actions would be better. `outcome` has two values, so an operation that failed is reported as denied; the `result` column still distinguishes them.

Coverage and behaviour:

- `students.read_guardians` at an own-children scope collapses to an empty list, because the guardians table has no student column and the scope term in `packages/authz/src/scope.ts` has no branch for it. No role template grants that combination today.
- Admission never writes `guardian_student_access`, so a parent membership does not automatically gain access to a newly admitted child. That is an access change with an approval state and a version bump, and it belongs to access management.
- `audit.read` at the `finance` scope maps to TRUE, so an accountant sees every audit row of the school. The "redact by audience" line in the coverage inventory is not implemented; the fix belongs in the scope terms.
- The promotion roster is capped at 200 rows with no total, because `PromotionPreview` cannot carry one. A promote request can only act on 200 pupils anyway.
- The command-menu search returns at most 10 hits of each kind with no count, so a caller cannot tell ten matches from four hundred. It also merges two coverage rows, so a caller without `staff.read_directory` gets `staff: []` rather than a refusal, and a caller denied `students.read_basic` is refused the whole endpoint even if they may read staff.
- The office dashboard returns two integers. `DashboardResponse` carries no academic year name, per-grade strength, setup checklist, recent activity, attendance or fees, so Task 7 cannot rebuild the office screen from it. The office audience is `owner`, `principal` and `admin`; there is no `clerk` role in this build.
- The promotion reason is validated and then not persisted: operator free text routinely names a child, and audit rows must stay free of personal detail.
- `GET /exports/:jobId` is not in the coverage inventory and its permission is a floor chosen here, not a documented one.
- `PUT /grades/:gradeId/subjects` answers `GradeSubjectList` where the inventory says `Subject` or `EmptySuccess`, because the request replaces a set and returning the set saves a re-read.
- `staff.assignments` and `staff.sectionAssignments` are gated on `staff.read_employment` and `sections.read` rather than the inventory's `timetable.read`; both are at least as strict. `GET /staff/:staffId` is gated on `staff.read_directory` rather than `staff.read_employment`, because the four staff projection keys are separate checks and the gate has to be the weakest of them. `GET /timetable/substitutions/absent-periods` is gated on `timetable.manage_substitutions` rather than `timetable.read`, which is stricter.
- Bell schedule reads are school-wide rather than matched scope: `timetable.read` is a permission over timetable entries, so no read plan can be built for a bell schedule. What a caller learns beyond their own classes is the period clock and the grade ids.
- `timetable.freeTeachers` accepts either management key inside the handler, but `protectedRoute` takes exactly one gate permission, so a member whose only grant is `timetable.manage_substitutions` through an exception is still refused at the gate. Every role template that grants one grants the other.
- Searches are leading-wildcard `ILIKE` scans with no trigram index, which is fine at fixture scale and will need an index before real data.
- `allowedActionsFor` and `decideResource` reload the policy snapshot and relationship facts on every call, so a detail read makes several snapshot loads where one would do. Correct, and worth caching per transaction in the shared layer.
- `apps/api` still has no lint script, so `pnpm -r lint` does not reach this source.

## Run the tests

The API tests need the same local PostgreSQL database as `packages/db`.

```sh
docker compose -f compose.db.yml up -d --wait
MIGRATION_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp pnpm db:migrate

pnpm --filter @erp/api typecheck
pnpm --filter @erp/contracts typecheck
pnpm test:api
```

`pnpm test:api` runs every file one at a time against one database, so the files share fixtures. A file that asserts an exact roster, count or empty table clears the rows it owns in its `before` hook and puts back anything it widened in its `after` hook; a file that seeds into a fixture class uses a name of its own, because a section name is unique within a class and a year.

One module's file can be run on its own against a private migrated copy, which is how the modules were written:

```sh
ERP_TEST_DB=erp_m_students pnpm --filter @erp/api exec tsx --test tests/modules-students.test.ts
```

`ERP_TEST_DB` names the database the harness points every pool at; it defaults to `erp`. A private copy has to be created and migrated first, with `MIGRATION_DATABASE_URL` naming it.

The other suites:

```sh
TEST_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp pnpm test:db
TEST_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp pnpm test:authz
pnpm test:contracts
```

Reset the schema before `test:db` and `test:authz`: the API suite leaves the fixtures rewritten.

## What the tests prove

`pnpm test:api` is 248 tests across 19 files. Task 5 adds 159 of them, in ten files: 20 setup, 22 students, 18 students-bulk, 23 staff, 20 timetable, 9 dashboard, 11 search, 10 audit, 21 files and 5 foundation. The other 89 are the Task 2 authentication tests and the Task 4 access tests.

Every module file asserts the same seven shapes for at least its main list and its main detail read, wherever the shape has a meaning for that module: an anonymous caller is refused, a member of one school using the other school's id in the path is refused with `SCHOOL_ACCESS_UNAVAILABLE`, another school's record id through this school's path is not found and leaks nothing, a same-school caller with the wrong relationship gets not found and finds the row absent from the list, a permitted read returns exactly the contract fields, a write body carrying a forbidden field is refused with the database unchanged, and a bulk request with one bad id is rejected whole with nothing written.

The scope assertions are built from real scopes rather than from a caller who holds nothing: a teacher with one teaching assignment, a parent of one child, an accountant at finance scope, an administrator whose role lost one key. Several tests were written specifically to fail if the plan predicate were removed from a query, which is what keeps "a list contains a row if and only if the detail read allows it" a property and not a claim.
