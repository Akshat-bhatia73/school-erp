# Next implementation plan: readiness and the first school modules

Date: 19 September 2026. Status: proposed, for review. Follows [AUTH_RBAC_IMPLEMENTATION_PLAN.md](AUTH_RBAC_IMPLEMENTATION_PLAN.md), whose fourteen tasks are delivered and live at erp.akshat-bhatia.com with test data. Tasks 15, 18, 19, 20, 21, 22 and 23 are built; Tasks 16 and 17 are not started.

## 1. Where we are

The platform has real login, fixed roles with relationship scope, tenant isolation enforced in the database, an audit trail that records reads, writes and refusals, consent and retention lifecycle, an access log, lockout, a subject-access export, branch protection and a runbook for incidents. It has students, staff, setup and timetable. It has fees (Task 19, September 2026), attendance (Task 20, September 2026) and exams and report cards (Task 21, September 2026). It has messages to families and staff, in the app and by email (Task 22, September 2026).

Two kinds of work remain. The first makes the platform fit for a real school's data: things the assessment and the release left open. The second builds the modules schools actually buy. The first must finish before the second goes live, but they can be built side by side.

## 2. Rules every task inherits

These come from the repository guide and the auth plan and are not repeated per task.

- Every route goes through `protectedRoute`, every list is narrowed by `planPredicate`, every write locks the school, re-decides the record, bumps the version and writes exactly one audit row. Free text a person typed goes to `note`, never to `safe_changes`.
- A reserved permission becomes active by editing the catalogue and the role templates, regenerating the matrix, and adding the grants to existing schools with `pnpm db:sync-roles` at release. Never invent a permission a route needs; the reserved names in `packages/contracts/src/permissions.ts` are the vocabulary.
- Every new personal-data field gets a row in the retention schedule and, if it is a new purpose, a consent purpose; the privacy notice, the processing agreement and the sub-processor list change in the same pull request as the code.
- Every module ships its cross-school and same-school wrong-person tests in `tests/security`, and a subject-access export that includes its data for the student.
- Work is specified in this document first, implemented by agents against that specification, verified by running every suite on a recreated database and by a production smoke as a test owner, and released with the checklist in `docs/auth/RELEASE.md` (migrate, sync roles, smoke).
- Money is stored in integer paise, never floats. Dates stay ISO in state. Indian formats on screen.
- A parent reads their own child's record for every year the child was at the school, not only the current one. Decided on 21 September 2026: the parent was handed the same papers at the time (receipts, report cards, attendance), the parent is the one who consents for a minor and has a right of access to the child's data, and the subject-access export already gives them the whole record. The boundary is the child, not the year.
  - Every row that belongs to one pupil (fee statements and receipts, attendance, marks and report cards, enrolments, consents, documents) answers the `own_children` scope through its pupil, never through the section or the current enrolment. A module that asks "is my child enrolled behind this row today" loses last year's data on promotion day; that is a bug.
  - Shared records stay as they are: a section, its roster, a class timetable and staff details answer `own_children` through the child's current enrolment only, so last year's class is not readable as a class, and another child's data never is.
  - It ends when access ends. Revoking guardian access or removing the link removes every year at once. After a child leaves, the closed record stays readable until retention or anonymisation removes it.
  - A parent holds no `academic_years.read` and does not need it: a parent screen offers the years from the child's own enrolments, with the current year first.
  - Every module's wrong-person tests include the promoted child: after promotion the parent still reads last year's rows for their own child, and still reads nothing of another family's child in either year.

## 3. Readiness tasks

### Task 15: Export files and downloads — built, 19 September 2026

Students, staff and the audit log already queued export jobs that record who asked, under which permission and at which access version, but no file was ever produced or served. Built as one producer per job kind in `apps/api/src/exports`, run inside the request for sets of at most 5000 rows and through the daily maintenance route for the rest, with `GET /exports/:jobId/file` re-checking the owner, the expiry, the access version and the permission before it streams. Each producer re-reads its records under the requester's own plan when it makes the bytes, so a file never carries a row or a field its requester could not read on screen. Files are kept 24 hours from the moment they are ready and the daily sweep removes the bytes before the row.

Two decisions taken while building it, on 19 September 2026. The files are Excel and PDF, not CSV: a spreadsheet is what an office opens, and a single record reads as a document. And two kinds of export beyond the queued lists were added, because the screens needed them: one student's or one staff member's record as a PDF (`POST /students/:studentId/export-profile`, `POST /staff/:staffId/export-profile`, under `students.export` and `staff.export`), and one week of the timetable as either format (`POST /timetable/export`, under `timetable.read`, because exporting a timetable is reading it in another format).

Exit check met: an owner downloads a roster export and a record as a PDF (`tests/browser/tests/exports.spec.ts`); a teacher exports their own week and nothing beside it, another school's ids answer like missing records, a parent reaches none of it and one member's job is invisible to another (`tests/security/export-files.test.ts`); a job made before an access change is refused on download (`tests/security/lifecycle-and-concurrency.test.ts`); the file is gone after expiry, through the daily sweep.

Still open: the fee, attendance and exam exports plug in as new job kinds once those modules exist.

### Task 16: Real delivery for parents

Email goes through Resend; text messages are still held in the database for testers. Choose an Indian SMS provider that supports DLT registration (MSG91 or a comparable provider), register the sender id and the templates for one-time code, invitation and recovery, and add the adapter behind `DELIVERY_MODE=provider`. Keep the held-message route for test builds. Record the provider in the sub-processor list with its region. Exit check: a parent with a real number signs in by code on production; a delivery failure shows a retryable state and never a false "sent"; the held-message route is absent in production.

### Task 17: Operations readiness

Everything that keeps the platform running when something goes wrong, most of it decided but not done.

- Escrow `DATA_ENCRYPTION_KEY` and `AUTH_SECRET` in the password manager and write where they live into the runbook.
- Schedule the weekly encrypted dump to an Indian-region bucket, with a named key holder, and back up the Vercel Blob documents the same way.
- Perform and log the first restore rehearsal against a production branch.
- Create the Sentry alert on the denial burst and confirm it arrives.
- Move the database to an Indian region as `docs/compliance/HOSTING_REGION.md` recommends, and set the function region to `bom1`, before the first real school, so the CERT-In log requirement is met. Decided on 23 September 2026: the test environment stays on Neon in us-east-1 until the first real customer signs; the move happens then, before any of their data goes in, and the database stays with Neon.
- Done, 21 September 2026: `xlsx` is pinned to the registry as `npm:@e965/xlsx@0.20.3`, a mirror of the official SheetJS 0.20.3 tarball. The npm package named `xlsx` stopped at 0.18.5 and carries two high advisories, so it was never an option. Before accepting a version bump, unpack the mirror and the tarball from `cdn.sheetjs.com` and compare them: for 0.20.3 only `README.md` and the name and repository in `package.json` differ, and there are no install scripts.
- Move the repository to a paid GitHub plan and make it private without losing branch protection.

Exit check: every release checklist line is signed; the restore log has one passed production entry; the sub-processor list names an Indian database region.

### Task 18: Screen and contract gaps — built, 21 September 2026

The gaps listed under "Known gaps" in `docs/auth/WEB_SCREENS.md` and `docs/auth/PROTECTED_APIS.md`, grouped into one task so they stop being carried forward. Built with no new route, no new permission and no role template change: `GET /members` filters on `search`, `role`, `status` and `staffId` in the query rather than in the browser; `GuardianPrivate` carries a version so a guardian already on file can be corrected; `StaffEmployment` returns the leaving date, so the sheet can clear one; a section names its class teacher through the staff directory plan; every setup record carries `allowedActions`; a refused delete carries a `reason` from a closed list and the sentence that goes with it; `GET /audit-events` takes an `outcome`; the promotion preview pages with a total, so a class of any size is promoted in runs of a hundred; and migration `0014_setup_versions.sql` gives `schools`, `holidays` and `bell_schedules` real version columns.

One decision taken while building it, on 21 September 2026. The school context does not name the current academic year and is not going to. Every member asks `GET /academic-years/current` instead, which is gated on `holidays.read` and so open to every role, and `useAcademicYear` reads it rather than guessing from the sections a teacher can see. One small read every role may make is simpler than widening the session context for a teacher or a parent. Recorded as a deliberate decision alongside the second one: a section shows "Assigned" when its class teacher is somebody the viewer may not read.

Exit check met: both known-gap sections now name only gaps this task did not take on and two deliberate decisions. Twenty new API tests cover the filters, the versions, the reasons, the class teacher and the paging, and `tests/security/screen-contract-gaps.test.ts` asks the wrong-person half of each widened read.

## 4. Module tasks

Each module follows the same shape: contracts and permissions first, then migration, then API, then screens, then documents, then the security and browser tests, then release. The reserved permissions already fix the scopes; the descriptions below say what the scopes mean in practice.

### Task 19: Fees — built, 21 September 2026

The module schools ask for first and the one with the most sensitive data. Fee heads and structures per academic year and grade, with optional concessions per student; a statement per student showing dues, payments and balance; collection by the office with a receipt number assigned by the server (a counter per school and year, as admission numbers are); refunds and adjustments with a reason as a note; a dues list per class; a parent view of their own children's statements and receipts. Permissions: `fees.read` (school, own_children, finance), `fees.collect`, `fees.manage`, `fees.export` (school, finance). Owner, principal and accountant hold manage, collect and export; the office clerk role does not exist, so admin holds collect; parent holds read at own_children; teacher holds nothing. The accountant dashboard shows today's collection and outstanding dues. Money in paise; receipts are immutable rows, corrections are new rows. Retention: eight years after the last transaction, as for staff pay. Online payment is out of scope until a gateway is chosen; record it as a decision to take. A parent reads statements and receipts for every year their child was enrolled, with a year chip built from the child's own enrolments (the rule is in section 2). Exit check: a parent sees only their children's statements, including last year's after a promotion; an accountant collects and the receipt appears in the audit trail without the amount in `safe_changes`; a teacher gets 403 on every fee route; two collections committed at once get consecutive receipt numbers.

Built as specified, with these decisions taken by the product owner before the build. Payments are recorded by hand only (cash, cheque, UPI reference, bank transfer, demand draft): there is no gateway, no online payment and no webhook, and **choosing an online payment gateway is a decision still to take** (section 6). Fee heads are the school's own list, never a fixed enum: a name, a category that only groups them, whether the head applies to everybody in a class or only to pupils who opt in (the bus, a sport, a club), and how often it is charged; an optional fee may carry the pupil's own amount, which is how a bus fare differs by route. The principal holds the same four keys as the owner, the accountant holds them at the finance scope, admin holds collect and read, parent holds read for their own children, teacher holds nothing. One receipt as a document runs under `fees.read`, so the counter and a parent can both print it. Anonymising a pupil keeps the money rows and their bank references for the eight years the accounts must stand, and clears the payer's name. A fee row answers `own_children` through its pupil, never through the current enrolment, so a parent keeps last year's statement and receipts after promotion (the rule in section 2). The release changes the role templates, so every existing school needs `pnpm db:sync-roles` after migration `0015`. The module is described in [PROTECTED_APIS.md](auth/PROTECTED_APIS.md) and [DATA_PROTECTION.md](compliance/DATA_PROTECTION.md) section 11. No real school's money goes in before the region move (Task 17).

### Task 20: Attendance — built, 22 September 2026

Daily attendance per section marked by the class teacher for the sections they are assigned, with present, absent, late, leave and half_day; corrections by the office; a per-student calendar and a monthly percentage; a parent view of their children; a staff attendance register kept by the office. Permissions: `attendance.read` (school, assigned_sections, own_children, own_record), `attendance.record` (school, assigned_sections), `attendance.manage`, `attendance.export`; `staff_attendance.*` for the register. A teacher can mark only sections with a live teaching assignment for that day; the lock is the section and the date. Absence notices to parents wait for Task 22. Retention: the student's enrolment plus three years, as sensitive fields. Exit check: a teacher cannot mark a section they left last month; a parent sees their own child's month and nobody else's; a correction leaves the original row and a note.

Built as specified, with these decisions taken by the product owner before the build. **Five marks**: present, absent, late, leave and half_day. **The monthly percentage** is (present + late + half of half_day) over (school days in the month minus leave days): late counts as a full day, half_day as half, leave neither helps nor hurts, absent counts against; a school day is a day of the academic year that is not a Sunday and not a holiday on the school calendar. Two refinements taken while building it: a day after today (in the school's timezone) is not counted yet, and a day on which the pupil was not enrolled is not theirs to be counted for; an unmarked past school day counts against and the answer carries the unmarked count so a screen can say why. **Marking is per section per day** by whoever holds `attendance.record` on the section (the class-teacher post and a live teaching assignment both count for `assigned_sections`, exactly as `packages/authz` decides everything else); the lock is the section and the date; a save is the whole roster, derived by the server from the enrolments, and a body naming anybody else is refused with nothing written. **Corrections**: the class teacher may re-save the day's marks until the end of that day in the school's timezone; after that only the office corrects, with a reason, under `attendance.manage`. A correction never edits a row: it is a new row that supersedes the old one (`attendance_entries.revision`, `supersedes_entry_id`), the database refuses every UPDATE and DELETE, and the reason is the audit note, never in `safe_changes`. **The staff register** is marked daily by the office (owner, principal, admin); every staff member reads their own month; the accountant reads the register as payroll input and holds nothing about pupils; nobody marks their own row. **Files**: a section's monthly register as Excel or PDF and the staff register the same way under the export keys; one pupil's month as a PDF under `attendance.read`, so a parent can print their child's month, as a parent prints a receipt. **Dashboard**: the teacher's "My class" says whether today is marked and links to the register; the office sees registers marked of total and today's absentees, and pupils absent on the last three school days as an attention item; the parent child card shows this month's percentage. **Subject access** gains an `attendance` block. **Anonymising** a pupil clears nothing here: a mark is not identifying; the marks keep the pupil's sensitive period and the staff marks keep with staff records (eight years). The release changes the role templates (eight keys become active, 29 grants per school), so every existing school needs `pnpm db:sync-roles` after migration `0016`. A parent reads every year of their own child's attendance through the pupil, never through the current enrolment (the rule in section 2). The module is described in [PROTECTED_APIS.md](auth/PROTECTED_APIS.md#attendance) and [DATA_PROTECTION.md](compliance/DATA_PROTECTION.md) section 12.

### Task 21: Exams and report cards — built, 23 September 2026

Exam definitions per academic year (terms, subjects, maximum marks, grading scheme); marks entry by the subject teacher for their assigned section and subject; moderation and publishing by the office; report cards generated from published marks and attendance, readable by parents once published, exportable as a file through Task 15. Permissions: `exams.read`, `exams.record_marks` (assigned_sections, assigned_subjects), `exams.manage`, `exams.publish`, `exams.export`, `report_cards.*`. Unpublished marks are never visible to a parent or a student, by scope not by a flag on the screen. Exit check: a teacher enters marks only for their subject in their section; a parent sees nothing until publish and everything permitted after; the report card export is audited and goes through the download route.

Built as specified, with these decisions taken by the product owner before the build. **One fixed pattern** for every class, the CBSE two-term scheme, as a constant in `@erp/contracts` that no school edits: term 1 is periodic test 1 (10), notebook (5), subject enrichment (5) and the half-yearly exam (80); term 2 the same with periodic test 2 and the annual exam. The office sets each exam's dates and re-check deadline per academic year; the subjects of each class come from `grade_subjects`. **Grade bands** start as the CBSE 8-point scale (A1 91-100 down to E 32 and below) and each school edits its own, contiguous, without overlaps, covering 0 to 100, checked by the server. A school-wide setting chooses whether report cards and parent screens show marks (with the grade beside each subject total) or grades alone; teachers and the office always see marks, and teachers always enter marks. **Co-scholastic areas** (work education, art education, health and physical education, discipline) are graded A, B or C per term by the class teacher, with the class teacher's remarks per term. **Re-checks** happen in class before results go out: until the end of the exam's re-check deadline in the school's timezone the subject teacher can change their marks; after it the marks lock and only the office (owner, principal, admin) changes them. Every change after the first save needs a written reason, whoever makes it, and marks are published only after the deadline. **The report card layout** is each school's own, starting from a default, and the logo uploaded on the school profile prints on it. Student login, real SMS (Task 16) and operations readiness (Task 17) are out of scope; no result notice goes to a parent before Task 22.

Decisions taken while building it, on 23 September 2026. **Marks** are entered against the component's maximum with no raw paper maximum and no scaling: a number with at most one decimal place, stored as whole tenths, or a status. Absent counts as zero; medical leave and exempt leave the component out of that subject's total and the rest is scaled to 100; a component with nothing entered (a pupil not on that exam's roster) is left out the same way. A term is its two exams together, a subject's final figure the mean of its two terms, the overall result the mean of the subjects and a pass when every subject reached 33; a grade is the band holding the figure rounded half up. **Mark entries are never edited or deleted**, as for attendance: a change is a new row that supersedes the old one, the current mark is the newest, the database refuses UPDATE and DELETE, and a change carries a reason kind (re-check, entry error, other) on the row and in `safe_changes` while the words are the audit note. **The lifecycle** is per exam (each periodic test, the half-yearly, the annual) and per section: open for entry, locked after the deadline (worked out from the date, not by a job), then published by the office, only when every pupil on the roster has a mark or a status for every subject and component. A correction after publishing (office only, with a reason) leaves the section published; the family sees each mark as it stood at the newest publication, so the office publishes the section again and then the pupil's report card. **Report cards**: a term 1 card after the half-yearly results and a final card after the annual results, each refused while any of its exams is unpublished or changed since its publication. Attendance for a term comes from the Task 20 figures over the term's window. Publishing freezes a snapshot of the figures, the grade bands, the marks-or-grades choice and the layout; a later change never alters a published card until the office republishes it, and republishing keeps the earlier version. **The layout** is structured settings, never HTML: logo or not, the header lines, which blocks in which order, up to three signature labels and a footer note, with a preview on the settings page. **The logo** is an upload to the private document store like a student photograph, PNG or JPEG up to 512 KB, served to every member through `GET /school/logo`; `schools.logo_url` stays unused. **Scope**: for exams and report cards `assigned_sections` is the class-teacher post alone, because the audit found it also matches a plain subject teacher through their teaching assignment; a subject teacher is reached through `assigned_subjects` only, and a family scope matches published rows only, in `@erp/authz`, never by a flag on a screen. **The parent's own copy** of a card is printed under `report_cards.export`, which the parent holds for their own children. **No class average** is shown anywhere a parent looks. **Co-scholastic subjects** (a subject whose type is `co_scholastic`, such as physical education or art) get no marks sheet: they are graded through the four fixed co-scholastic areas. **Optional subjects** have no record of who takes them, so every pupil of the class is on the paper and one who does not take it is marked exempt. **Retention**: marks, publications, co-scholastic grades and published cards are kept permanently as the academic record; the class teacher's remarks follow the pupil's three-year period and anonymising the pupil clears them, in the working record and on every published version. The release changes the role templates (nine keys become active, 38 grants per school), so every existing school needs `pnpm db:sync-roles` after migration `0017`. A parent reads every year of their own child's published results and cards through the pupil (the rule in section 2). The module is described in [PROTECTED_APIS.md](auth/PROTECTED_APIS.md#exams-and-report-cards) and [DATA_PROTECTION.md](compliance/DATA_PROTECTION.md) section 13.

### Task 22: Communication — built, 23 September 2026

Notices from the school to a class, a grade or the whole school; messages to a parent about their child; delivery by email and text through Task 16; a record of what was sent, to whom and when; templates for the recurring notices. Permissions: `communication.read`, `communication.send` (school, assigned_sections), `communication.manage`, `communication.export`. The `communication` consent purpose gates every message to a parent: no consent, no message, and the record says so. Exit check: a teacher sends only to their sections; a parent who withdrew consent receives nothing and the attempt is recorded; message bodies are never in a log or in `safe_changes`.

Built as specified, with these decisions taken by the product owner before the build. **Delivery** is in the app and by email; text messages wait for Task 16. **Announcements only**: families cannot reply. **Class teachers and subject teachers** both write to the families of their own sections, with no approval step by the office (the office can withdraw any message). **Every automatic message is in**: an absence on the day, results published, a report card published, fees falling due and fees overdue, and birthday wishes to pupils and to staff. **Attachments, scheduled sends and read receipts** are in; messages in Hindi or a regional language are not.

Decisions taken while building it, on 23 September 2026. **A message's words live once**, rendered from placeholders when it is written, on the message row, and nowhere else; once it has gone out the database refuses any change to its words or audience, and the only moves left are withdrawing it and anonymisation blanking the words. **Recipients are worked out when it goes out** and recorded one row per guardian or staff member: families of the pupils enrolled this year in the audience; a guardian receives it only when the newest `communication` consent for at least one of those pupils is `given` and the office has not switched their notifications off, otherwise the row says `no_consent` or `not_receiving` and nothing goes; in the app through an active portal account whose access covers such a pupil, by email to the guardian's or staff member's address or else their sign-in address, never to a reserved test address. **Reading is by membership**: `communication.read` gained the `self` scope, meaning the messages addressed to the caller and the ones they wrote, for every kind of member; parents and the accountant hold only that, teachers hold it with `assigned_sections`, the office holds the school. No family scope reaches a message through the child it is about, so one guardian's consent never opens a message to the other; `own_children` and `own_record` are granted to nobody. **Automatic messages** are one per pupil or staff member, written by the school itself with a dedupe key so each happens once, in the school's own words or the built-in ones, each kind switchable, and never about anything before the school's automatic messages started (`automatic_since`). An absence notice waits 30 minutes (the school's setting) after the register is saved so a correction stops it, and only for today. Fee reminders go 3 days before an instalment falls due and every 7 days while anything is overdue, from 08:00 in the school's timezone, with the amounts from the fee figures every fee screen uses. **The pump** is the one place automatic messages are made, scheduled messages are sent (decided again for their author) and emails go (claimed with a lease, retried four times, recorded as failed after the fifth, never "sent" on a failure). It runs when somebody in the school has the app open (the unread count asks every minute), after a send, and from a daily Vercel cron at 08:00 India time; on the Hobby plan a cron runs once a day, so a paying school needs Pro with a five-minute cron. **Read receipts** are opens in the app, never a tracking pixel. **Retention**: two years after sending, then the nightly sweep removes files and rows; anonymising a pupil or a staff member blanks the words of the messages about them. The release changes the role templates (four keys active, 17 grants per school), so every existing school needs `pnpm db:sync-roles` after migration `0018`. The module is described in [PROTECTED_APIS.md](auth/PROTECTED_APIS.md#communication) and [DATA_PROTECTION.md](compliance/DATA_PROTECTION.md) section 14.

### Task 23: Student login — built, 24 September 2026

Identity and permissions were designed in the auth plan and every activation path is disabled. Activate for secondary students only, by invitation from a guardian who holds the child's portal access, with the student's own published information (timetable, attendance, published marks, notices) and nothing financial or administrative. Depends on Tasks 20 to 22 having something to show. Exit check: the acceptance matrix rows for student identity flip from "rejected" to "permitted for own record only" and the security suite proves both.

Built with these decisions taken by the product owner on 24 September 2026, which replace the invitation described above. **Class 9 to 12** count as secondary, by a class number set in setup (`grades.level`, filled in from class names). **Username and password**: the school's login code, the admission number and a password. **Automatic**: the login is made when a pupil is admitted or promoted into Class 9 to 12, with no invitation step; the office gives the pupils already there theirs in one action. **The password** is generated and texted to the primary guardian's phone; the pupil chooses their own at first sign-in and can change it again in account security; a forgotten password is reset by the office and texted to the same phone. **Only the office** switches a login off and on; a guardian cannot. The login **ends** when the pupil leaves. **No second factor.** **Notices**: the sender chooses families, pupils or both for any audience made of pupils, and a new audience "Class X to Y" covers a range of classes; a pupil sees what was addressed to them, their section, their class, a range containing it, or the school. Automatic messages about absence, results, report cards and fees stay with families; a birthday wish goes to the pupil too.

Decisions taken while building it. A notice in the pupil's own app needs no consent row (it is the school talking to the pupil inside the school's app; nothing leaves it). `own_record` is written exactly like `own_children` with the pupil themself as the only child. The pupil's identity has a generated `@student.invalid` address and signs in through the provider's own email door, called only from `POST /api/student-sign-in`. A pupil holds `students.read_basic`, `students.read_enrollments`, class, section, subject, timetable, dashboard, attendance, exams and report card reads at `own_record`, the calendar, and `communication.read` at `self`; no fee, guardian, consent, document, export or write key. One new office key, `students.manage_login`. The release changes the role templates (15 grants per school), so every existing school needs `pnpm db:sync-roles` after migration `0019`. Described in [PROTECTED_APIS.md](auth/PROTECTED_APIS.md#student-login) and [DATA_PROTECTION.md](compliance/DATA_PROTECTION.md) section 15.

### Out of scope for this plan

The AI assistant, custom role building, a policy editor, native apps, offline data and online payment collection. The permission names for the assistant stay reserved.

## 5. Order

| Wave | Work |
|---|---|
| 1 | Task 17 items that need only an operator: key escrow, Sentry alert, restore rehearsal, `xlsx` pin. Task 15 and Task 18 in parallel. |
| 2 | Task 16 (provider registration has lead time; start it first). Task 19 fees. |
| 3 | Task 17 region move, before any real school. Task 20 attendance (built). |
| 4 | Task 21 exams and report cards, then Task 22 communication. |
| 5 | Task 23 student login. |

The readiness tasks are the release gate for the first paying school; the module tasks decide what that school gets. Fees can be built while the region move is pending, but must not hold real money before it.

## 6. Decisions to take before starting

| Decision | Owner | Needed by |
|---|---|---|
| SMS provider and DLT registration entity | Product owner | Task 16 |
| Database provider and region for the move | Product owner | Task 17 |
| GitHub paid plan and repository visibility | Product owner | Task 17 |
| Online payment gateway. Decided for Task 19: none, payments are recorded by hand. Which gateway, if any, is still to decide | Product owner | Before any online payment work |
| Which school is first, and its fee structure and grading scheme, to shape the fixtures | Product owner | Tasks 19 and 21 |
| Named holders for the backup key and the security contact address | Product owner | Task 17 |

## 7. Office feedback, September 2026

Six small items the school office asked for, built on `feat/office-feedback` on top of the export
files work. None of them is a new module; each one is a change to a screen and, where it needed one,
to the API behind it.

1. **Plain English validation.** Every form names the field and says what to do: "Enter the first
   name", "Choose a class", "Enter a 10 digit phone number". One layer, `apps/web/src/lib/validation.ts`,
   turns a schema's issue into that sentence, and no screen shows a raw message any more.
2. **Aadhaar, PAN and an office address.** A pupil may have an Aadhaar number, and each guardian an
   office address, a PAN and an Aadhaar number. All optional and marked so.
3. **How those numbers are held.** The whole number is encrypted with the application key exactly as
   the APAAR identifier already was, with the last four digits beside it. Screens, lists, export
   files and PDFs show "ending 1234" and nothing more, and each number has one audited reveal route,
   the pupil's behind `students.read_sensitive` and the guardian's behind `students.read_guardians`.
4. **Photographs.** Pupils and staff have a picture in the private document store, served only by a
   permission-checked route, at most 1 MB, type decided by the first bytes, with the camera's own
   metadata stripped before it is stored. A pupil's picture needs the `photographs` consent;
   withdrawing it removes the picture, and anonymising a record removes it too.
5. **Promotion.** A third choice, "Leave out", with "all promote / all detain / all leave out" bulk
   controls and a count summary. A student left out is in neither list and is not touched.
6. **Free teachers today.** The substitutions screen shows, period by period, which teachers are
   free on the chosen day and what their load is, reusing the free-teacher read that already existed.

Automatic birthday greetings were asked for in the same round and are **deferred to Task 22
(communication)**: a greeting is a message, and messages, their templates, their delivery and their
consent belong to that task rather than to a one-off job here. Built with Task 22 on 23 September 2026, for pupils and staff.

## 8. Dashboard redesign, September 2026

Built on `feat/dashboard-redesign` on top of the office feedback branch. The old dashboard showed two
counts, twenty bars and three plain lists. This replaces the dashboard API and the four screens with
one meaningful, calm view per audience, built only from data the school already keeps (students,
guardians, consents, documents, staff, sections, timetable, bell schedules, substitutions, holidays,
invitations, memberships, audit events). Fees, attendance and exams do not exist yet; the layouts
leave room for their cards.

### 8.1 Rules for this task

- One route, `GET /api/schools/:schoolId/dashboard`, permission `dashboard.read`, audience fixed from
  the caller's roles by `audienceFor` (office = owner, principal, admin; then teacher, parent,
  accountant). Optional query `?date=YYYY-MM-DD`; otherwise the date is today in the school's
  timezone (`schools.timezone`, default `Asia/Kolkata`). The date only moves the calendar; it never
  widens what is read.
- Every block of the response is read inside one `withTenantTransaction`, through
  `readPlan(conn, context, <permission>, <resourceType>)` and `planPredicate(plan, scopedTableFor(...))`
  ANDed into the WHERE clause, exactly as `apps/api/src/modules/dashboard/queries.ts` does today. No
  school-wide fetch filtered in JavaScript. Aggregating rows that are already predicate-scoped
  (summing counts by class, grouping by month) is fine.
- A block whose permission the caller does not hold is **omitted** from the response (the field is
  optional in the contract), never sent as zero. `readPlan` throws `AuthorizationError` with code
  `ACCESS_DENIED` when the caller may not read that resource at all: catch exactly that, omit the
  block, rethrow anything else (a mis-wired permission must fail loudly).
- Tables without a scoped table in `@erp/authz` (`school_invitations`, `membership_staff_links`,
  `school_memberships`) are read only after `decideSchoolAction(conn, context, 'members.read')` (or
  `members.invite` for invitations) allowed, and only for `context.schoolId`.
- Birthdays carry name and class only, for people the caller's plan already lets them read.
- No new permission, no migration, no new dependency. No personal data in logs; the route writes no
  audit row (it is a read).
- Teacher: `loadRelationshipFactsFor(...).selfStaffId`; a teacher with no staff record gets an
  empty, honest response (`staffLinked: false`). Parent: `ownChildStudentIds`, then the student plan.
- Gender, admission date, leaving date and date of birth belong to the sensitive block of a
  record, so the figures built from them (gender mix, admissions and leavers, birthdays) are gated
  on `students.read_sensitive` and `staff.read_private`, not on the basic read. A plain teacher
  therefore gets no birthday list for their class.
- `dashboard.read` is decided against the whole school before the handler runs, so a teacher with
  no staff link and a parent with no approved child are refused (403) rather than answered empty.
- Cover duty for a teacher is a substitution whose `substitute_staff_id` is their own staff id
  **and** which their `timetable.read` substitution plan allows (the absent teacher owns the row, so
  a cover in a section they do not teach is not shown; that limit is written in the docs).

### 8.2 Contract, `packages/contracts/src/module-dashboard.ts`

Replaces the `DashboardResponse` union in `responses.ts` (keep the export name `DashboardResponse`
and `DashboardByAudience` pointing at the new union so nothing else breaks). All objects are
`z.strictObject`. Shared pieces:

```
DashboardDay = { date: CalendarDate, dayOfWeek: 0..6 (0 = Sunday), kind: 'school_day' | 'holiday' | 'sunday',
                 holidayName?: Name, nextSchoolDay?: { date: CalendarDate, dayOfWeek: 1..6 } }
HolidayAhead = { id, name, startDate, endDate, type }                      // next 30 days from date
Birthday = { kind: 'student' | 'staff', id, name: DisplayName, className?: string, date: CalendarDate }
AttentionItem = { key: 'periods_without_cover' | 'invitations_expiring' | 'students_without_guardian_phone'
                       | 'students_without_consent' | 'sections_without_class_teacher'
                       | 'empty_timetable_slots' | 'staff_without_login', count: int >= 0 }
ClassStrength = { grade: NamedReference, sections: [{ id, name, count }] }   // grade sort order
Lesson = { section: NamedReference, subject: NamedReference, roomNumber?: string,
           cover: boolean,                    // true when this is a cover duty given to the caller
           coveredBy?: NamedReference }       // set when the caller is away and someone else covers
TimelineSlot = { periodIndex, name, startTime 'HH:MM', endTime 'HH:MM', type: 'period'|'break'|'lunch'|'assembly',
                 lesson?: Lesson }            // no lesson on a 'period' = free
```

Audiences:

```
office: { audience: 'office', day, academicYear: NamedReference | null,
  today?: { teachersAway: int, periodsWithoutCover: int },          // timetable.read (substitution plan)
  attention: AttentionItem[],                                        // only the keys the caller may read
  glance?: { students: { total }, mix?: { boys, girls, other }, admittedThisMonth?, leftThisMonth? },   // total: students.read_basic; mix and movement: students.read_sensitive
  studentsPerTeacher?: number (one decimal, null-free; omit when no teachers),               // + staff.read_directory
  classStrength?: ClassStrength[],                                   // sections.read_strengths (enrollment plan)
  admissionsByMonth?: [{ month: 'YYYY-MM', count }] (12, April..March of the current year),   // students.read_sensitive (admission_date is a sensitive field)
  holidays: HolidayAhead[],                                          // holidays.read; [] when not allowed
  birthdays?: { today: Birthday[], thisWeek: Birthday[] },           // students.read_sensitive / staff.read_private (date of birth is a sensitive field)
  recentActivity?: AuditEventSummary[] (8),                          // audit.read
  securityEvents?: AuditEventSummary[] (8, result = 'denied' or action starting 'roles.' / 'members.' / 'ownership.'),  // audit.read AND role owner
  setup?: { steps: [{ key: 'school'|'years'|'grades'|'sections'|'subjects', done: boolean }] } }   // per setup read permission
teacher: { audience: 'teacher', day, staffLinked: boolean, academicYearId: Id | null,
  timeline: TimelineSlot[],          // for `day` when it is a school day, else for day.nextSchoolDay; [] otherwise
  timelineDate: CalendarDate | null, // which date the timeline is for
  week: [{ dayOfWeek: 1..6, periodIndex, section, subject, roomNumber? }],  // own periods, whole week
  periods: [{ index, name, startTime, endTime, type }],                     // bell periods for the grid columns
  myClass?: { section: NamedReference, strength: int, birthdaysThisWeek?: Birthday[] },   // class teacher only; birthdays need students.read_sensitive
  holidays: HolidayAhead[] }
parent: { audience: 'parent', day, children: [{ student: StudentBasic, enrollment?: EnrollmentSummary,
  classTeacher?: NamedReference, todayLessons?: TimelineSlot[], nextHoliday?: HolidayAhead,
  waitingOn: [{ kind: 'consent', purpose: ConsentPurpose }] }] }              // consents: students.read_consents
accountant: { audience: 'accountant', day, glance?: { students: { total }, mix?, admittedThisMonth?, leftThisMonth? },
  classStrength?: ClassStrength[], feesNote: 'Fee cards arrive with the fees module' }
```

Definitions the API must follow:

- `today.teachersAway` = distinct `absent_staff_id` in substitutions dated `date`;
  `periodsWithoutCover` = those rows with `substitute_staff_id IS NULL`. Both through the
  substitution plan.
- `invitations_expiring` = pending invitations expiring within 24 hours of `context.now`.
- `students_without_guardian_phone` = active students with no linked guardian whose `phone` is set
  (student plan for `students.read_guardian_contact`).
- `students_without_consent` = active students with no `guardian_consents` row at all
  (`students.read_consents`).
- `sections_without_class_teacher` = current-year sections with `class_teacher_staff_id IS NULL`
  (`sections.read`).
- `empty_timetable_slots` = over current-year sections the caller may read: for each section, the
  number of `period`-type periods in its grade's bell schedule × working days (Saturday uses
  `saturday_period_count` when set) minus its timetable entries, floored at 0, summed.
- `staff_without_login` = active staff with no `membership_staff_links` row and no pending invitation
  with their `staff_id` (staff plan + `members.read`).
- Bell times for a section come from the bell schedule whose `grade_ids` (or `bell_schedule_grades`)
  contains the section's grade in the current year; with none, the slot list is the section's period
  indexes with no times and the screen says "Period 3". The teacher `periods` list is the schedule of
  the grade they teach most; if it has none, indexes only.
- Birthdays: month and day of `date_of_birth` equal to `date` (today) or within the seven days from
  `date` (this week, excluding today). Students: active, with their current section as `className`.
  Staff: active or on leave, no class.
- `admissionsByMonth` counts `students.admission_date` per month of the current academic year.
  `admittedThisMonth` and `leftThisMonth` use `admission_date` and `left_on` in the calendar month of
  `date`.
- `securityEvents` is only built when `context.roleKeys` includes `owner`.

### 8.3 Screens

`apps/web/src/routes/_app/dashboard.tsx` keeps its route id and picks the screen by
`data.audience`. Building blocks live in `apps/web/src/components/dashboard/blocks/`; each audience
has one file (`office-dashboard.tsx`, `teacher-dashboard.tsx`, `parent-dashboard.tsx`,
`accountant-dashboard.tsx`). Every card has a skeleton, an empty state and an error state; the
layout holds together at 1024px wide. Semantic tokens only, lucide icons only, `Panel`, `Facts`,
`Tag`, `EmptyState`, `UserAvatar` from the shared components. The one chart (admissions by month) is
a hand-made SVG bar chart; no chart library. Copy is plain English with Indian date formats.

### 8.4 Tests and docs

API tests in `apps/api/tests/modules-dashboard.test.ts`: the day wording for a school day, a holiday
and a Sunday (using `?date=`); the teacher response holds only their own sections and cover duty
they were given; the parent response holds only their children; a member without a permission gets
the block omitted rather than zero; every attention key. Security tests in
`tests/security/dashboard.test.ts`: cross-school date probe, a teacher of school A asking with a
school B date, a parent with no children, a suspended member. Web tests per screen. Docs:
`docs/auth/PROTECTED_APIS.md` (dashboard section and route table), `docs/auth/OPERATION_COVERAGE.md`
(dashboard rows), `docs/auth/WEB_SCREENS.md` (dashboard row and role table).

### 8.5 View switcher for people with more than one role (22 September 2026)

Decided: the default audience order is office, accountant, teacher, parent, so an accountant who is
also a parent lands on the money cards. The tab a person signs in from seeds their view (parent tab:
parent home; a staff tab: their highest staff view) and "Viewing as" in the account menu lets them
change it without signing out; both are a browser preference per user id, not a session or database
field, because the session belongs to the identity and a person can hold different roles in
different schools. `GET /dashboard` takes `?audience=` and accepts only one of the caller's own
homes, else `INVALID_REQUEST`; it never widens a read. Lists stay the union of the roles.

## 9. Rough edges after Task 23, September 2026

Taken on 25 September 2026, before the AI assistant work, on `feat/rough-edges`. No new module; each item closes something a release left open.

1. **A class signs in together.** The provider allows three sign-ins and three password changes every ten seconds from one address, and a school lab shares one address, so a class could not sign in at once. The pupil route now skips the provider's limit and applies its own: five attempts a minute per pupil account and 150 a minute per address, both durable and keyed on hashes; a password change is limited per person instead of per address. Staff sign-in is unchanged. See [PROTECTED_APIS.md](auth/PROTECTED_APIS.md#student-login).
2. **Families allow messages themselves.** Most families had no `communication` consent, so Task 22 reached nobody. Decided by the product owner: the parent home asks, in a card at the top, "Get messages from the school", and one button records the consent for each child who is waiting, by the guardian through the portal. The office does not record consent in bulk, and the hosted test families are not filled in: they allow it themselves.
3. **Restricting one person.** Decided by the product owner: an owner or principal can take sensitive details, full guardian records or medical information away from one member (the guardian contact card stays, because full records carry the phone too and staff who call families need it), with a reason and an optional end date. It is a school-wide deny rule under the newly active `access.manage`. See [ACCESS_MANAGEMENT.md](auth/ACCESS_MANAGEMENT.md#member-restrictions).
4. **Photograph in the admission form.** Chosen with the pupil's details, uploaded after the admission is saved and only when a guardian gave consent for photographs at the consent step.
5. **Identity numbers in bulk import.** Pupil Aadhaar, guardian Aadhaar, guardian PAN and office address are optional columns, sealed the moment the server reads them, in the stored preview as well as the record.

Release: migration `0020_member_restrictions.sql`, `pnpm db:sync-roles` (2 grants per school), then merge.
