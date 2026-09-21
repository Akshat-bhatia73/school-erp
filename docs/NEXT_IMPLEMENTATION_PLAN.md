# Next implementation plan: readiness and the first school modules

Date: 19 September 2026. Status: proposed, for review. Follows [AUTH_RBAC_IMPLEMENTATION_PLAN.md](AUTH_RBAC_IMPLEMENTATION_PLAN.md), whose fourteen tasks are delivered and live at erp.akshat-bhatia.com with test data. Tasks 15 and 18 are built; nothing else in this document is started.

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
- Move the database to an Indian region as `docs/compliance/HOSTING_REGION.md` recommends, and set the function region to `bom1`, before the first real school, so the CERT-In log requirement is met.
- Done, 21 September 2026: `xlsx` is pinned to the registry as `npm:@e965/xlsx@0.20.3`, a mirror of the official SheetJS 0.20.3 tarball. The npm package named `xlsx` stopped at 0.18.5 and carries two high advisories, so it was never an option. Before accepting a version bump, unpack the mirror and the tarball from `cdn.sheetjs.com` and compare them: for 0.20.3 only `README.md` and the name and repository in `package.json` differ, and there are no install scripts.
- Move the repository to a paid GitHub plan and make it private without losing branch protection.

Exit check: every release checklist line is signed; the restore log has one passed production entry; the sub-processor list names an Indian database region.

### Task 18: Screen and contract gaps — built, 21 September 2026

The gaps listed under "Known gaps" in `docs/auth/WEB_SCREENS.md` and `docs/auth/PROTECTED_APIS.md`, grouped into one task so they stop being carried forward. Built with no new route, no new permission and no role template change: `GET /members` filters on `search`, `role`, `status` and `staffId` in the query rather than in the browser; `GuardianPrivate` carries a version so a guardian already on file can be corrected; `StaffEmployment` returns the leaving date, so the sheet can clear one; a section names its class teacher through the staff directory plan; every setup record carries `allowedActions`; a refused delete carries a `reason` from a closed list and the sentence that goes with it; `GET /audit-events` takes an `outcome`; the promotion preview pages with a total, so a class of any size is promoted in runs of a hundred; and migration `0014_setup_versions.sql` gives `schools`, `holidays` and `bell_schedules` real version columns.

One decision taken while building it, on 21 September 2026. The school context does not name the current academic year and is not going to. Every member asks `GET /academic-years/current` instead, which is gated on `holidays.read` and so open to every role, and `useAcademicYear` reads it rather than guessing from the sections a teacher can see. One small read every role may make is simpler than widening the session context for a teacher or a parent. Recorded as a deliberate decision alongside the second one: a section shows "Assigned" when its class teacher is somebody the viewer may not read.

Exit check met: both known-gap sections now name only gaps this task did not take on and two deliberate decisions. Twenty new API tests cover the filters, the versions, the reasons, the class teacher and the paging, and `tests/security/screen-contract-gaps.test.ts` asks the wrong-person half of each widened read.

## 4. Module tasks

Each module follows the same shape: contracts and permissions first, then migration, then API, then screens, then documents, then the security and browser tests, then release. The reserved permissions already fix the scopes; the descriptions below say what the scopes mean in practice.

### Task 19: Fees

The module schools ask for first and the one with the most sensitive data. Fee heads and structures per academic year and grade, with optional concessions per student; a statement per student showing dues, payments and balance; collection by the office with a receipt number assigned by the server (a counter per school and year, as admission numbers are); refunds and adjustments with a reason as a note; a dues list per class; a parent view of their own children's statements and receipts. Permissions: `fees.read` (school, own_children, finance), `fees.collect`, `fees.manage`, `fees.export` (school, finance). Owner, principal and accountant hold manage, collect and export; the office clerk role does not exist, so admin holds collect; parent holds read at own_children; teacher holds nothing. The accountant dashboard shows today's collection and outstanding dues. Money in paise; receipts are immutable rows, corrections are new rows. Retention: eight years after the last transaction, as for staff pay. Online payment is out of scope until a gateway is chosen; record it as a decision to take. A parent reads statements and receipts for every year their child was enrolled, with a year chip built from the child's own enrolments (the rule is in section 2). Exit check: a parent sees only their children's statements, including last year's after a promotion; an accountant collects and the receipt appears in the audit trail without the amount in `safe_changes`; a teacher gets 403 on every fee route; two collections committed at once get consecutive receipt numbers.

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
consent belong to that task rather than to a one-off job here.

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
