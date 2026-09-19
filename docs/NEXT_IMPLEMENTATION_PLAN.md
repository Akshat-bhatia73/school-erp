# Next implementation plan: readiness and the first school modules

Date: 19 September 2026. Status: proposed, for review. Follows [AUTH_RBAC_IMPLEMENTATION_PLAN.md](AUTH_RBAC_IMPLEMENTATION_PLAN.md), whose fourteen tasks are delivered and live at erp.akshat-bhatia.com with test data. Nothing in this document is started.

## 1. Where we are

The platform has real login, fixed roles with relationship scope, tenant isolation enforced in the database, an audit trail that records reads, writes and refusals, consent and retention lifecycle, an access log, lockout, a subject-access export, branch protection and a runbook for incidents. It has students, staff, setup and timetable. It has no fees, attendance, exams, communication or report cards, and the accountant's home screen says so.

Two kinds of work remain. The first makes the platform fit for a real school's data: things the assessment and the release left open. The second builds the modules schools actually buy. The first must finish before the second goes live, but they can be built side by side.

## 2. Rules every task inherits

These come from the repository guide and the auth plan and are not repeated per task.

- Every route goes through `protectedRoute`, every list is narrowed by `planPredicate`, every write locks the school, re-decides the record, bumps the version and writes exactly one audit row. Free text a person typed goes to `note`, never to `safe_changes`.
- A reserved permission becomes active by editing the catalogue and the role templates, regenerating the matrix, and adding the grants to existing schools with `pnpm db:sync-roles` at release. Never invent a permission a route needs; the reserved names in `packages/contracts/src/permissions.ts` are the vocabulary.
- Every new personal-data field gets a row in the retention schedule and, if it is a new purpose, a consent purpose; the privacy notice, the processing agreement and the sub-processor list change in the same pull request as the code.
- Every module ships its cross-school and same-school wrong-person tests in `tests/security`, and a subject-access export that includes its data for the student.
- Work is specified in this document first, implemented by agents against that specification, verified by running every suite on a recreated database and by a production smoke as a test owner, and released with the checklist in `docs/auth/RELEASE.md` (migrate, sync roles, smoke).
- Money is stored in integer paise, never floats. Dates stay ISO in state. Indian formats on screen.

## 3. Readiness tasks

### Task 15: Export files and downloads

Students, staff and the audit log already queue export jobs that record who asked, under which permission and at which access version, but no file is ever produced or served. Build the producer that runs at request time for small sets and through the daily maintenance route for the rest, writes a CSV to the private document store, and the download route that re-checks the access version before streaming, like documents do today. Include the fee, attendance and exam exports once those modules exist by giving the producer one interface per job kind. Retention: files expire with the job (already 24 hours). Exit check: an owner downloads a roster export; a teacher's export contains only their sections; a job made before a role change is refused on download; the file is gone after expiry.

### Task 16: Real delivery for parents

Email goes through Resend; text messages are still held in the database for testers. Choose an Indian SMS provider that supports DLT registration (MSG91 or a comparable provider), register the sender id and the templates for one-time code, invitation and recovery, and add the adapter behind `DELIVERY_MODE=provider`. Keep the held-message route for test builds. Record the provider in the sub-processor list with its region. Exit check: a parent with a real number signs in by code on production; a delivery failure shows a retryable state and never a false "sent"; the held-message route is absent in production.

### Task 17: Operations readiness

Everything that keeps the platform running when something goes wrong, most of it decided but not done.

- Escrow `DATA_ENCRYPTION_KEY` and `AUTH_SECRET` in the password manager and write where they live into the runbook.
- Schedule the weekly encrypted dump to an Indian-region bucket, with a named key holder, and back up the Vercel Blob documents the same way.
- Perform and log the first restore rehearsal against a production branch.
- Create the Sentry alert on the denial burst and confirm it arrives.
- Move the database to an Indian region as `docs/compliance/HOSTING_REGION.md` recommends, and set the function region to `bom1`, before the first real school, so the CERT-In log requirement is met.
- Pin `xlsx` to a registry version so Dependabot's lockfile regeneration installs.
- Move the repository to a paid GitHub plan and make it private without losing branch protection.

Exit check: every release checklist line is signed; the restore log has one passed production entry; the sub-processor list names an Indian database region.

### Task 18: Screen and contract gaps

The gaps listed under "Known gaps" in `docs/auth/WEB_SCREENS.md` and `docs/auth/PROTECTED_APIS.md`, grouped into one task so they stop being carried forward: the school context names the current academic year; `GET /staff` and `GET /members` gain the filters the screens fake today; `GuardianPrivate` carries a version so a guardian can be corrected; `StaffDetailResponse` returns the leaving date; a section names its class teacher; setup records carry `allowedActions`; refused deletes say why; the audit list accepts an `outcome` filter server side; promotion handles more than one hundred students by paging; `schools`, `holidays` and `bell_schedules` get real version columns. Exit check: the two known-gap sections are empty or name only deliberate decisions.

## 4. Module tasks

Each module follows the same shape: contracts and permissions first, then migration, then API, then screens, then documents, then the security and browser tests, then release. The reserved permissions already fix the scopes; the descriptions below say what the scopes mean in practice.

### Task 19: Fees

The module schools ask for first and the one with the most sensitive data. Fee heads and structures per academic year and grade, with optional concessions per student; a statement per student showing dues, payments and balance; collection by the office with a receipt number assigned by the server (a counter per school and year, as admission numbers are); refunds and adjustments with a reason as a note; a dues list per class; a parent view of their own children's statements and receipts. Permissions: `fees.read` (school, own_children, finance), `fees.collect`, `fees.manage`, `fees.export` (school, finance). Owner, principal and accountant hold manage, collect and export; the office clerk role does not exist, so admin holds collect; parent holds read at own_children; teacher holds nothing. The accountant dashboard shows today's collection and outstanding dues. Money in paise; receipts are immutable rows, corrections are new rows. Retention: eight years after the last transaction, as for staff pay. Online payment is out of scope until a gateway is chosen; record it as a decision to take. Exit check: a parent sees only their children's statements; an accountant collects and the receipt appears in the audit trail without the amount in `safe_changes`; a teacher gets 403 on every fee route; two collections committed at once get consecutive receipt numbers.

### Task 20: Attendance

Daily attendance per section marked by the class teacher for the sections they are assigned, with present, absent, late and leave; corrections by the office; a per-student calendar and a monthly percentage; a parent view of their children; a staff attendance register kept by the office. Permissions: `attendance.read` (school, assigned_sections, own_children, own_record), `attendance.record` (school, assigned_sections), `attendance.manage`, `attendance.export`; `staff_attendance.*` for the register. A teacher can mark only sections with a live teaching assignment for that day; the lock is the section and the date. Absence notices to parents wait for Task 22. Retention: the student's enrolment plus three years, as sensitive fields. Exit check: a teacher cannot mark a section they left last month; a parent sees their own child's month and nobody else's; a correction leaves the original row and a note.

### Task 21: Exams and report cards

Exam definitions per academic year (terms, subjects, maximum marks, grading scheme); marks entry by the subject teacher for their assigned section and subject; moderation and publishing by the office; report cards generated from published marks and attendance, readable by parents once published, exportable as a file through Task 15. Permissions: `exams.read`, `exams.record_marks` (assigned_sections, assigned_subjects), `exams.manage`, `exams.publish`, `exams.export`, `report_cards.*`. Unpublished marks are never visible to a parent or a student, by scope not by a flag on the screen. Exit check: a teacher enters marks only for their subject in their section; a parent sees nothing until publish and everything permitted after; the report card export is audited and goes through the download route.

### Task 22: Communication

Notices from the school to a class, a grade or the whole school; messages to a parent about their child; delivery by email and text through Task 16; a record of what was sent, to whom and when; templates for the recurring notices. Permissions: `communication.read`, `communication.send` (school, assigned_sections), `communication.manage`, `communication.export`. The `communication` consent purpose gates every message to a parent: no consent, no message, and the record says so. Exit check: a teacher sends only to their sections; a parent who withdrew consent receives nothing and the attempt is recorded; message bodies are never in a log or in `safe_changes`.

### Task 23: Student login

Identity and permissions were designed in the auth plan and every activation path is disabled. Activate for secondary students only, by invitation from a guardian who holds the child's portal access, with the student's own published information (timetable, attendance, published marks, notices) and nothing financial or administrative. Depends on Tasks 20 to 22 having something to show. Exit check: the acceptance matrix rows for student identity flip from "rejected" to "permitted for own record only" and the security suite proves both.

### Out of scope for this plan

The AI assistant, custom role building, a policy editor, native apps, offline data and online payment collection. The permission names for the assistant stay reserved.

## 5. Order

| Wave | Work |
|---|---|
| 1 | Task 17 items that need only an operator: key escrow, Sentry alert, restore rehearsal, `xlsx` pin. Task 15 and Task 18 in parallel. |
| 2 | Task 16 (provider registration has lead time; start it first). Task 19 fees. |
| 3 | Task 17 region move, before any real school. Task 20 attendance. |
| 4 | Task 21 exams and report cards, then Task 22 communication. |
| 5 | Task 23 student login. |

The readiness tasks are the release gate for the first paying school; the module tasks decide what that school gets. Fees can be built while the region move is pending, but must not hold real money before it.

## 6. Decisions to take before starting

| Decision | Owner | Needed by |
|---|---|---|
| SMS provider and DLT registration entity | Product owner | Task 16 |
| Database provider and region for the move | Product owner | Task 17 |
| GitHub paid plan and repository visibility | Product owner | Task 17 |
| Online payment gateway, or none for now | Product owner | Task 19 |
| Which school is first, and its fee structure and grading scheme, to shape the fixtures | Product owner | Tasks 19 and 21 |
| Named holders for the backup key and the security contact address | Product owner | Task 17 |
