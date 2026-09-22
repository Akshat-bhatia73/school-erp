# Protected school APIs: setup, students, staff, timetable and the rest

Task 5 adds `apps/api/src/modules`: the read and write endpoints for the records a school keeps about itself, its pupils, its people and its week. It sits on the Task 2 session service and the Task 3 policy service, so every route is decided by [the policy service](./AUTHORIZATION.md), every list is bounded by the same predicate its detail read uses, and every write is recorded in the audit log exactly as [access management](./ACCESS_MANAGEMENT.md) does. The operations it replaces are the mock client operations inventoried in [operation coverage](./OPERATION_COVERAGE.md). It is defined in [the implementation plan](../AUTH_RBAC_IMPLEMENTATION_PLAN.md) (sections 9 and 13, and the Task 5 checklist).

Source files: [modules/index.ts](../../apps/api/src/modules/index.ts), [modules/shared](../../apps/api/src/modules/shared) (`route.ts`, `authorize.ts`, `audit.ts`, `version.ts`, `errors.ts`), then one folder per module: [attendance](../../apps/api/src/modules/attendance), [fees](../../apps/api/src/modules/fees), [setup](../../apps/api/src/modules/setup), [students](../../apps/api/src/modules/students), [students-bulk](../../apps/api/src/modules/students-bulk), [staff](../../apps/api/src/modules/staff), [timetable](../../apps/api/src/modules/timetable), [dashboard](../../apps/api/src/modules/dashboard), [search](../../apps/api/src/modules/search), [audit](../../apps/api/src/modules/audit), [files](../../apps/api/src/modules/files). Their request and response contracts are the `module-*.ts` files in [`@erp/contracts`](./CONTRACTS.md).

## Scope

In scope: school profile and academic setup, the student roster and one student's record, bulk admission and promotion, the staff directory and one person's record, the timetable and its substitutions, the dashboard, the command-menu search, the audit log, export jobs with their files, the private document download, fees: what the school charges, what each pupil owes, the ledger of what was paid, and the files made from them; and attendance: the daily register of every section, the office's corrections, a pupil's month and its percentage, the staff register, and the files made from them. One hundred and nine routes in ten modules: one hundred and six through the shared route helper and three registered by hand in the files module.

Out of scope, deliberately. There is no exam or communication module, no absence notice to a parent (Task 22), and no online payment: fees are recorded by hand. There is no custom role and no new permission: the catalogue is the fixed one in `@erp/contracts`, and a route that names a reserved permission fails at startup. Nothing here changes a membership, a role or an exception; that is access management, and a module that needs a parent to reach a new child has to ask for it there.

## The route helper and the gate

`protectedRoute(app, deps, definition)` in [`modules/shared/route.ts`](../../apps/api/src/modules/shared/route.ts) is the only way a module registers a route. A definition names a method, a path, one permission, an optional query schema, an optional body schema, a response schema and a handler. Six things happen around every handler, and none of them is a module's to skip.

1. At startup the declared permission is checked against `PERMISSION_CATALOGUE`. An unknown or reserved key throws before the server listens, so a route that could never be authorized never exists.
2. `requireMembership` runs as the preHandler, so a session, an active membership in the path school, the access version check and the role level MFA rule are already satisfied. An anonymous caller is `AUTHENTICATION_REQUIRED`; a member of another school using this school in the path is `SCHOOL_ACCESS_UNAVAILABLE`.
3. The declared permission is decided against the school as a whole, in its own short transaction, before the handler starts. A member who holds it nowhere is refused with the evaluator's own code, usually `ACCESS_DENIED` and sometimes `MFA_REQUIRED`. This gate is the floor, never the ceiling.
4. The query string and the body are parsed. Query values arrive as strings and only the keys the schema declares numeric are converted, so a schema stays the single description of a query. Every body and query contract is a `z.strictObject`, so an unknown key, including `schoolId`, is `INVALID_REQUEST` before the handler sees it.
5. The handler's result is parsed through the response schema before it is sent. A mismatch is logged and answered `SERVICE_UNAVAILABLE`: an unexpected field is a leak, so the unchecked object is never sent. Optional fields are omitted rather than sent as null unless the contract says nullable.

6. Two things are written afterwards, outside the handler's transaction. When the definition carries `auditRead` and the handler succeeded, one `allowed` audit row is written in a fresh `withTenantTransaction` after the response has been validated, so a read never fails because its audit failed to commit; a failure there is logged only. When the gate or the handler raises `ACCESS_DENIED`, one `denied` row is written the same way and the error is rethrown, so a refusal that rolled its transaction back still appears in the school's trail. See [read auditing and denials](#read-auditing-and-denials).

Three routes are registered by hand instead, all in the files module, and each still runs `requireMembership` and an aggregate decision of its own: the document download and the export file download stream bytes and so have no parseable response contract, and the export status route cannot name one gate permission without excluding the staff, audit or timetable exporter.

## The read protocol

A handler opens exactly one `withTenantTransaction(deps.pools.runtime, context, ...)` and decides everything inside it.

`readPlan(conn, context, permission, resourceType)` builds the caller's plan for that permission, and `planPredicate(plan, scopedTableFor(resourceType))` turns it into the SQL boolean the query must AND into its `WHERE` clause. The predicate already pins `school_id`, adds the scope terms the caller's grants allow, and subtracts every deny exception, so a list, a count, a search, an export candidate set and a detail read all agree by construction. Nothing is ever fetched school-wide and filtered in JavaScript. **A list contains a row if and only if the matching detail read allows it**, and the test suites are written to fail if a predicate is removed.

Where one read exposes more than one record kind, it builds more than one plan. A student hit carries its class only when the caller also passes the `students.read_enrollments` plan on `enrollment`; the curriculum list ANDs a `subjects.read` plan and a `grades.read` plan; the substitution day is bounded by the covering timetable entry the caller may read. A caller who holds the extra permission nowhere gets the record without that block, not a refusal, because the gate permission of the route is the one the caller asked for.

A single record that the plan does not reach is `RESOURCE_NOT_FOUND`, never `ACCESS_DENIED`: a 403 on a real id and a 404 on an invented one is an existence oracle, so record-scoped reads and writes report both the same way. A module-level refusal, decided before any id is involved, stays `ACCESS_DENIED`. An identifier of the wrong shape in a path is `RESOURCE_NOT_FOUND`; a malformed value in a query filter or a body reference is `INVALID_REQUEST`, because that is bad input rather than a missing collection.

`allowedActionsFor(conn, context, { schoolId, resourceType, id })` fills the `allowedActions` field of a detail response, and `decideAction(..., aggregate: true)` does the same for a view that is not one row, such as a section's timetable. A list uses `allowedActionsForMany(conn, context, resourceType, ids)`, which loads the policy snapshot once and answers a map of id to keys, so a page of rows costs one snapshot load rather than one per row.

## The write protocol

Every write follows the same order inside one tenant transaction, mirroring access management.

1. `lockSchool(conn, schoolId)` before a write that touches more than one row, so two writers in one school serialise.
2. Decide again inside the transaction: `authorizeSchoolAction` for a school-wide action, `authorizeResource` or `decideResource` for a named record. The gate decided the module action; this decides the record.
3. Validate the proposed new state. Every section, grade, subject, academic year, staff member, guardian or student a body names must exist in this school and must fit the row it is going into. A cross-school or unknown reference is `INVALID_REQUEST`, never a database error turned into a 503. A leaving date before a joining date, a move across academic years, a delete of a record something still points at and a teacher who is already busy in that period are all refused the same way.
4. Take the optimistic lock. `bumpVersion(conn, table, { schoolId, id, expectedVersion, set })` writes and increments in one statement; a caller who read an older row gets `VERSION_CONFLICT`. Every editable table has a version column since migration `0014`; `schools` is keyed by its own id, which `bumpVersion` knows.
5. `writeAudit(conn, context, ...)` exactly once per committed write, in the same transaction. The summary is plain English and `safe_changes` carries ids, keys, counts and statuses, never a name, a date of birth, a phone number, an address, an amount, a storage key or a token.
6. Return committed state, parsed through the response contract.

A bulk write authorizes every id before the first row changes and rejects the whole request if any one fails, so there is no partial write. The grade-subject replacement, the import commit, the promotion and both export endpoints are written that way and tested for it.

Bodies are allowlists, not filters. No endpoint accepts `schoolId`, the actor's own ids, a version it does not own, a salary, a role key or a relationship field unless its permission covers exactly that field group. Field groups that need their own key get their own endpoint: a student's basic and sensitive updates are two routes, and a staff record's employment, private and pay updates are three.

## Endpoints

All paths are under `/api/schools/:schoolId`. The permission column is the gate permission; the extra checks column is what the handler decides beyond it. Every route can answer `AUTHENTICATION_REQUIRED`, `SCHOOL_ACCESS_UNAVAILABLE` and `ACCESS_DENIED`, so those are not repeated per row.

### Setup

| Method and path | Permission | Extra checks | Success | Error codes |
|---|---|---|---|---|
| `GET /school` | `school.read` | none; the answer carries `allowedActions` | 200 | — |
| `PUT /school` | `school.update` | `expectedVersion` against `schools.version` | 200 | `INVALID_REQUEST`, `VERSION_CONFLICT` |
| `GET /academic-years` | `academic_years.read` | plan predicate | 200 | — |
| `GET /academic-years/current` | `holidays.read` | filtered to this school; no plan predicate | 200 | `RESOURCE_NOT_FOUND` |
| `POST /academic-years` | `academic_years.manage` | dates ordered, one current year | 201 | `INVALID_REQUEST` |
| `PUT /academic-years/:academicYearId` | `academic_years.manage` | the same, plus `expectedVersion` | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `GET /grades` | `grades.read` | plan predicate | 200 | — |
| `POST /grades` | `grades.manage` | unique name and short name | 201 | `INVALID_REQUEST` |
| `PUT /grades/:gradeId` | `grades.manage` | `expectedVersion` | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `DELETE /grades/:gradeId` | `grades.manage` | nothing may still refer to it | 204 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `GET /sections` | `sections.read` | plan predicate; filters must be ids; the class teacher is named only through the `staff.read_directory` plan | 200 | `INVALID_REQUEST` |
| `GET /sections/strengths` | `sections.read_strengths` | plan predicate; counts only visible sections | 200 | `INVALID_REQUEST` |
| `GET /sections/:sectionId` | `sections.read` | plan predicate; the class teacher is named the same way | 200 | `RESOURCE_NOT_FOUND` |
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
| `PUT /holidays/:holidayId` | `holidays.manage` | `expectedVersion` against `holidays.version` | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `DELETE /holidays/:holidayId` | `holidays.manage` | none | 204 | `RESOURCE_NOT_FOUND` |

`GET /academic-years/current` is the one setup read that is not decided by
`academic_years.read`. Which year the school is in now is school calendar
setup, the same kind of fact as a holiday, and every role holds `holidays.read`
across the whole school. A teacher or a parent holds no `academic_years.read`
grant, so without this every screen would have to guess the year from the
sections it can see, and a teacher still carrying last year's classes would
guess a closed year. The year LIST stays behind `academic_years.read`.

Every setup record — the school profile, an academic year, a grade, a section, a subject and a holiday — carries `allowedActions`, on the lists as well as the detail, create and update answers. An office reader sees the matching manage key; a teacher or a parent sees an empty list, including on `GET /academic-years/current`, which every role may read.

A section names its class teacher in `classTeacher` only when the caller could open that staff record: the `staff.read_directory` plan is ANDed into the join, so a caller with no directory grant simply sees no name rather than a refusal. `classTeacherId` is there for everyone, so a screen can say a class has a teacher without naming them.

A delete refused because something still refers to the record answers `INVALID_REQUEST` with a `reason` from the closed `ErrorReason` list — `grade_has_sections`, `section_has_students`, `subject_has_classes` and the rest — and the plain-English sentence that goes with it. The reason names a kind of blocker, never a record, a count or a name, and it is only ever sent on a refusal the caller was allowed to ask for: an `ACCESS_DENIED` carries no reason at all.

`GET /sections/strengths` counts an enrolment while it is open, and also when
it was closed by finishing the year (`promoted` or `detained`), so a closed
year still shows who was in each class. A pupil who left is not counted.

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
| `POST /students` | `students.create` | section in this school; the admission number is assigned by the server for that section's academic year and may not be sent; an existing guardian also needs `students.manage_guardians` | 201 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `PUT /students/:studentId` | `students.update_basic` | `expectedVersion` | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `PUT /students/:studentId/sensitive` | `students.update_sensitive` | medical fields also need `students.read_medical` | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `POST /students/:studentId/move` | `students.manage_enrollment` | target section in this school and this year; roll number kept when omitted | 204 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `POST /students/:studentId/leave` | `students.manage_enrollment` | leaving date not before the joining date; reason stored and audited | 204 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `POST /students/:studentId/guardians` | `students.manage_guardians` | named guardian decided per record; one primary per student | 201 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `PUT /students/:studentId/guardians/:guardianId` | `students.manage_guardians` | the link must exist | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `GET /students/:studentId/apaar` | `students.read_sensitive` | the record decided again; the sealed value is opened in the API and the reveal is audited through `auditRead` | 200 | `RESOURCE_NOT_FOUND` |
| `GET /students/:studentId/aadhaar` | `students.read_sensitive` | the same shape as the APAAR reveal: the record decided again, the sealed number opened in the API, the reveal audited | 200 | `RESOURCE_NOT_FOUND` |
| `GET /students/:studentId/guardians/:guardianId/identity` | `students.read_guardians` | the student decided first and the guardian proved to be linked to that student; refused when the guardian carries neither a PAN nor an Aadhaar number; the reveal is audited | 200 | `RESOURCE_NOT_FOUND` |
| `GET /students/:studentId/photo` | `students.read_basic` | the record decided again; a record this caller may not read answers exactly like a missing one; no audit row | 200 | `RESOURCE_NOT_FOUND` |
| `PUT /students/:studentId/photo` | `students.update_basic` | the body is the picture itself, so `expectedVersion` is a query parameter; the `photographs` consent must stand; type decided by the first bytes, at most 1 MB | 204 | `INVALID_REQUEST`, `NOT_ALLOWED_YET`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `DELETE /students/:studentId/photo` | `students.update_basic` | `expectedVersion` as a query parameter; the bytes go after the commit | 204 | `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `GET /students/:studentId/subject-access` | `students.export_subject` | the student decided under this key first; each block decided separately on this record; `accessHistory` needs `audit.read` | 200 | `RESOURCE_NOT_FOUND` |
| `GET /students/:studentId/consents` | `students.read_consents` | the student decided under this key first; the newest row per guardian and purpose only | 200 | `RESOURCE_NOT_FOUND` |
| `POST /students/:studentId/consents` | `students.manage_consents` | the guardian must be linked to that student in this school; a guardian recording through the portal is stored as `portal` | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `POST /students/:studentId/anonymise` | `students.anonymise` | status `left` or `alumni`, the leaving date at least `RETENTION.studentSensitiveYears` old by the database clock, not already anonymised, `expectedVersion` | 200 | `NOT_ALLOWED_YET`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `POST /students/:studentId/guardians/:guardianId/unlink` | `students.manage_guardians` | the link must exist and must not be the last guardian of an active student; `expectedVersion` is the student's | 200 | `NOT_ALLOWED_YET`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |

### Students in bulk

| Method and path | Permission | Extra checks | Success | Error codes |
|---|---|---|---|---|
| `POST /students/import/preview` | `students.import` | every row validated server-side; only valid rows are staged, for one hour; a supplied admission number is checked for uniqueness and a blank one is left to be assigned | 201 | `INVALID_REQUEST` |
| `POST /students/import/commit` | `students.import` | preview pending, unexpired, this school, same author, `expectedVersion`; every row re-validated before the first insert | 201 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `GET /students/promote/preview` | `students.promote` | roster bounded by the `students.read_basic` plan; `page` and `pageSize` (at most 100), with the matching `total` | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `POST /students/promote` | `students.promote` | every named pupil distinct and currently seated in that class, with no open enrolment next year | 200 | `INVALID_REQUEST` |
| `POST /students/export` | `students.export` | every requested id must pass the export plan, or none is written | 202 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `POST /students/:studentId/export-profile` | `students.export` | the record decided again under this key; the producer re-reads every block behind its own key | 202 | `RESOURCE_NOT_FOUND` |

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
| `POST /staff` | `staff.create` | school locked first, then the employee code is assigned from the school counter; it may not be sent | 201 | `INVALID_REQUEST` |
| `PUT /staff/:staffId/employment` | `staff.update_employment` | leaving date not before the stored joining date; `expectedVersion` | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `PUT /staff/:staffId/private` | `staff.update_private` | that record decided, so the self scope works | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `PUT /staff/:staffId/pay` | `staff.update_pay` | audit row carries the reason and never the amount | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `GET /staff/:staffId/photo` | `staff.read_directory` | the record decided again; a record this caller may not read answers exactly like a missing one; no audit row | 200 | `RESOURCE_NOT_FOUND` |
| `PUT /staff/:staffId/photo` | `staff.update_private` | the body is the picture itself, so `expectedVersion` is a query parameter; same type and size rules as a pupil's | 204 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `DELETE /staff/:staffId/photo` | `staff.update_private` | `expectedVersion` as a query parameter | 204 | `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `POST /staff/:staffId/anonymise` | `staff.anonymise` | status `resigned` or `retired`, the leaving date at least `RETENTION.staffPrivateYears` old by the database clock, not already anonymised, `expectedVersion` | 200 | `NOT_ALLOWED_YET`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `POST /staff/export` | `staff.export` | every requested id must pass the export plan, or none is written | 202 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `POST /staff/:staffId/export-profile` | `staff.export` | the record decided again under this key; the producer re-reads every block behind its own key | 202 | `RESOURCE_NOT_FOUND` |

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
| `POST /timetable/export` | `timetable.read` | the year must be in this school; the view is decided before the job is written, and an empty week needs `sections.read` or `staff.read_directory`; the producer re-reads it under the read plan | 202 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |

### Fees

| Method and path | Permission | Extra checks | Success | Error codes |
|---|---|---|---|---|
| `GET /fees/heads` | `fees.read` | plan predicate over fee heads; a parent's plan selects none | 200 | — |
| `POST /fees/heads` | `fees.manage` | name unique in the school, ignoring case | 201 | `INVALID_REQUEST` |
| `PUT /fees/heads/:headId` | `fees.manage` | `expectedVersion`; who it applies to and how often cannot change | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `DELETE /fees/heads/:headId` | `fees.manage` | `expectedVersion` in the query; refused with `fee_head_in_use` while a structure, an optional fee, a concession or a receipt line names it | 204 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `GET /fees/structures` | `fees.read` | plan predicate; `academicYearId` required; a class filter also returns the every-class rows | 200 | `INVALID_REQUEST` |
| `POST /fees/structures` | `fees.manage` | year, head and class in this school; one row per year, head and class | 201 | `INVALID_REQUEST` |
| `PUT /fees/structures/:structureId` | `fees.manage` | `expectedVersion` | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `DELETE /fees/structures/:structureId` | `fees.manage` | refused with `fee_structure_has_payments` once a payment stands against that head in that year | 204 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `POST /fees/students/:studentId/opt-ins` | `fees.manage` | the pupil decided again; year and head in this school; the head must be an opt-in head; the pupil enrolled in that year; the start date inside it | 201 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `PUT /fees/opt-ins/:optInId` | `fees.manage` | `expectedVersion`; `null` clears the pupil's own amount or the end date | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `DELETE /fees/opt-ins/:optInId` | `fees.manage` | refused with `fee_opt_in_has_payments`; give it an end date instead | 204 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `POST /fees/students/:studentId/concessions` | `fees.manage` | the pupil decided again; year and head in this school; the reason goes to the audit note only | 201 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `POST /fees/concessions/:concessionId/remove` | `fees.manage` | `expectedVersion`; the reason goes to the audit note only | 204 | `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT` |
| `GET /fees/students/:studentId/statement` | `fees.read` | the pupil through the fee account plan and the `students.read_basic` plan; the class through `sections.read`; audited through `auditRead` | 200 | `RESOURCE_NOT_FOUND` |
| `GET /fees/dues` | `fees.read` | the same two plans; filters, paging and totals in SQL | 200 | `INVALID_REQUEST` |
| `GET /fees/receipts` | `fees.read` | ledger plan predicate and the two pupil plans; totals follow the filters | 200 | `INVALID_REQUEST` |
| `GET /fees/receipts/:receiptId` | `fees.read` | the same; audited through `auditRead` | 200 | `RESOURCE_NOT_FOUND` |
| `POST /fees/students/:studentId/collect` | `fees.collect` | school locked; the pupil decided again; year and every head in this school; the pupil enrolled in that year; the date not in the future; each line at most what is left of that head for the year (`fee_amount_exceeds_balance`, `fee_nothing_charged`); the receipt number assigned by the server and never sent | 201 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `POST /fees/receipts/:receiptId/refund` | `fees.manage` | a standing payment; each line at most what is left of that payment line; a new row that points at the payment | 201 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `POST /fees/receipts/:receiptId/cancel` | `fees.manage` | a payment with no refund and no cancellation (`fee_receipt_already_reversed`); a new row that copies its lines | 201 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `POST /fees/students/:studentId/adjustments` | `fees.manage` | a credit may not exceed what is left of that head; a debit needs no charge to exist | 201 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `POST /fees/receipts/:receiptId/export` | `fees.read` | the receipt decided again; the producer re-reads it under the requester's plan | 202 | `RESOURCE_NOT_FOUND` |
| `POST /fees/dues/export` | `fees.export` | the year in this school; the producer re-reads the dues list | 202 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `POST /fees/receipts/export` | `fees.export` | window ordered and at most 366 days | 202 | `INVALID_REQUEST` |

### Attendance

| Method and path | Permission | Extra checks | Success | Error codes |
|---|---|---|---|---|
| `GET /attendance/sections` | `attendance.read` | `?date=` defaults to today in the school's timezone; sections of the year containing it through the attendance roster plan and the `sections.read` plan; strength, marks and the last save counted through the caller's plans | 200 | `INVALID_REQUEST` |
| `GET /attendance/sections/:sectionId/days/:date` | `attendance.read` | the section decided again under `attendance.read`; the roster derived from the enrolments covering that date, names through `students.read_basic`; carries `window` (whether this caller may record or correct this day, with the reason when not) | 200 | `RESOURCE_NOT_FOUND` |
| `PUT /attendance/sections/:sectionId/days/:date` | `attendance.record` | school locked; the section decided again; the date must be a school day inside the year and today (`attendance_date_outside_year`, `attendance_not_a_school_day`, `attendance_date_in_future`, `attendance_marking_window_closed`); the body must name exactly the roster (`attendance_pupil_not_on_roster`, `attendance_roster_incomplete`); one new row per pupil whose mark changed | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `POST /attendance/sections/:sectionId/days/:date/corrections` | `attendance.manage` | the same, on any school day up to today; every named pupil on the roster; a new row of kind `correction` per changed mark; the reason is the audit note | 201 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `GET /attendance/students/:studentId/months/:month` | `attendance.read` | the pupil decided again; the month must fall in a year of this school (`attendance_month_outside_year`); the class named through `sections.read`; audited through `auditRead` | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `GET /attendance/sections/:sectionId/months/:month` | `attendance.read` | the section decided again; the month must overlap the section's year | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `POST /attendance/sections/:sectionId/months/:month/export` | `attendance.export` | the section decided again under this key; the producer re-reads the register under the requester's plans | 202 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `POST /attendance/students/:studentId/months/:month/export` | `attendance.read` | the pupil decided again; a single-record kind, so the download decides the pupil again | 202 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `GET /staff-attendance/days/:date` | `staff_attendance.read` | the register that day (joined by then, not yet left) through the staff attendance plan and `staff.read_directory`; a teacher's `self` plan reaches their own row alone; carries `window` and marks the caller's own row | 200 | `RESOURCE_NOT_FOUND` |
| `PUT /staff-attendance/days/:date` | `staff_attendance.record` | school locked; the day rules above; the body must name exactly the register minus the caller's own row (`staff_attendance_own_record`, `staff_attendance_not_on_register`, `staff_attendance_register_incomplete`) | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `POST /staff-attendance/days/:date/corrections` | `staff_attendance.manage` | the same on a past school day; never the caller's own row; the reason is the audit note | 201 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `GET /staff-attendance/months/:month` | `staff_attendance.read` | everybody on the register during the month, through the plans | 200 | `INVALID_REQUEST` |
| `GET /staff-attendance/staff/:staffId/months/:month` | `staff_attendance.read` | the person decided again; audited through `auditRead` | 200 | `INVALID_REQUEST`, `RESOURCE_NOT_FOUND` |
| `POST /staff-attendance/months/:month/export` | `staff_attendance.export` | the producer re-reads the register under the requester's plans | 202 | `INVALID_REQUEST` |

### Dashboard, search, audit and files

| Method and path | Permission | Extra checks | Success | Error codes |
|---|---|---|---|---|
| `GET /dashboard` | `dashboard.read` | audience fixed from the caller's roles; optional `?date=YYYY-MM-DD`, otherwise today in the school's timezone; every block through its own plan | 200 | `INVALID_REQUEST` |
| `GET /search?q=` | `students.read_basic` | student rows through `students.read_basic`, staff rows through `staff.read_directory`, the class through `students.read_enrollments` | 200 | `INVALID_REQUEST` |
| `GET /audit-events` | `audit.read` | plan predicate on `audit_event`; filters (`actorMembershipId`, `action`, `outcome`, `from`, `to`) only narrow it, and the total follows them; the note is joined under the same predicate and omitted once redacted | 200 | `INVALID_REQUEST` |
| `POST /audit-events/export` | `audit.export` | window ordered and at most 366 days | 202 | `INVALID_REQUEST` |
| `POST /audit-events/:eventId/note/redact` | `audit.redact_notes` | the event must be in this school; a repeat request changes nothing and writes no second row | 200 | `RESOURCE_NOT_FOUND` |
| `GET /students/:studentId/documents/:documentId/content` | `students.download_documents` | record decided again; the document must belong to that student | 200, a byte stream | `RESOURCE_NOT_FOUND` |
| `GET /exports/:jobId` | one of `students.export`, `staff.export`, `audit.export`, `timetable.read`, `fees.export`, `fees.read`, `attendance.export`, `attendance.read`, `staff_attendance.export` | the job's own recorded permission re-decided, plus freshness | 200 | `RESOURCE_NOT_FOUND` |
| `GET /exports/:jobId/file` | the same floor | the same checks as the status route, then the job must be ready; one audit row per download | 200, a byte stream | `RESOURCE_NOT_FOUND` |

### What the dashboard answers

One read builds the whole home screen, inside one tenant transaction. The audience comes from the
caller's own roles through `audienceFor` (office = owner, principal, admin; then teacher, parent,
accountant); the browser never asks for an audience and cannot pick one. `?date=` only moves the
calendar the answer is about. It never widens what is read, and a date outside a `YYYY-MM-DD` shape
or any other query parameter is `INVALID_REQUEST`.

Blocks and the permission each one needs:

| Audience | Block | Permission it needs |
|---|---|---|
| all | `day` (school day, holiday or Sunday, and the next school day) | none beyond `dashboard.read`; the holidays it is built from come through the `holidays.read` plan, so it is built from Sundays alone when `holidays.read` is not held |
| office | `today` (teachers away, periods without cover) | `timetable.read`, through the substitution plan |
| office | `attention` rows | per key: `periods_without_cover` `timetable.read`; `students_absent_three_days` `attendance.read` (pupils whose current mark is absent on the last three school days up to the date); `invitations_expiring` `members.invite`; `students_without_guardian_phone` `students.read_guardian_contact`; `students_without_consent` `students.read_consents`; `sections_without_class_teacher` `sections.read`; `empty_timetable_slots` `sections.read` and `timetable.read`; `staff_without_login` `staff.read_directory` and `members.read` |
| office, accountant | `glance.students.total` (the roll) | `students.read_basic` |
| office, accountant | `glance.mix`, `glance.admittedThisMonth`, `glance.leftThisMonth` | `students.read_sensitive`: gender, admission date and the date a child left are the sensitive block of a student record, so the mix and the movements are absent without it |
| office | `studentsPerTeacher` | `students.read_basic` and `staff.read_directory`; omitted when the school has no teaching staff |
| office | `classStrength` | `sections.read_strengths`, counted over the sections the section plan allows and through the `students.read_enrollments` plan; the accountant role holds no `sections.read_strengths`, so the block is absent for that audience and the card is not drawn |
| office | `admissionsByMonth` (twelve months, April to March) | `students.read_sensitive`, because it counts admission dates |
| office | `birthdays` (today and this week) | `students.read_sensitive` for pupils and `staff.read_private` for staff: a birth date lives in those blocks, so a caller who may not read it on one record may not rebuild it from the calendar either |
| office | `recentActivity` | `audit.read` |
| office | `securityEvents` | `audit.read`, and only for a member holding the `owner` role |
| office | `setup` steps | the read permission of each step; a step the caller may not read is not listed |
| all | `holidays` | `holidays.read`; an empty list when it is not held |
| teacher | `timeline`, `week`, `periods` | `timetable.read` on their own entries; `staffLinked: false` when the login has no staff record |
| teacher | `myClass` (strength and birthdays) | class teacher of that section, plus `sections.read_strengths` and the `students.read_enrollments` plan for the strength; `birthdaysThisWeek` needs `students.read_sensitive` and is absent otherwise, which the plain teacher role does not hold |
| parent | one entry per child | `students.read_basic` over their own children; `enrollment` needs `students.read_enrollments`, `todayLessons` needs `timetable.read`, `waitingOn` needs `students.read_consents` |
| office, accountant | `fees` (collected today and this month, outstanding dues, pupils with dues) | `fees.read`; every figure is a sum over the ledger and the fee accounts the caller's own plan allows, for the current academic year |
| parent | `feesDuePaise` on each child | `fees.read` over their own children |
| office | `attendance` (registers marked of total, pupils absent today) | `attendance.read`; sections and marks counted through the caller's own plans; absent on a day that is not a school day |
| teacher | `myClass.attendanceToday` | `attendance.read` on that section; absent on a day that is not a school day |
| parent | `attendance` on each child (this month's percentage so far) | `attendance.read` over their own children, through the same figures as the calendar screen |

Three rules hold across all of it:

- **Omission, not zero.** A block whose permission the caller does not hold is absent from the
  response. `readPlan` refusing with `ACCESS_DENIED` is caught for that block alone and anything
  else is rethrown, so a mis-wired permission fails loudly instead of reading as "none". A screen
  can therefore tell "you may not see this" from "there are none".
- **Cover duty has a limit.** A teacher sees a cover period only when the substitution names them as
  the stand-in *and* their own `timetable.read` substitution plan allows the covering entry. The
  absent teacher owns that row, so a cover in a section the stand-in does not otherwise teach is not
  shown. Widening it needs a scope term for substitutions, not a change here.
- **Four tables are read for this school alone.** `school_invitations`, `membership_staff_links` and
  `school_memberships` have no scoped table in `@erp/authz` and are read only behind
  `decideSchoolAction`. Three more are read with a bare `school_id` and no decision at all:
  `schools` (its timezone), `academic_years` (which year "now" is) and `bell_schedules` with
  `bell_schedule_grades` (when the bells ring). They are school setup rather than anybody's record,
  a teacher and a parent hold no grant over them, and every other block would be meaningless without
  them. Nothing of them leaves the response beyond an id, a name and a bell time, and the reads are
  inside the tenant transaction, so no row can cross a school. Any new table read this way belongs
  in this list with its reason.
- **One timezone, the school's.** "Today", "this month" and "this week" are worked out in
  `schools.timezone` (default `Asia/Kolkata`), not in the server's clock or the browser's, so a
  request at half past midnight UTC still reads as the Indian school day it belongs to.

The route writes no audit row: it is a read. No block carries personal data beyond a name and a
class, and nothing is logged.

## Projection rules per field group

A response carries a field group only when the caller holds the key for that group, decided against that record, and never as a side effect of holding a different key.

- **Student basic** (`students.read_basic`): id, name, admission number, status and version. The class summary rides along only when the `students.read_enrollments` plan also allows that enrolment row.
- **Student sensitive** (`students.read_sensitive`): date of birth, gender and admission date, as one block that is present or absent. The APAAR id appears here only as `apaarMasked` (`XXXX-XXXX-1234`) and the Aadhaar number only as `aadhaarLast4`; each full value has its own audited route.
- **Student and staff photographs** (`students.read_basic`, `staff.read_directory`): a record says `hasPhoto` and, when there is one, `photoUpdatedAt`. The bytes are never in a body and the storage key is never anywhere. A screen fetches the picture from the streaming route above, which decides the same key again on that record.
- **Student medical** (`students.read_medical`): blood group and medical notes, a separate block and a separate write check.
- **Guardian contact** (`students.read_guardian_contact`): a minimal contact, never a guardian directory.
- **Guardian private** (`students.read_guardians`): occupation, income, home address, office address, `panLast4` and `aadhaarLast4`, as one block. One SQL fragment, `guardianColumns` in `students/reads.ts`, is the only guardian select list, so the guardian detail, the list, the subject-access read and the profile PDF all describe a person the same way and none of them selects a sealed column.
- **Student documents** (`students.read_documents`): metadata only. The storage key is server state and appears in no body, no header, no log line and no error.
- **Staff directory** (`staff.read_directory`): display name, designation and department. Nothing else.
- **Staff employment, private and pay** (`staff.read_employment`, `read_private`, `read_pay`): three separate blocks behind three separate keys, each decided on that record, so a teacher reads their own employment and contact and never anybody's pay.
- **Anonymised records**: a student or staff row that has been anonymised reports `anonymised: true` in its basic or directory block and carries no sensitive, medical, private or pay block at all, whatever keys the caller holds. There is nothing left in those columns to project.
- **Audit events** (`audit.read`): time, actor label, action, summary and outcome. `safe_changes`, target ids, the request id and the actor ids are read by the handler and never projected.
- **Nested references** everywhere else are a `NamedReference`: an id and a label, so a parent seeing a teacher's name on a period does not thereby get a staff directory.

A stored value the contract cannot carry drops its block rather than failing the request, with two exceptions: an audit action or summary is projected verbatim, because a value that outgrew the contract should be loud rather than quietly truncated.

## Jobs: import preview and export

An import preview validates the sheet server-side, stages only the rows that passed together with the errors for the rest, and expires in an hour. The client cannot mark a row valid; there is no such field in the contract. An admission number in the sheet is optional: a school migrating its old register keeps the number it typed, which must still be free in this school and unique within the sheet, and a blank one is assigned at commit. The preview answers with a `rows` list of the rows that passed, each with its sheet row number, name and the admission number it keeps, so a row without one reads as "will be assigned" rather than as a number that might change. The commit locks the school, takes `FOR UPDATE` on the preview, checks it is pending, unexpired, in this school, created by this membership and at the stated version, re-validates every stored row, allocates a number for each row that has none in row order, and only then inserts. A row that has become impossible since the preview, usually an admission number taken meanwhile, rejects the whole commit with nothing written. Promotion never renumbers a student.

An export endpoint records a job and then makes its file. It counts the requested ids through the export plan in SQL and refuses the whole set if any one is unreachable, then writes an `export_jobs` row carrying the permission it was authorized under, the caller's access version, the criteria, the assurance that request had reached, a row count and an expiry. The stored assurance matters because the daily route builds a queued job later: it replays exactly that value rather than assuming a second factor, so a file asked for on a single-factor session never holds a row that session could not have read, and a row that names no assurance is read as `single_factor`.

`GET /exports/:jobId` re-decides that recorded permission on every poll and answers `expired`, persisting it, when the job has aged out, when the caller's access version has moved, when the recorded permission is no longer known or when the caller may no longer do that thing. A job whose criteria names one record, `student_profile` or `staff_profile`, has that record decided again as well, so a child who moved to another class takes the file with them. A job of another membership is `RESOURCE_NOT_FOUND`; its existence is never revealed.

Six kinds of job exist: `students`, `staff` and `audit` produce a spreadsheet, `student_profile` and `staff_profile` produce a document, and `timetable` produces whichever the request asked for. The producers live in [`apps/api/src/exports`](../../apps/api/src/exports) and each one is registered by kind, so a route never names a file format and the runner never names a kind.

A producer re-reads its records in SQL under the requester's own plan at the moment the file is made, never from what was visible when the job was asked for, and a single-record producer re-decides that record first. Fields are gated block by block, exactly as the detail route gates them, so a file never carries a column its requester could not have read on screen. A job of at most `EXPORT_INLINE_MAX_ROWS` rows (5000) is produced inside the request that asked for it and comes back `ready`, so the person downloads it straight away; anything larger stays `queued` for the daily maintenance route. Production runs inside a savepoint: a failure rolls back to it, records the job as `failed` and leaves no file in the store.

`GET /exports/:jobId/file` applies exactly the checks the status route applies, including the record re-check above, and then streams the bytes. The storage key is server state: it is built from the school id, the job id and the format, and it never appears in a body, a header, a log line or an error. The row names its file before the bytes are written, so a step that fails afterwards still leaves something the sweep can find, and the response type is the job row's own `content_type`: the object store is asked for bytes only and never for what they are. One audit row is written per download, naming the job and nothing personal. A ready file lives for twenty-four hours from the moment its bytes exist, and the daily sweep removes the bytes before it removes the row.

## Server-assigned numbers

The office never types an admission number or an employee code. An admission number is `<school short name>/<academic year name>/<counter>`, for example `SVM/2026-27/014`, and the counter restarts at 1 in each academic year; the year is the year of the section the student is admitted into, so the number and the enrolment always agree. An employee code is `<school short name>-E<counter>`, for example `SVM-E007`, from one school-wide counter that never restarts. The short name is upper cased and trimmed, and the counter is padded to three digits and widened past 999 rather than truncated.

The counters live in `number_sequences`, keyed by `(school_id, kind, period)`, where `kind` is `admission` or `employee` and `period` is the academic year id for admissions and empty for employee codes. A row is created on first use. Every allocation happens inside the same `withTenantTransaction` as the insert it numbers, after that write has taken the school lock, in one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` statement, so two admissions committed at once queue on the same row and take consecutive numbers with no gap and no repeat.

`UNIQUE (school_id, admission_number)` and `UNIQUE (school_id, employee_code)` remain the last line of defence. A violation there means the allocator is wrong, not that the caller asked for something invalid, so it surfaces as `SERVICE_UNAVAILABLE`. Neither value can be set or changed through any endpoint: both create requests are strict objects without the field, and no update request carries it.

## Document download

`GET /students/:studentId/documents/:documentId/content` is one of the two routes that return bytes; the other is the export file download above. It decides the module action, then the record, and reports every denial as `RESOURCE_NOT_FOUND` so that a real id and an invented one look the same. The document must belong to the student in the path, or it is not found. Missing bytes roll the transaction back and write no audit row: nothing was delivered, so there is no download to record, and a caller cannot write audit rows by guessing ids. A successful read writes exactly one audit row and commits before the stream is attached, so the record says an authorized read began, not that the transfer finished. The filename in the `content-disposition` header is sanitised of newlines, quotes, backslashes and non-printable characters, the response is `no-store`, and the storage key never leaves the server.

## Data lifecycle: consent, sealed identifiers and anonymisation

Task 12 added five things to this module set. They are ordinary protected routes: the gate, the plan predicate, the school lock, the version check and the single audit row are unchanged.

**Reading only what the caller asked for.** `students/reads.ts` no longer has one projection. `studentProjection({ sensitive, medical })` builds the select list, and the roster, the count and the search always build it with both false, so a caller holding only `students.read_basic` runs a statement that names no medical note, no address, no Aadhaar fragment and no APAAR column. Only the detail route passes `true`, and only after it has decided `students.read_sensitive` and `students.read_medical` on that record, which is why the decision now happens before the read rather than during the projection.

**The APAAR id is sealed.** `modules/shared/crypto.ts` has `seal`, `open` and `maskApaar`. A write encrypts the value with AES-256-GCM under `DATA_ENCRYPTION_KEY` and stores `v1.<iv>.<tag>.<ciphertext>` in base64url in `students.apaar_ciphertext`, with the last four digits alongside in `apaar_last4`. The key never reaches the database, the version prefix leaves room for a second key or algorithm, and `open` refuses a tampered, wrongly keyed or wrongly versioned value rather than returning something. Reads show `apaarMasked` built from the last four digits. `GET /students/:studentId/apaar` is the only way to the full value: it decides the record under `students.read_sensitive`, opens the ciphertext and writes an audit row reading "Revealed the full APAAR id." Search never matches on it, because no search statement selects the column.

**Aadhaar and PAN are sealed the same way.** The office feedback work (September 2026) added a pupil's whole Aadhaar number and a guardian's PAN and Aadhaar number. Each one goes through the same `seal` and `open` as the APAAR id, into its own `*_ciphertext` column, with `*_last4` beside it written in the same statement so the two can never disagree; the database checks the shape of the last four. A write takes the whole number and a `null` clears both columns at once. Every read projects the last digits only, and the two reveal routes above are the only way to a whole number. Anonymising a pupil clears the encrypted number; anonymising a guardian who has no child left clears the office address and both numbers.

**A photograph is bytes in the private store.** The key is `photos/<schoolId>/<kind>/<recordId>-<random>` and it appears in no body, no header, no log line and no audit row. The upload routes live in their own encapsulated Fastify plugin with an `image/*` parser and a hard body limit, so no other route in the app accepts an image body. The type is decided by the first bytes and never by the name or the claimed type; JPEG, PNG and WebP up to 1 MB are accepted and everything else is `INVALID_REQUEST` with the reason left in the server log. A JPEG loses its APP1 to APP15 and COM blocks, a PNG its text and EXIF chunks and a WebP its EXIF and XMP chunks before the bytes are stored, so the camera's own notes, including where the picture was taken, do not travel. Each of the three is rebuilt from the parts that were actually walked, so a file whose own structure does not add up is refused rather than half stored. A write decides before it stores: inside one transaction it locks the school, re-decides the record, loads the row, checks the `photographs` consent for a pupil and the quoted version, and only then writes the bytes and updates the row. A caller who may not edit the record, an id that is not there, a family that has not agreed and a stale version therefore leave nothing at all in the store. If anything after the write fails, the new bytes are removed again and a removal that itself fails is counted in the error reporter, without the key; the old bytes go only after the commit. An upload whose `content-length` is over the limit is answered with a plain `413` and a readable message before a byte of it is read. A read writes no audit row and answers `cache-control: private, no-store` and `x-content-type-options: nosniff` with a neutral file name. A pupil's picture also needs the `photographs` consent: withdrawing it clears the columns in the same transaction as the consent row and removes the bytes after the commit, and anonymisation does the same.

**Consent is an event log.** `guardian_consents` refuses UPDATE and DELETE, so recording and withdrawing are both inserts and the current answer for a purpose is the newest row. `recordConsents(conn, context, studentId, entries)` in `modules/students/consents.ts` is the one insertion path: it checks every guardian id against `student_guardians` for this school and student and refuses the whole request as `INVALID_REQUEST` if one is not linked, forces `method` to `portal` when the actor's own membership is linked to that guardian, and writes exactly one audit row carrying the purposes and statuses and never the evidence text. Admission calls it after the guardian links exist, mapping each `consents[].guardianIndex` into its own `guardians` array and refusing an index outside that array before anything is written. The list returns `DISTINCT ON (guardian_id, purpose)` newest rows with the guardian's display name and `recordedBy` of `office` or `guardian`.

**Anonymisation is a decision, not a timer.** Nothing deletes a person. `POST /students/:studentId/anonymise` refuses unless the pupil has left and the leaving date is at least `RETENTION.studentSensitiveYears` old, compared by the database against its own clock so a wrongly dated API host cannot shorten the period. It clears the sensitive, medical and address columns, blanks `file_name` and `storage_key` to `''` and removes the document bytes through the storage adapter once the transaction has committed (the rows stay, because `DELETE` is revoked from the runtime login), sets `anonymised_at`, bumps the version, and then anonymises every linked guardian who has no other student left un-anonymised. The register fields — name, admission number, status, admission date and every enrolment — stay, because a school must keep its admission register. `POST /students/:studentId/guardians/:guardianId/unlink` removes one link, refuses to remove the last guardian of an active pupil, and anonymises the guardian when no link remains. `POST /staff/:staffId/anonymise` does the same for an ex-employee after `RETENTION.staffPrivateYears`, keeping the display name, employee code, designation, department, employment dates and status. Each of the three writes one audit row whose reason is stored as a note.

**Reasons are notes, not audit fields.** `recordAuditEvent` takes an optional `note` and writes it to `audit_event_notes` in the same transaction; `ModuleAuditEntry` carries it through `writeAudit`. `safe_changes` stays structural, so no free text from a request body is written into a row that can never be edited. `GET /audit-events` joins the note under the same plan predicate and stops returning it once it is redacted; `POST /audit-events/:eventId/note/redact` marks the row and writes an audit row of its own with no note, because a redaction reason would only put the text back.

**The sweep is outside this module set.** `GET /api/maintenance/sweep` in `apps/api/src/maintenance/routes.ts` is not a `protectedRoute`: it has no session, no school and no audit row, and it exists only when `CRON_SECRET` is configured. It calls the three `SECURITY DEFINER` sweep functions described in [the database foundation](./DATABASE.md) and returns the counts. See [the release runbook](./RELEASE.md#61-the-daily-sweep).

## Read auditing and denials

Task 13 added two rows that no handler writes.

**`auditRead`.** A definition may carry `auditRead: { targetType, param, summary, detail? }`. When the handler has answered and the response has parsed, `protectedRoute` opens a second, short tenant transaction and writes one `allowed` audit row: action is the route's permission, the target is the id in the named path parameter, and `safe_changes` is `detail(result)` or `{}`. It carries six routes today: the student detail (`detail` reports which of `sensitive`, `medical` and `guardianContacts` were in the answer), the student guardians list, the student consents list, the staff detail (`employment`, `private`, `pay`), the APAAR reveal, and the subject-access export. The reveal's handler-written row was removed when it gained `auditRead`, so a reveal leaves exactly one row. Document download keeps its own row inside its own transaction, because it commits before the bytes are attached.

Only reads of one person's record are audited. Lists are not, so the volume follows the number of profiles someone opens rather than how far they page a roster, and the absence of a row means nobody opened that record.

**Denials.** An `ACCESS_DENIED` from the gate or from a handler, raised for a caller whose membership is known, writes one `denied` row in its own transaction before the error is rethrown: action is the route's permission, `targetType` is that permission's resource type, `targetId` is null, the summary reads "Refused: `<permission>` on `<route pattern>`." and `safe_changes` carries the route and the method. The school's audit screen can then answer who tried what. An anonymous refusal has no school and so no row; it appears in the access log only.

In the same transaction the API counts that membership's `denied` rows in the last ten minutes and, at twenty or more, calls `reportDenialBurst` in `apps/api/src/observability.ts`, which sends one Sentry event fingerprinted by membership id with ids as its only tags. See [the release runbook](./RELEASE.md#7-alerting-on-repeated-denied-access).

**The access log** is not part of this module set: `apps/api/src/http/access-log.ts` writes one row per `/api` request, route pattern only, and is described in [the release runbook](./RELEASE.md#63-the-access-log).

## Fees

Task 19. Payments are recorded by hand: cash, cheque, a UPI reference, a bank transfer or a demand draft. There is no gateway, no online payment and no webhook; choosing a gateway is a decision still to take.

**What the school charges.** A fee head is the school's own: any name, a category that only groups heads on a screen, whether it applies to everybody in a class (`class`) or only to a pupil who takes it (`opt_in`: the bus, a sport, a club, an admission fee), and how often it is charged. A structure is the amount of one head, per instalment, for one academic year and one class; a row with no class is for every class and a class row wins over it. An optional fee is a row for one pupil, with dates and, when the fare differs by route, an amount of its own. A concession is basis points of every instalment or an amount off every instalment of one head, with a category from a closed list.

**What a pupil owes is never stored.** `fees/charges.ts` holds one set of common table expressions, `feeFiguresCte`, and the statement, the dues list, the dashboard cards, the files and the balance checks of a collection all read it, so two screens cannot disagree. A head is charged 1, 2, 4 or 12 times a year; instalment k falls due on the first day of its period, counted in months from the first day of the academic year; an instalment counts only when the pupil was enrolled (and taking the optional fee) on some day of its period. Concessions come off each instalment, rounded down to a whole paisa and never more than the instalment. Paid is payments that stand less refunds. "Due so far" is measured against today in the school's timezone.

**Money is whole paise** in a `bigint`, in every contract and in screen state. `toPaise` reads the driver's bigint string and fails the request rather than round.

**The ledger is immutable.** `fee_receipts` and `fee_receipt_lines` take INSERT and nothing else: the database refuses UPDATE and DELETE by trigger and by grant (see [the database foundation](./DATABASE.md#fees)). A refund, a cancelled receipt and an adjustment are new rows; a refund and a cancellation point at the payment through `reverses_receipt_id`. A payment can be cancelled once and only while it has no refund; refunds may be several and never add up to more than the payment, head by head. A cancelled payment is not money: it leaves "paid" and "collected" everywhere.

**Receipt numbers are the server's.** `allocateReceiptNumber` in `modules/shared/sequences.ts` claims `<short name>/<year name>/R<counter>`, for example `SVM/2026-27/R0014`, from `number_sequences` with kind `receipt` and the academic year as the period, inside the transaction that writes the row and after the school lock, so two collections committed at once take consecutive numbers. Every ledger row takes one. No request contract has the field.

**Who reads what.** Every read ANDs `planPredicate(readPlan(conn, context, 'fees.read', 'fee'), feeScopedTable(...))`. A pupil's name and admission number are student data, so the `students.read_basic` plan is ANDed as well. The class on a fee row is read under the `sections.read` plan rather than `students.read_enrollments`: a fee is charged by class, and the accountant holds no enrolment key, so without this the person who keeps the accounts could not see which class a balance belongs to. A parent's plan reaches exactly the rows of their own children, and no head or structure: the statement carries each head's name on the pupil's own line. Totals on the dues list, the collection register and the dashboard are sums in SQL under the same predicates.

**Audit.** Every fee write leaves exactly one row whose action is its permission key, so all of them are in `FINANCE_AUDIT_ACTIONS` and the accountant's audit list is the money trail. `safe_changes` carries ids, kinds, modes and counts. It never carries an amount, a name, a bank reference or a reason: the amount stays in the fee tables, and a reason somebody typed is the row's note, which can be redacted. Reading one pupil's statement or one receipt leaves an `auditRead` row; lists leave none.

**Files.** Three job kinds, one producer each in `apps/api/src/exports/producers`: `fee_receipt` (a designed PDF, under `fees.read`, because the counter has to print one and a parent may have their own), `fee_dues` and `fee_collections` (Excel or PDF, under `fees.export`). Each producer re-reads through the same readers the routes use, under the requester's own plan, when it makes the bytes. `fee_receipt` is a single-record kind, so the status and download routes decide that receipt again.

**Anonymising a pupil** clears `payer_name` on that pupil's receipts, in the same transaction, and counts the rows in the audit entry. The money rows, their numbers and their bank references stay for the eight years the accounts must stand. The reasoning is in [the data protection assessment](../compliance/DATA_PROTECTION.md) section 11.

**Subject access** gains a `fees` block: one statement per academic year the pupil has an enrolment or a ledger row in, decided under `fees.read` on that pupil and omitted, not emptied, when refused.

## Attendance

Task 20. One mark per pupil per school day, marked by the class teacher for the sections they are assigned, corrected by the office, read by a parent for their own children, and a staff register kept by the office. Source: [modules/attendance](../../apps/api/src/modules/attendance) (`figures.ts`, `reads.ts`, `roster.ts`, `months.ts`, `staff.ts`, `exports.ts`).

**Five marks.** `present`, `absent`, `late`, `leave` and `half_day`. In the monthly percentage present and late count as a full day, half_day as half a day, leave is left out of the denominator and absent counts against: percentage = (present + late + half of half_day) over (school days minus leave days). A school day is a day of the academic year that is not a Sunday and not a holiday on the school calendar. `figures.ts` holds one set of common table expressions, `attendanceFiguresCte`, and every screen, file and dashboard figure reads it: the calendar of a window (`att_days`), the enrolment spans in scope (`att_spans`), the newest mark per pupil and date (`att_current`), and the counts (`att_figures`). Days after today in the school's timezone are not counted yet, and a day on which the pupil was not enrolled is not theirs; an unmarked past school day counts against and is reported as `unmarked`. `attendancePercentage` in `@erp/contracts` is the one rounding rule, so the web draws the same figure the API sends.

**Marking is the whole roster.** `PUT /attendance/sections/:sectionId/days/:date` derives the roster from the enrolments covering that date (joined on or before it, not left before it) and refuses a body that names anybody else, or leaves anybody out, with nothing written. It is allowed on today alone, in the school's timezone, for a school day inside the academic year; each refusal carries its reason from the closed list. A second save of the same day writes a new row only for pupils whose mark changed.

**Nothing is edited.** `attendance_entries` and `staff_attendance_entries` take INSERT and nothing else, by grant and by trigger (see [the database foundation](./DATABASE.md#attendance)). Every row carries a `revision` per pupil and date and `supersedes_entry_id`; the current mark is the row with the highest revision, and a unique index makes two rows at one revision impossible. A correction (`POST .../corrections`, `attendance.manage`) is a new row of kind `correction` on any school day up to today; the reason somebody typed is the audit note and is stored nowhere else. The original row stays.

**Who reads what.** Every read ANDs `planPredicate(readPlan(conn, context, 'attendance.read', 'attendance'), attendanceScopedTable(...))` over the marks (`entry`), the section as a register (`roster`) or the pupil as a calendar (`pupil`), and the `students.read_basic` plan for names. A teacher's `assigned_sections` reaches the sections they teach or look after as class teacher, this year, and every mark made in them; a parent's `own_children` reaches their child's marks and month for every year the child was here, through the pupil and never through the current enrolment, and the child's current register through the child; the office reaches the school. The staff register is the same shape over `staff_attendance` (`entry`, `person`), where `self` reaches a person's own row and month.

**The staff register.** Everybody with a joining date on or before the day and no leaving date before it is on it, whatever their status: a person on leave is marked as on leave. The office marks it daily; a body naming the caller's own staff record is refused (`staff_attendance_own_record`), and the body must name everybody else. The accountant reads the register and every month as payroll input and holds no key over pupil attendance.

**Audit.** A save leaves one row under `attendance.record` (or `staff_attendance.record`) naming the section (or the register), the year, the date and the counts; a correction leaves one row under the manage key with the reason as its note. Reading one pupil's month or one staff member's month leaves an `auditRead` row; lists and registers leave none. Nothing attendance is in `FINANCE_AUDIT_ACTIONS`.

**Files.** Three job kinds, one producer each: `attendance_register` (a section's month, Excel with the day grid or a PDF with the summary, under `attendance.export`), `attendance_pupil_month` (a pupil's month as a PDF under `attendance.read`, a single-record kind that the download decides again, so a parent prints their own child's month and nobody else's) and `staff_attendance_register` (under `staff_attendance.export`). Each producer re-reads through the same readers the routes use, under the requester's own plans.

**Anonymising a pupil** clears nothing here: a mark identifies nobody on its own, and the register is one the education rules require. The retention period is the pupil's sensitive period all the same; see [the data protection assessment](../compliance/DATA_PROTECTION.md) section 12.

**Subject access** gains an `attendance` block: one record per academic year the pupil was enrolled in, with every mark and the year's summary, decided under `attendance.read` on that pupil and omitted, not emptied, when refused.

## Subject access

`GET /students/:studentId/subject-access` (`students.export_subject`) answers a parent or the office asking for everything the system holds about one child, as one document, in one audited read. It is an ordinary protected route in `modules/students/subject-access.ts`: one tenant transaction, the student read through the same plan predicate as every other detail read, so an unreachable student is `RESOURCE_NOT_FOUND`.

Inside, each block is decided separately on this record and included only if the caller could already have read it one screen at a time: `students.read_sensitive`, `students.read_medical`, `students.read_guardians` (falling back to `students.read_guardian_contact`), `students.read_enrollments`, `students.read_documents`, `students.read_consents`. `accessHistory` — the audit rows whose target is this student — needs `audit.read` at school scope and is **omitted, not emptied**, when the caller does not hold it, so an absent key is not evidence of an empty history. The sensitive block carries the full APAAR id, opened from the ciphertext, rather than the mask: that is what a subject-access request is for, and the export's own `auditRead` row records that it happened. An anonymised student exports the register fields and enrolments only, because nothing else is left.

Owner and principal hold the permission at school scope; a parent holds it for their own children; no other role holds it.

## What is deliberately not built

- No exam, communication or report module, and no absence notice to a parent.
- No online payment. Fees are recorded by hand; a gateway is a decision still to take, and it would bring a sub-processor, webhooks and reconciliation with it.
- No new permission, no custom role and no membership change. A module that needs a parent linked to a new child has to ask access management for it.
- No expiry sweeper inside these modules: a stale preview or export job is refused when used, and the daily maintenance sweep is what collects the rows.
- No audience redaction inside the audit log beyond the row-level plan.

## Known gaps

Storage and contract mismatches:

- `PUT /grades/:gradeId/subjects` carries no version at all; the whole-set replace plus the pre-write validation is its concurrency story.
- `bell_schedules.grade_ids` is forbidden by a check constraint, so the grade mapping lives in `bell_schedule_grades`.
- `schools.address` and `students.address` and `staff.address` are `jsonb`. A string value is returned as text; any other shape reads as empty or is omitted. The school profile used to read a string address as empty, so opening and saving the profile wiped it; it now reads the string, and a save stores `{ "line": ... }`.
- `StudentSensitive` makes date of birth, gender and admission date mandatory while the columns are nullable, so an old row shows no sensitive block at all. `GuardianPrivate` and `GuardianContact` make an E.164 phone mandatory, so a guardian with no usable number is dropped from a contact list and cannot be linked.
- `export_jobs.status` has a check constraint for the four contract values, and `kind` for the six job kinds; a producer writing anything else would answer `SERVICE_UNAVAILABLE`.
- `AuditEventSummary.action` was widened from `PermissionKey` to a bounded string, because Task 4 writes workflow actions such as `members.invite.accept`. A closed union of permission keys and workflow actions would be better. `outcome` has two values, so an operation that failed is reported as denied; the `result` column still distinguishes them.

Coverage and behaviour:

- `students.read_guardians` at an own-children scope collapses to an empty list, because the guardians table has no student column and the scope term in `packages/authz/src/scope.ts` has no branch for it. No role template grants that combination today.
- Admission never writes `guardian_student_access`, so a parent membership does not automatically gain access to a newly admitted child. That is an access change with an approval state and a version bump, and it belongs to access management.
- `audit.read` and `audit.export` at the `finance` scope select only rows whose action is in `FINANCE_AUDIT_ACTIONS` from `@erp/contracts`, so an accountant's list, count and export are the money trail and an owner's are the whole log.
- The command-menu search returns at most 10 hits of each kind with no count, so a caller cannot tell ten matches from four hundred. It also merges two coverage rows, so a caller without `staff.read_directory` gets `staff: []` rather than a refusal, and a caller denied `students.read_basic` is refused the whole endpoint even if they may read staff.
- The dashboard now answers a whole home screen per audience, not two integers: the day, what needs attention, the school in numbers, class strength, admissions by month, holidays, birthdays, recent activity and the setup checklist. Exams still have no tables. The fee cards are real since Task 19 and the attendance figures since Task 20. The office audience is `owner`, `principal` and `admin`; there is no `clerk` role in this build.
- The promotion reason is validated and then not persisted: operator free text routinely names a child, and audit rows must stay free of personal detail.
- `GET /exports/:jobId` and `GET /exports/:jobId/file` are not in the coverage inventory; their floor is a set of permissions chosen here rather than a documented one, and it is written down as a difference in [operation coverage](./OPERATION_COVERAGE.md).
- `PUT /grades/:gradeId/subjects` answers `GradeSubjectList` where the inventory says `Subject` or `EmptySuccess`, because the request replaces a set and returning the set saves a re-read.
- `staff.assignments` and `staff.sectionAssignments` are gated on `staff.read_employment` and `sections.read` rather than the inventory's `timetable.read`; both are at least as strict. `GET /staff/:staffId` is gated on `staff.read_directory` rather than `staff.read_employment`, because the four staff projection keys are separate checks and the gate has to be the weakest of them. `GET /timetable/substitutions/absent-periods` is gated on `timetable.manage_substitutions` rather than `timetable.read`, which is stricter.
- Bell schedule reads are school-wide rather than matched scope: `timetable.read` is a permission over timetable entries, so no read plan can be built for a bell schedule. What a caller learns beyond their own classes is the period clock and the grade ids.
- `timetable.freeTeachers` accepts either management key inside the handler, but `protectedRoute` takes exactly one gate permission, so a member whose only grant is `timetable.manage_substitutions` through an exception is still refused at the gate. Every role template that grants one grants the other.
- Searches are leading-wildcard `ILIKE` scans with no trigram index, which is fine at fixture scale and will need an index before real data.
- `allowedActionsFor` and `decideResource` reload the policy snapshot and relationship facts on every call, so a detail read makes several snapshot loads where one would do. Correct, and worth caching per transaction in the shared layer.
- There is no way back from anonymisation and no preview of what it will clear beyond the sentence on the screen. The cleared columns are set to null in one statement and the document bytes are gone from storage.
- Nothing prunes `guardian_consents` or `audit_event_notes`. Both are history a school is expected to keep, but neither has a stated retention period of its own.
- Fees: instalments fall due on the first day of each period, counted from the first day of the academic year. A school cannot yet choose its own due dates, and there is no automatic late fee: a fine is a debit adjustment somebody records against a late-fee head.
- Fees: nothing prunes the ledger after its eight years. Like the audit trail, removal at the end of the period is a school decision and a later task.
- Fees: the dues list names no guardian and no phone number, so chasing a balance still means opening the pupil. The accountant holds `students.read_guardian_contact` at the finance scope, so adding it is a projection, not a permission.
- Fees: a concession and an optional fee cannot be edited into another head; they are removed and added again. A concession has no dates of its own and applies to the whole year.
- Fees: there is no online payment gateway. That is a product decision still to take.
- Fees: the database is in the United States. No real school's money goes in until it has moved to an Indian region (Task 17).
- Attendance: a section with nobody enrolled on a day cannot be marked, so it is neither marked nor counted in the office's "registers marked of total".
- Attendance: a pupil moved between sections on the same day would appear on both rosters that day; the write refuses neither, and the pupil's month takes the newest mark.
- Attendance: nothing prunes the marks after the pupil's period, as for the fee ledger; removal at the end of the period is a school decision and a later task.
- Attendance: the school calendar has no working Saturday rule; Saturday is a school day unless it is a holiday, and a school that closes on Saturdays enters them as holidays.
- Attendance: no absence notice goes to a parent; that is Task 22.
- Attendance: a parent may open the class day and the class month of the section their own child currently sits in (the register is a shared row, as a section is), and sees one row, their own child. They learn the class exists and its name, which the timetable already tells them.
- Attendance: a school with two academic years covering the same day gets the calendar of the one with the later start date; the day list, the months and the figures all follow it.
- Attendance: a school that starts using the register part way through a year sees the earlier school days as unmarked, and an unmarked day counts against a pupil in the year's figures (the subject-access summary and a month opened before go-live). Marking those months, or reading only the months since go-live, is the school's call; there is no "register starts on" date.
- `apps/api` still has no lint script, so `pnpm -r lint` does not reach this source.

## Run the tests

The API tests need the same local PostgreSQL database as `packages/db`.

```sh
docker compose -f compose.db.yml up -d --wait
TEST_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp_test pnpm db:test:prepare

pnpm --filter @erp/api typecheck
pnpm --filter @erp/contracts typecheck
pnpm test:api
```

The tests run against the database named by `TEST_DATABASE_URL`, which `apps/api/.env` sets to `erp_test`. The harness derives the `erp_auth`, `erp_identity` and `erp_runtime` URLs from it by swapping the login, and refuses to start when the name is `erp`: that is the development database, for `pnpm dev:api`, `pnpm db:fixtures` and `pnpm --filter @erp/api dev:logins` only. `pnpm db:test:prepare` creates the disposable database, grants schema usage to the three logins and migrates it.

`pnpm test:api` runs every file one at a time against one database, so the files share fixtures. A file that asserts an exact roster, count or empty table clears the rows it owns in its `before` hook and puts back anything it widened in its `after` hook; a file that seeds into a fixture class uses a name of its own, because a section name is unique within a class and a year.

One module's file can be run on its own against a private migrated copy, which is how the modules were written:

```sh
ERP_TEST_DB=erp_m_students pnpm --filter @erp/api exec tsx --test tests/modules-students.test.ts
```

`ERP_TEST_DB` overrides only the database name in `TEST_DATABASE_URL`, so one module can use a private copy without a second URL. Create that copy first with `TEST_DATABASE_URL=...54329/erp_m_students pnpm db:test:prepare`.

The other suites:

```sh
TEST_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp_test pnpm test:db
TEST_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp_test pnpm test:authz
pnpm test:contracts
```

Reset the schema before `test:db`, `test:authz` and `test:security`: the API suite leaves the fixtures rewritten, and the security suite's dashboard file asserts an exact teacher timetable that the API suite has since widened.

## What the tests prove

`pnpm test:api` is 478 tests across 38 files. Task 5 added 159 of them, in ten files: 20 setup, 22 students, 18 students-bulk, 23 staff, 20 timetable, 9 dashboard, 11 search, 10 audit, 21 files and 5 foundation. Task 8 adds 14: five in `sequences.test.ts` (the formatters, and two transactions allocating from one counter at once), and the numbering cases in students (two admissions at once take consecutive numbers; the first admission into another year is 001; a sent number is refused), staff (a sent code is refused; the code comes from the school counter whoever creates the record) and students-bulk (a kept number beside a blank one; a kept number in the school format lifts the counter; a kept number too long for any counter is ignored by it). The other 89 are the Task 2 authentication tests and the Task 4 access tests.

Every module file asserts the same seven shapes for at least its main list and its main detail read, wherever the shape has a meaning for that module: an anonymous caller is refused, a member of one school using the other school's id in the path is refused with `SCHOOL_ACCESS_UNAVAILABLE`, another school's record id through this school's path is not found and leaks nothing, a same-school caller with the wrong relationship gets not found and finds the row absent from the list, a permitted read returns exactly the contract fields, a write body carrying a forbidden field is refused with the database unchanged, and a bulk request with one bad id is rejected whole with nothing written.

Task 13 adds three files: `read-audit.test.ts` (a detail read leaves one `allowed` row naming the blocks, a list leaves none, a refusal leaves one `denied` row the owner sees on `GET /audit-events`, twenty refusals raise exactly one burst report, the APAAR reveal leaves exactly one row), `subject-access.test.ts` (a parent gets their own child with no `accessHistory`, another family's child is not found, the owner gets `accessHistory`, a teacher is refused at the gate, one export leaves one audit row, an anonymised student exports the register fields only) and `access-log.test.ts` (one row per request holding the route pattern and no URL or query, a hashed address, our error code, and nothing at all for the health route).

Task 15 adds `exports-xlsx.test.ts` in `apps/api/tests` (the spreadsheet helper, with no database), and the adversarial half lives in `tests/security/export-files.test.ts`: another school's student, staff, section or year answers exactly as a missing record and writes no job row; a teacher holds no export key for any pupil, in their own section or outside it; a teacher exports the week they teach and gets `RESOURCE_NOT_FOUND`, with no job row at all, for one they do not; a parent is refused every record export and cannot see or download another member's job; and a ready file is downloadable once, by its requester only, with one audit row and no storage key in any header.

Task 18 adds 20 tests to the existing module files and one adversarial file, `tests/security/screen-contract-gaps.test.ts` (6). The module tests cover the member directory filters (each of status, role, `staffId` and search narrows the page and the total; a search finds somebody named only by their login; a `%` or `_` is looked for literally; an unknown query key is `INVALID_REQUEST`; another school's staff id finds nobody), the guardian version a correction has to send back and the conflict a stale one gets, a leaving date that is set, read back and cleared with `null` and never on a directory row, the class teacher name seen by an office reader, a teacher and a parent, `allowedActions` on every setup record, a refused delete and its reason with nothing deleted and no audit row, the audit outcome filter on its own and on top of the accountant's finance scope, a class of 105 previewed as two pages with the right total, and the version of a school profile, a holiday and a bell schedule starting at 1 and refusing the loser of a race. The security file asks the adversarial half: a filter is not a way round `members.read`, a school id in the path is not a school the caller belongs to, a search never crosses the boundary, a class teacher is not named to somebody who may not read that record and cannot be written in from another school, and every page of a roster follows the same read plan while a teacher is refused both the preview and the run. `pnpm test:contracts` gains two: a refusal reason must be one of the named blockers, and the member directory filters are a closed list.

The class teacher post became a relationship straight after Task 18, because a class teacher with no subject in their own class could not open it. `tests/security/class-teacher-scope.test.ts` asks where that stops, with a teacher who teaches nothing: their own section and its pupils and no other, not a class of a closed year, not another school's section through this school's path, no `sections.manage`, and nothing at all the moment the post is taken away.

Task 19 adds `modules-fees.test.ts` (18) and `modules-fees-exports.test.ts` (6) to `apps/api/tests`, fee cases to `subject-access.test.ts` and `modules-lifecycle.test.ts`, four fee plan cases to `packages/authz/tests/scope.test.ts`, `packages/db/tests/fees-ledger.test.mjs` (4: the runtime login cannot UPDATE an amount or DELETE a ledger row, may clear `payer_name` and nothing else, and RLS hides another school's fee rows), and `tests/security/fees.test.ts` (10). The module file proves the arithmetic (a class amount beats the every-class amount, twelve monthly instalments of which only those fallen due count, a September joiner owes nothing for April, an optional fee at its own amount and only while it lasts, a percentage rounding down and an amount concession stopping at the instalment), the ledger (a server-made receipt number, a body naming a receipt number, a school id, a float or a negative amount refused with nothing written, more than the balance refused with its reason, two collections at once taking consecutive numbers, a refund capped by the payment, one cancellation per payment, a cancelled payment no longer counting as paid, adjustments both ways), the audit row of a collection carrying exactly `academicYearId`, `lineCount`, `mode`, `receiptId` and `studentId` with the refund's reason in the note only, dues totals that cover every page, the register and its detail agreeing, and the accountant's money card matching the register. The security file asks the adversarial half: a teacher refused on all 24 fee routes with one denied row each and no fee row changed; a parent reading their own child and 404 for another family's child and receipt, with lists and totals that cover their children alone, empty heads and structures, every write refused and their own receipt still printable; the admin collecting and refused every manage route and both list exports; the accountant doing the lot with a money-only audit trail; school B's pupil, receipt, head, structure, optional fee and concession ids answering byte for byte like invented ones on reads and writes with school B unchanged; a collect body naming school B's year or head refused; a single-factor owner `MFA_REQUIRED`; and the promoted child whose closed year stays readable to the parent while another family stays 404 in both years.

Task 20 adds `modules-attendance.test.ts` (18) and `modules-attendance-exports.test.ts` (6) to `apps/api/tests`, an attendance case to `subject-access.test.ts` and the new attention key to `modules-dashboard.test.ts`, five attendance plan cases to `packages/authz/tests/scope.test.ts`, `packages/db/tests/attendance-immutable.test.mjs` (5: the runtime login cannot UPDATE or DELETE a mark of either register, two rows at one revision are refused while the next revision is taken, and RLS hides and refuses another school's rows), and `tests/security/attendance.test.ts` (8). The module file proves the register (a day list unmarked and then marked with its counts and last save; revision 1 for the whole roll with one audit row carrying exactly the section, year, date, pupil count, changed count and the five counts and no note; a second save superseding only the pupil whose mark changed with the first row still there; an invented pupil and a pupil of the class next door refused as not on the roster, a short body as incomplete, and nothing written either way; a Sunday, a holiday, a day outside the year and a future day refused with their reasons on the write and the correction alike, and the same reasons in the day's `window`), the correction (yesterday closed to the teacher and open to the office, leaving revision 1, writing revision 2 of kind `correction` and one audit row whose note is the reason and whose `safe_changes` carries none), the figures (a pupil's month re-derived independently, the percentage recomputed with `attendancePercentage`, leave out of the denominator, a future day and an unmarked day counted as the rule says, the `auditRead` row, a month outside every year refused with its reason, and the section month agreeing with the pupil months row by row), the staff register (marked whole, the caller's own row and a short register refused, a correction with its note, one person's own month, the accountant reading and refused both writes) and the dashboard blocks. The security file asks the adversarial half: school B's section, mark, pupil and staff ids answering exactly like invented ids on every read and write, and B's pupil or staff member in A's body refused as not on the roster; a teacher of the class next door missing it from the list, 404 on its roster and refused on a mark; an assignment that ended taking the class away; the class teacher marking their own class only, with list and detail agreeing; a parent reading this year and the closed year after promotion, 404 for another family in both, and refused every write; the accountant refused on all eight pupil routes and reading the staff register; a teacher seeing one row of the staff register and refused every write; every refusal measured against a fingerprint of both registers and the exact growth of denied audit rows. On a fresh `erp_test` the counts are: contracts 37, db 41, authz 64, api 503, web 352, security 100.

The scope assertions are built from real scopes rather than from a caller who holds nothing: a teacher with one teaching assignment, a parent of one child, an accountant at finance scope, an administrator whose role lost one key. Several tests were written specifically to fail if the plan predicate were removed from a query, which is what keeps "a list contains a row if and only if the detail read allows it" a property and not a claim.
