# Feature screens on the real API

Task 7 moved every feature screen off the in-memory mock and onto the protected school APIs, and
made the UI permission driven. The mock (`apps/web/src/api/client.ts`, `seed.ts`, `store.ts`) is
deleted; nothing in the browser holds school data or decides access any more. This document is the
record of what each screen calls, what each role sees, and what is still missing.

Source files: [src/lib/api](../../apps/web/src/lib/api) (one file per backend module, plus the
single `api` object), [src/lib/query.ts](../../apps/web/src/lib/query.ts) (`qk`),
[src/lib/permissions.ts](../../apps/web/src/lib/permissions.ts),
[src/lib/session.tsx](../../apps/web/src/lib/session.tsx) (`useSchoolContext`), and
[src/test/session.tsx](../../apps/web/src/test/session.tsx) (`renderWithSession`).

Read [the protected APIs](./PROTECTED_APIS.md) for what each endpoint does and
[the web session](./WEB_SESSION.md) for how the session is derived.

## Using the API layer

Every call names the school first, because the server reads the school from the URL and decides
access against it. `useSchoolContext()` gives you that school id, and it is only ever called under
`AppGate`, so nothing there is null.

### A list query

```tsx
const { schoolId } = useSchoolContext()
const params = { page, sectionId, status: 'active' as const }

const { data, isLoading } = useQuery({
  queryKey: qk.students(schoolId, params),
  queryFn: () => api.students.list(schoolId, params),
})
```

The server already bounded the list: a row is in it only because this person could open its detail
page. Never fetch a wider list and filter it in the browser.

### A mutation

```tsx
const queryClient = useQueryClient()

const save = useMutation({
  mutationFn: (input: UpdateStudentBasicInput) => api.students.updateBasic(schoolId, studentId, input),
  onSuccess: () => {
    // One prefix clears the roster, the count, the search and this student's detail.
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'students'] })
    toast.success('Saved changes')
  },
  onError: (error) => toast.error(describeError(error)),
})

save.mutate({ expectedVersion: student.version, firstName })
```

`expectedVersion` is the version the person was looking at. If somebody else saved first the server
answers VERSION_CONFLICT, and `describeError` already says "Someone else changed this while you
were working."

### Gating a control

```tsx
const { hasPermission } = useSchoolContext()

// Can this person admit anybody at all? Session capabilities answer for the school as a whole.
{hasPermission('students.create') && <Button onClick={admit}>Admit student</Button>}

// Can this person edit THIS student? Only the record's own allowedActions answer that.
{allows(detail.allowedActions, 'students.update_basic') && <Button onClick={edit}>Edit</Button>}
```

`capabilities` is the floor: it says the permission exists somewhere in the school for this person.
`allowedActions` on the record is the answer for that record. When both exist, use the record.

One catch: the server only lists keys whose catalogue `resourceType` matches the record. A student
record therefore never carries `students.read_guardians`, `students.read_documents`,
`students.read_enrollments`, `students.manage_enrollment` or `students.manage_guardians` (they belong
to the guardian, document and enrollment types), and a staff record never carries
`staff.manage_assignments`. Those blocks are gated on `hasPermission` from the session, and the
child rows (a document, say) carry their own `allowedActions` for their own controls.

## The rules

- **School id first.** Every function in `api.*` takes `schoolId` as its first argument, and every
  key in `qk` starts with it. There is no ambient school.
- **Never fetch the whole school and filter in JavaScript.** If a screen needs a filter the server
  does not offer, say so in your handover notes rather than paging through everything.
- **Hide what the server did not allow.** A control the person cannot use is not rendered at all.
- **Disabled with a reason, only for somebody already authorized.** "Save" may be disabled while a
  form is invalid or a save is in flight, with the reason next to it. Permission is never a reason
  to disable — it is a reason to not render.
- **Plain English for every rejected field.** A form never shows a schema's own words. `@/lib/validation`
  turns a Zod issue into a sentence that names the field — "Enter the first name", "Choose a class",
  "Enter a 10 digit phone number" — from a `FieldLabels` map keyed by dotted path, with a wildcard
  form (`guardians.*.phone`) for a list. A message a schema author wrote by hand wins. After a failed
  save, `focusFirstInvalid()` puts the cursor in the first box the form marked `aria-invalid`, and the
  toast says `CHECK_FIELDS` ("Check the highlighted fields").
- **Never show a raw error code.** `describeError(error)` from `@/lib/api-errors` for every failure,
  in a `toast.error` or inline. `VERSION_CONFLICT`, `ACCESS_DENIED` and the rest already have plain
  English sentences.
- **ISO dates in state.** Keep `2026-03-31` in state and format only for display, with `formatDate`
  from `lib/utils.ts`.
- **Invalidate by prefix.** After a write, invalidate the module prefix (`[schoolId, 'students']`),
  not each key by hand.
- **One call per screen concern.** Do not chain a list call into N detail calls; if you need a field
  the list does not carry, say so in your notes.

## Screen checklist

Every screen below was written and reviewed against this list; a new screen should meet it too.

- [ ] Every query uses a `qk.*` key and an `api.*` function; no bare `fetch`.
- [ ] Every mutation sends `expectedVersion` where the contract has one, invalidates the module
      prefix, and shows `toast.success` on save and `describeError` on failure.
- [ ] Every rejected field reads as plain English through `@/lib/validation`; no `issue.message`.
- [ ] Every action is gated: `hasPermission` for a screen-level control, `allows(allowedActions, …)`
      for a control on one record.
- [ ] The screen reads nothing local: no mock client, no `can`/`scope`/`roles`. They no longer exist.
- [ ] Loading, empty and refused states are all handled. A refusal is a sentence, not a blank page.
- [ ] Shared components only: `PageHeader`, `Toolbar`, `FilterChip`, `DataTable`, `Panel`, `Facts`,
      `EmptyState`, `Tag`. No new one-off table or header.
- [ ] Tests use `renderWithSession` from `@/test/session` with the exact capabilities under test,
      and mock `@/lib/api` (or `@/lib/http`) rather than the network.
- [ ] `pnpm --filter @erp/web typecheck`, `test -- --run` and `lint` are clean.


## Screen inventory

One row per screen: the endpoints it calls, what the roles who can open it see, and what it still
cannot do. Every list is bounded by the server; nothing here filters a school in the browser except
where the row says so.

### Shell and dashboard

| Screen | Endpoints | What each role sees | Not yet |
|---|---|---|---|
| Sidebar, mobile nav, command menu | `students/count`, `staff/count` (office only), `search`, academic years or sections through `useAcademicYear` | Office: every destination its permission allows, plus student and staff counts and the year name. Teacher: Dashboard, Students, Staff, Timetable, Attendance. Parent: "My children", Timetable, Fees and Attendance, no quick actions, no year tag. Accountant: Dashboard, Students, Staff, School setup reads, Audit log, Fees, and Attendance (the staff register). The shape follows the chosen view from `useSchoolDashboardView` (`lib/dashboard-view.ts`), not the highest role: a teacher who is also a parent and chose "Parent" gets the parent shape, while every destination their rights allow stays. The account menu carries a "Viewing as" group (Office, Accountant, Teacher, Parent, the current one ticked) only when the membership earns more than one home; choosing one is remembered per user in localStorage and invalidates `[schoolId, 'dashboard']`. The login tab seeds it: the parent tab lands on the parent home, a staff tab on the highest staff view | No count for a role without `students.read_basic` / `staff.read_directory`; no year name for a teacher or parent |
| `/dashboard` | `dashboard` only: one request, `api.dashboard.get(schoolId, { audience })`, with `audience` sent only when a view is stored for this user and their roles still earn it (the query key carries it). The server picks the first home the roles earn otherwise, in the order office, accountant, teacher, parent, and refuses a home the roles do not earn. The screen calls no other endpoint; the parent consent block asks for a child's consents when the parent opens it | Office: one sentence about today (school day, holiday or Sunday, teachers away and periods without cover), the things needing a person with a link to each, the student mix and students per teacher, class strength per section, admissions by month, holidays and birthdays ahead, recent activity with a security list for an owner, and a setup checklist that disappears once all five steps are done. Teacher: what they are teaching now and next from the browser clock, today's timeline with cover duty marked, the whole week, their own class and the holidays ahead; an honest empty state when the login is not linked to a staff record. Parent: one card per child with class, class teacher, today's lessons, the next holiday and what the school is waiting on, plus "Manage consent" (Give and Withdraw when the list allows `students.manage_consents`, recorded through the portal) and "Download my child's record" for `students.export_subject`, saved as `<admission number>-record.json`. Accountant: the day, the student tiles and the fee cards (the accountant role holds no `sections.read_strengths`, so no class strength card is drawn). Attendance since Task 20: the office sees "Registers marked X of Y" and "Absent today" tiles and a "pupils absent three school days running" attention row, each linking to the attendance screens; the teacher's "My class" card says whether today's register is marked and offers "Mark attendance" or "Open register"; the parent child card carries "Attendance" with this month's percentage so far, linking to the child's calendar | A block the caller may not read is absent from the answer, so the screen says nothing rather than showing a zero. A teacher's export of their own week is not offered: nothing on the web side knows their staff id. Attendance, exam and fee cards: no table carries them yet |

### Students

| Screen | Endpoints | What each role sees | Not yet |
|---|---|---|---|
| `/students` | `students` (page, search, sectionId, status, sort), `sections`, `grades`, `students/export` + `exports/:id` + `exports/:id/file` | Office: the roster, the class chip, search, and Admit / Import / Promote as their permissions allow. Picking rows shows a bulk bar whose "Export to Excel" saves the spreadsheet as soon as the server has it. Teacher: their own pupils, no write action. Parent: their own children | No gender or admission-type filter, no "N boys / N girls" footer, no bulk move or leave, and the roster deliberately sends no `academicYearId` (the server matches it against the current enrolment, which hid every past pupil) |
| `/students/:id` | `students/:id`, `/guardians`, `/siblings`, `/documents`, `/enrollments`, `/consents`, `files/student-document`, plus `updateBasic`, `updateSensitive`, `move`, `leave`, `addGuardian`, `updateGuardian`, `revealApaar`, `recordConsent`, `unlinkGuardian`, `anonymise`, `subjectAccess` | Each block and tab appears only because the server sent it and listed the action: edit name, edit details, move section, mark as left, guardians, siblings, documents, class history. The APAAR id reads as `XXXX-XXXX-1234` with a Reveal action for `students.read_sensitive` that fetches the full value on demand and never caches it. A Consent tab for `students.read_consents` shows the latest answer per guardian and purpose, with Give and Withdraw when the list allows `students.manage_consents`. Each guardian has an Unlink action for `students.manage_guardians`, behind a confirmation that takes a reason. An anonymised record shows an "Anonymised" tag and no empty blocks. The Student panel carries "Export this record" when the record allows `students.export_subject`: it fetches the subject-access export on click and saves it as `<admission number>-record.json`, and the response never enters the query cache. "Export PDF", for a record allowing `students.export`, saves the same record as a document. The Aadhaar number reads as "ending 1234" with the same Reveal control as the APAAR id. Each guardian card shows the office address and "PAN ending 123A" and "Aadhaar ending 0124", each with the same Reveal control when the record allows `students.read_guardians`, which calls `revealGuardianIdentity` for that one guardian. A revealed number is held in the component alone: it never enters the query cache, it goes when the tab or sheet unmounts, and it goes back to the last digits on its own after thirty seconds. A photo panel, for a record allowing `students.update_basic`, uploads, replaces or removes the picture; it shrinks the file to at most 600px and re-encodes it before it travels, and where the `photographs` consent is not granted the controls are replaced by "Photo upload needs the photographs consent from the parent." | House, transport, structured address, document upload; anonymisation cannot be undone and the screen only describes what it will clear |
| `/students/new` | `sections`, `grades`, `students` (create) | Needs `students.create`; attaching an existing guardian also needs `students.manage_guardians`; the admission number is never typed here, the server assigns it on save and the toast reads it back. A Consent step between Guardians and Class offers the five purposes per guardian with a method and an optional evidence reference, and the review step lists what was ticked; nothing is sent when nothing was ticked. The review step also names every new value before it is saved: "Aadhaar ending 1234" for the pupil, and the office address, "PAN ending 234F" and "Aadhaar ending 1234" for each guardian, never a whole number. The student step has an optional Aadhaar panel, and each guardian has an optional office address, PAN and Aadhaar number, all marked "Optional" | Medical fields, religion, mother tongue, nationality, APAAR, previous school, transport and the structured address; a photograph is added on the record after admission rather than in the form; attaching an existing guardian is an id field, not a picker |
| `/students/import` | `students/import/preview`, `students/import/commit`, `sections`, `grades` | Needs `students.import`; the counts, the row list and the row errors are the server's, never the browser's; the Admission Number column is optional and the review shows the kept number or "Will be assigned" per row | Editing a row in the browser: a wrong row is fixed in the file and uploaded again |
| `/students/promote` | `academic-years`, `sections`, `grades`, `students/promote/preview`, `students/promote` | Needs `students.promote`; a reason is required. Each student is Promote, Detain or **Leave out**, and the column header carries "All promote", "All detain" and "All leave out" for the whole list at once. A student left out is in neither list, so nothing about them is sent or changed. The footer and the side panel both read "N students in view · X to promote, Y to detain, Z left out", and the confirm button is dead while everybody is left out | No capacity warning and no attendance column; a class of any size is read a page at a time and promoted in runs of 100 behind the screen |

### Staff

| Screen | Endpoints | What each role sees | Not yet |
|---|---|---|---|
| `/staff` | `staff` (page, search, sort), `staff/departments`, `staff/export` + `exports/:id` + `exports/:id/file` | Office: the directory with Add staff, and an Export that saves the spreadsheet as soon as the server has it. Teacher: the staff they may see, no write action. Parent: refused, and the destination is not in the navigation | No staff-type, status or employment filter on the server. No photo, phone, employee code or subject count in the list |
| `/staff/:id` | `staff/:id`, `staff/:id/assignments`, `assign`, `unassign`, `updateEmployment`, `updatePrivate`, `updatePay`, plus `members` for the Login tab and `sections`/`grades`/`subjects` for the assignment pickers | Employment, Contact and Pay panels appear only when the server sent that block; each Edit only when the record allows it. The Login tab needs `members.read`; the Timetable tab needs `timetable.read`. "Export PDF", for a record allowing `staff.export`, saves the person's record as a document. A record allowing `staff.anonymise` gets an Anonymise panel, and an anonymised record shows an "Anonymised" tag with no Contact or Pay panel | No "class teacher of", no room number, no separate status actions |
| `/staff/new` | `staff/departments`, `staff` (create) | Needs `staff.create`; the employee code is never typed here, the server assigns it on save and the create response carries it for the toast | Pay, address, experience, blood group and the old "create a login" switch: creation never makes a login, an invitation does |

### School setup

| Screen | Endpoints | What each role sees | Not yet |
|---|---|---|---|
| `/setup/school` | `school`, `school` (update) | Office roles read it; only `school.update` sees the form, everybody else reads the same values as plain facts | Principal name, website, established year, logo, and the split city/district/state/PIN address: the contract has one free-text address |
| `/setup/academic-years` | `academic-years`, create, update (also "Make current") | `academic_years.manage` sees Add and the row menu | No delete |
| `/setup/classes` | `grades`, `sections`, `sections/strengths`, create/update/delete for both | `sections.read_strengths` sees the Students column; a section names its class teacher when the viewer may read that staff record and otherwise reads "Assigned"; every class and section control follows that record's own `allowedActions`, and a refused delete says what still refers to the record | Nothing outstanding |
| `/setup/subjects` | `subjects`, `grades`, `grade-subjects`, create/update/delete, `setGradeSubjects` | `subjects.manage` sees Add and the editable matrix; `grades.read` sees the "By class" tab | — |
| `/setup/holidays` | `holidays` (year optional), create, update, delete | Every role holding `holidays.read` sees the list, including a teacher or parent who cannot read years | The type chip filters the loaded year in the browser; the server takes only `academicYearId` |

### Timetable

| Screen | Endpoints | What each role sees | Not yet |
|---|---|---|---|
| `/timetable` | `grades`, `sections`, `timetable/bell-schedules/for-grade`, `timetable/sections/:id`, `timetable/conflicts`, `grade-subjects`, `generate`, `free-teachers`, `setEntry`, `clearEntry`, `timetable/export` + `exports/:id` + `exports/:id/file` | Anybody with `timetable.read` sees the grid for a class they may see, and an Export button that saves that week as Excel or PDF. Editing a cell needs the record's `timetable.manage_entries`; Generate needs `timetable.generate`; the conflicts panel needs `timetable.read_conflicts` | Setting one slot has no `expectedVersion` (last write wins); the conflicts endpoint has no section filter, so the list is narrowed in the browser and labelled as this class's |
| `/timetable/periods` | `timetable/bell-schedules`, create, update | `timetable.manage_periods` edits; everybody else reads the same schedule as text | Reordering or removing a period renumbers and can move existing entries; the screen warns about it |
| `/timetable/teachers` | `timetable/teacher-loads`, `timetable/bell-schedules`, `timetable/staff/:id`, `timetable/export` + `exports/:id` + `exports/:id/file` | Needs `timetable.read_teacher_loads`; the week of the person picked carries the same Export button; a teacher or parent gets one sentence and no request is made | No per-staff bell schedule, so the rows are every schedule of the year merged by period index. No max-periods limit, no per-day counts from the load row |
| `/timetable/substitutions` | `timetable/substitutions`, `bell-schedules`, `staff/search`, `absent-periods`, `free-teachers`, create, delete, `notify` | Arranging needs the day's `timetable.manage_substitutions`; notifying needs `timetable.notify_substitutions`. A "Free teachers today" panel, for `timetable.manage_entries`, lists the chosen day period by period with the teachers free in each one and their load for that day; it reuses the same free-teacher read the absent-teacher panel uses, so there is no new endpoint | No "who is away" list on the server: the away list is today's arrangements plus whoever was added in this browser session, and it resets when the date changes |

### Fees

| Screen | Endpoints | What each role sees | Not yet |
|---|---|---|---|
| `/fees` | `fees/dues`, `grades`, `sections`, `fees/dues/export` + `exports/:id` + `exports/:id/file` | "Fee dues": one row per pupil enrolled in the chosen year with the fee for the year, what has fallen due, what is paid and the balance (a red pill when money is owed, "Paid ahead" when the family is in credit); the footer adds up the whole search, not the page. Year, class, section and "With dues" chips and a search, all on the server. Export (Excel or PDF) needs `fees.export`; Collections and Fee setup are links. A parent lands on the same screen titled "Fees" with their own children only, no class chips and no search | No guardian name or phone on the row; no reminder |
| `/fees/collections` | `fees/receipts`, `fees/receipts/export` + `exports/:id` + `exports/:id/file` | The ledger between two dates (this month so far by default): number, date, pupil, kind in plain words (Payment, Refund, Cancelled receipt, Waiver, Extra charge), mode, amount and the standing of a payment; the footer says collected, refunded and net over the whole search. Export needs `fees.export` | No daily cash book by mode |
| `/fees/setup` | `fees/heads`, `fees/structures`, `grades`, create, update and delete of both | "Fees charged": the school's own list, with who pays it (everyone in a class, or only pupils who take it), how often and whether it is still in use. "Amounts": the amount per instalment for the chosen year, "Every class" or one class. Add, edit and remove need `fees.manage`, per row through `allowedActions`; a fee somebody has been charged cannot be removed and the server's sentence says so | Who pays and how often are fixed once a fee exists; a school that needs a different shape retires the fee and adds another |
| `/fees/students/:studentId` | `fees/students/:id/statement`, `students/:id/enrollments` (a parent's year list), `opt-ins`, `concessions`, `adjustments`, `collect` | The statement for one year: the totals, a line per fee (instalments due of the year's, charged, concession, adjustments, due so far, paid, balance), the optional fees and concessions behind them, and every ledger row. A year chip: the school's year list for an office role, the child's own enrolment years for a parent, so last year's statement is a chip away after promotion. "Collect fee" needs the record's `fees.collect`: the sheet lists every fee with anything left in the year, fills in what has fallen due, needs a reference for anything but cash, sends whole paise and never a receipt number, and opens the receipt it made. Optional fees, concessions and adjustments need `fees.manage`; each reason typed goes to the audit note and is never shown back | The concession's reason is never shown, by design; a concession has no dates of its own |
| `/fees/receipts/:receiptId` | `fees/receipts/:id`, `refund`, `cancel`, `fees/receipts/:id/export` + `exports/:id` + `exports/:id/file` | One ledger row: number, date, pupil, kind, mode, reference, who paid, the fees it covers and its standing, plus what it reverses and what reverses it. "Download receipt" for anybody who can open it (a parent prints their own child's). A standing payment offers Refund (each line capped at what that fee carried) and Cancel receipt (with a reason) to a record allowing `fees.manage`; the page says plainly that a receipt is never edited | No reprint count |
| Dashboard fee cards | `dashboard` | Office and accountant: collected today (with the receipt count), collected this month, outstanding dues and pupils with dues, each a link; absent when the server sent no `fees` block. Parent: "Fees due ₹X" per child, linking to the statement, or "No fees due" | — |
| Student profile | — | "Fee statement" link on the Student panel for anybody holding `fees.read` | — |

### Attendance

| Screen | Endpoints | What each role sees | Not yet |
|---|---|---|---|
| `/attendance` | `attendance/sections` (date), `students` (a parent's children) | Office and teacher: one row per section of the day the date chip names (today by default): class, section, pupils on the roster, Marked or Not marked, present and absent counts, the last save; row click opens the register. A teacher sees the sections they teach or look after; the office sees them all. A "Staff register" button for `staff_attendance.read`. A parent: one card per child, linking to the child's calendar. A caller with `staff_attendance.read` alone (the accountant) is sent to the staff register | No filter by class; a section with nobody enrolled that day cannot be marked |
| `/attendance/sections/:sectionId` | `attendance/sections/:id/days/:date`, `mark`, `correct` | The marking screen, a full page: roll, pupil, and five marks per row, everyone present to start with. The server's `window` decides the button: "Save attendance" on today for a caller the record allows `attendance.record` (sends the whole roster); "Save corrections" on a past day for `attendance.manage` (asks for a reason, sends only the changed rows); neither, with the server's own sentence, when the day is a Sunday, a holiday, outside the year, in the future, or the teacher's window has closed. A Day and a Month tab | The reason a correction was made is never shown back, by design |
| `/attendance/sections/:sectionId/month` | `attendance/sections/:id/months/:month`, `attendance/sections/:id/months/:month/export` + `exports/:id` + `exports/:id/file` | The register for a month: one row per pupil, a letter per day (P, A, L, LV, H; blank when not enrolled; a dot for an unmarked school day), then the counts and the percentage. Export (Excel with the day grid, PDF with the summary) when the record allows `attendance.export` | — |
| `/attendance/students/:studentId` | `attendance/students/:id/months/:month`, `students/:id/enrollments` (a parent's month list), `attendance/students/:id/months/:month/export` + `exports/:id` + `exports/:id/file` | One pupil's month: the summary (percentage, present, absent, late, leave, half day, school days, not marked) and a calendar grid with a mark per day, Sundays and holidays named, days before the pupil joined blank. A month chip: the school's years for an office role, the child's own enrolment years for a parent, so last year stays a chip away after promotion. "Download PDF" for anybody who can open the page | — |
| `/attendance/staff` | `staff-attendance/days/:date`, `markStaff`, `correctStaff` | The staff register for a day: code, name, designation and five marks per row. The caller's own row carries "Marked by a colleague" and no picker, and the body never includes it. Save and Save corrections exactly as the pupil screen, under the `staff_attendance` keys. A teacher sees their own row alone and no save; the accountant sees everybody and no save | — |
| `/attendance/staff/month` | `staff-attendance/months/:month`, `staff-attendance/months/:month/export` + `exports/:id` + `exports/:id/file` | The staff register for a month, the same grid as a section's; export for `staff_attendance.export` | — |
| `/attendance/staff/:staffId` | `staff-attendance/staff/:id/months/:month` | One person's month, the same shape as a pupil's. A teacher reaches their own from the staff register row or the staff record | — |
| Student profile and staff record | — | "Attendance" link on the Student panel for `attendance.read`; "Attendance" link on the staff record for `staff_attendance.read` | — |

### Exams and report cards

| Screen | Endpoints | What each role sees | Not yet |
|---|---|---|---|
| `/exams` | `exams` (year), `exams/papers` (year), `exams` create and update | Shaped by the chosen view. The office: the four exams of the pattern for the year chip's year, set up or not, with dates, re-check deadline, Open or Locked, and sections published of total; "Set up exams" and each row's edit open a sheet; row click opens the exam. A teacher: "My marks sheets", one row per paper they may open (their own subject in their own sections, and every subject of the class they are class teacher of) with the entered count, the deadline and a status tag; row click opens the sheet. A parent: their children, each linking to their results | — |
| `/exams/:examId` | `exams/:id`, `exams/:id/sections/:sectionId/publish` | The office's moderation view: one row per section with pupils, papers complete, and a status (Incomplete, Ready to publish, Published, Changed since published) with the server's sentence when it is not ready; each paper's count and a link to its sheet; "Publish results" or "Publish again" for `exams.publish` | — |
| `/exams/papers/:paperId` | `exams/papers/:id`, `saveMarks`, `correct`, `history`, `exams/papers/:id/export` + `exports/:id` + `exports/:id/file` | The marks sheet, a full page: roll and pupil down, the components across with what each is out of, a mark or a status (Absent, Medical, Exempt) per cell and the subject's total. The server's `window` decides the controls: "Save marks" while the sheet is open, asking for a reason when a saved mark changed; after the deadline a read-only sheet with the sentence "The re-check deadline has passed. Only the office can change these marks now.", and for the office a "Correct marks" mode that always asks for a reason. A changed cell carries a marker that opens its history. "Download register" (Excel) for `exams.export` | The words of a reason are never shown back, by design |
| `/exams/students/:studentId` | `exams/students/:id/results`, `report-cards/students/:id`, `students/:id/enrollments` | One pupil's results for a year, one panel per exam: marks with the grade beside each subject total, or grades alone when the school shows grades to parents. A parent sees published results only and a sentence until there are some. Below, the pupil's published report cards, newest first. The year chip is the child's own enrolment years for a parent | — |
| `/exams/report-cards` | `report-cards/sections` (year, card) | Term 1 or Final and the year; one row per section the person may prepare or read: pupils, co-scholastic grades entered, cards published, cards that would change, and whether the exams are ready | — |
| `/exams/report-cards/sections/:sectionId` | `report-cards/sections/:id/terms/:term/entries`, `saveEntries`, `report-cards/sections/:id/cards/:card`, `publish`, export | Two tabs. "Co-scholastic and remarks": per pupil, A, B or C for the four areas and the remarks, saved in one write by the class teacher (`report_cards.manage`). "Report cards": the exams the card needs and where each stands, each pupil's newest version and a "Changed since published" tag, "Publish report cards" or "Publish again" for `report_cards.publish`, "Download all" for `report_cards.export` | — |
| `/exams/report-cards/:versionId` | `report-cards/versions/:id`, `report-cards/versions/:id/export` + `exports/:id` + `exports/:id/file`, `school/logo` | One published card in the school's layout as it was published: logo, header lines, the blocks in their order, signature lines and the footer note, with the version and its date; "Download PDF" for `report_cards.export` | — |
| `/exams/settings` | `report-cards/settings`, `saveSettings` | Grade bands (checked as they are typed, with the server's sentence), what parents see (marks with grades, or grades alone) and the report card layout, with a live preview built from a fixed sample card. Read-only without `exams.manage`. Reached from "Exams & report cards" in the Settings group | — |
| `/setup/school` | `school/logo` upload, remove | The school profile gains a logo block: the logo, "Upload logo" (PNG or JPEG, up to 512 KB) and "Remove logo" for `school.update` | — |
| Dashboard | `dashboard` | A teacher's "Marks to enter" (their open sheets with empty cells, soonest deadline first); the office's exams block (sheets outstanding, sections ready to publish, published of total); a parent's child card links to the newest published report card | — |

### Messages

| Screen | Endpoints | What each role sees | Not yet |
|---|---|---|---|
| Sidebar and mobile tabs | `messages/inbox/unread` every minute and on focus | Everybody holding `communication.read` has a "Messages" item with an unread badge; the parent view has it as a bottom tab. Asking for the count also starts the school's message pump in the background | — |
| `/messages` | `messages/inbox`, `messages` | Two tabs from `?tab=`. Inbox, for everyone: the messages addressed to the person, bold until opened, with kind, sender, the pupil it is about, a paperclip for files, "Unread only" and a kind chip. Sent, for those who hold `communication.send` or `communication.manage`: the office sees every message the school sent, automatic ones included, a teacher their own and those sent to their sections; kind, status, audience and "Written by me" chips, a title search, and "read x of y" from the server's counts | — |
| `/messages/new`, `/messages/:messageId/edit` | `messages/audiences`, `messages/audience-preview`, `messages/templates`, `messages` create and update, attachments, `send` | One form: the audiences the server says the person may choose (a teacher sees only their own sections and their pupils), a live sentence of who it would reach ("Goes to 58 families: 51 in the app, 44 by email. 4 have not agreed to messages and will get nothing."), a notice template, title and body with the placeholders allowed for that audience, up to three files, and Send now or Schedule | Times are read and written as India time |
| `/messages/:messageId` | `messages/:id`, `messages/:id/recipients`, `inbox/:id/read`, `send`, `unschedule`, `withdraw`, delete, `messages/:id/export` + `exports/:id` + `exports/:id/file`, attachments | The words and files. A recipient's first open marks it read. The author and a reader who reaches it other than as a recipient see the delivery figures and the delivery list with outcome, read and email chips, and export it with `communication.export`. Actions follow the status and the record's actions: Edit and Delete a draft, Edit and "Cancel schedule" a scheduled message, "Withdraw message" with a reason for a sent one ("Emails already sent cannot be taken back.") | — |
| `/messages/templates` | `messages/templates` list, create, update, archive | Notice templates, readable with `communication.send`, changed in a Sheet with `communication.manage` | — |
| `/messages/settings` | `messages/settings`, `messages/templates` | `communication.manage`: one panel per automatic message with its switch, its options (absence delay, days before a fee falls due, overdue every so many days where 0 is off, the morning hour) and its words with the placeholders it may use and "Restore the built-in words". Fee dues follow the fee reminder switch | — |

### Access management and settings

| Screen | Endpoints | What each role sees | Not yet |
|---|---|---|---|
| `/settings/users` | `members` (page, search, role, status, staffId), `changeRoles`, `suspend`, `remove`, `restore`, `startRecovery`, `access-explanation`, `invitations` list/create/resend/revoke, `staff/search` | `members.read` sees the directory. Invite needs `members.invite` and `roles.assign` and at least one assignable role. Each lifecycle button needs its own key and the transition. The sheet also respects the delegation rules: self, an owner target and an unmanageable target each get a sentence instead of a form. Below the table, a "Pending invitations" panel lists the school's pending invitations with the masked destination, the roles and the expiry, and a Resend and a Revoke button. It is only asked for and only rendered when the person has `members.invite`, and it is hidden when nothing is pending. Invite, resend and revoke all invalidate the `[schoolId, 'members']` prefix, so the panel is right after a reload as well as after an action | No ownership transfer, no "last active", no bulk selection |
| `/settings/roles` | none | `roles.read` sees the frozen role templates and a read-only matrix of roles against active permission keys | Roles are not editable: `roles.manage` is reserved |
| `/settings/audit-log` | `audit-events` (page, action, outcome, from, to), `audit-events/export` + `exports/:id` + `exports/:id/file`, `redactNote` | `audit.read` sees the list and, under each summary, the note the writer left as their reason; `audit.export` sees the Export button, which opens a dialog whose "Export to Excel" saves the spreadsheet as soon as the server has it; `audit.redact_notes` sees a Redact action in the detail sheet, behind a confirmation, after which the note is gone and the event stays. The list now carries refused attempts as well as reads and writes, and an Outcome chip narrows it to All, Allowed or Refused | The action filter is an exact match, there is no entity or free-text filter and no "who" picker, and Export saves the spreadsheet as soon as the server has it |

## The bridge is gone

Task 6 left a bridge so the mock screens kept working while the session became real. Task 7 deleted
all of it.

- `apps/web/src/api/client.ts`, `seed.ts` and `store.ts` — the in-memory mock API, its dummy data
  for two schools and its store. The whole `src/api` folder is gone.
- `can`, `scope` and `roles` on the `Session` — the `@erp/shared` role vocabulary, which was never
  the server's permission vocabulary. A screen now reads `hasPermission(key)` for the school and
  `allows(record.allowedActions, key)` for one record.
- `legacyRoles` and `setApiContext` in `lib/session.tsx`, and the header comment describing the
  bridge.
- `legacyQk` in `lib/query.ts`. The one key that survived is the public auth config, which is
  school-free and now lives next to its own component in `components/auth/auth-layout.tsx`.
- The stubbed bridge members in `src/test/session.tsx` and the two auth tests that built a session
  by hand.
- `@erp/shared` as a dependency of `apps/web`, removed from `package.json` and the lockfile. The
  package itself stays: `apps/api` and the contracts bridge still use it.

Nothing decides in the browser. `capabilities` and `allowedActions` are answers the server already
computed and sent; the helpers in `lib/permissions.ts` only read them, plus the frozen role
templates for naming a role and previewing a role change. A helper saying yes never makes a request
succeed — the server decides again on every call, and a screen that guessed wrong gets a refusal it
must render as a sentence.

## What each role sees

Checked against [PERMISSION_MATRIX.md](./PERMISSION_MATRIX.md) and the frozen templates in
`packages/contracts/src/role-templates.ts`. The dashboard variant comes from `audiencesFor`, which
mirrors the server's own audience rule: a membership with several roles earns several homes, lands
on the first in the order office, accountant, teacher, parent, and can switch between them from
"Viewing as" in the account menu. Rights are always the union of the roles; the view only changes
the home screen drawn and the shape of the navigation.

| Role | Navigation | Dashboard | Actions |
|---|---|---|---|
| Owner (88 grants) | Everything: Students, Staff, Timetable, Fees, Attendance, Exams, all five School setup screens, Users and logins, Roles and permissions, Audit log, Exams & report cards | Office, with the security list, the attendance card and the exams block | Every write in the app: admit, import, promote, export students; add and edit staff including pay; edit the timetable, periods and substitutions; all setup writes; set the exams up, correct marks, publish results and report cards, and set the grade bands, the layout and the logo; invite, change roles, suspend, remove, restore, send a sign-in reset, explain access; read and export the audit log |
| Principal (81) | Same as owner | Office | Same as owner except staff pay (no `staff.read_pay`/`update_pay`), ownership transfer and audit export. Can read the audit log |
| Admin (73) | Same as principal, without Audit log | Office, with the fee cards | Same as principal, minus the audit log entirely; collects fees and reads statements but never sets, refunds, adjusts or exports them |
| Accountant (22) | Dashboard, Students, Staff, Fees, Attendance (the staff register only), School profile, Academic years, Classes, Subjects, Holidays, Audit log. No Timetable | Accountant — the day, the student tiles and the four fee cards; no class strength | Everything about fees: setup, collect, refund, cancel, adjust, export. Otherwise read-only, plus staff pay, staff export and audit export (the money trail only). No student, setup or member write |
| Teacher (27) | Dashboard, Students, Staff, Timetable, Attendance, Exams | Teacher — now and next, today's timeline, the week, their own class (with whether today's register is marked), the marks they still have to enter and the holidays ahead | Marks today's register for the sections they teach or look after, and re-saves it until the day ends. Enters the marks of their own subject in their own sections until each exam's re-check deadline; a class teacher also reads every subject of their class and enters its co-scholastic grades and remarks. Otherwise reads their own pupils, the staff directory, the timetable, classes, subjects, holidays and their own month of the staff register. No Users, no audit log, no academic years |
| Parent (17) | My children, Timetable, Fees, Attendance, Exams | Parent — one card per child: class, class teacher, today's lessons, the next holiday, this month's attendance, fees due, the newest report card and what the school is waiting on | None. Reads their own children, the timetable of their class, and their children's fee statements, receipts, attendance calendar, and published exam results and report cards for every year they were enrolled |

The student role has no grants at all and cannot sign in; the server refuses the session and the
app sends the person to `/access-unavailable?reason=student`.

## Live check

Against the running API on `127.0.0.1:3001`, school `10000000-0000-4000-8000-000000000001`, every
request with `Origin: http://localhost:5173`, using the exact query strings the screens build. The
owner is `fixture-owner-a` with a second factor, the teacher is `fixture-adult` (teacher and
parent), the parent signed in with a phone code.

| Endpoint | Owner | Teacher | Parent |
|---|---|---|---|
| `/dashboard` | 200 | 200 | 200 |
| `/students?page=1&pageSize=25&status=active&sort=name` | 200 | 200 | 200 |
| `/students/:id` | 200 | 200 | 200 |
| `/staff?page=1&pageSize=25&sort=name` | 200 | 200 | 403 |
| `/staff/:id` | 200 | 200 | 403 |
| `/members?page=1&pageSize=25` | 200 | 403 | 403 |
| `/audit-events?page=1&pageSize=50` | 200 | 403 | 403 |
| `/academic-years` | 200 | 403 | 403 |
| `/grades` | 200 | 200 | 200 |
| `/sections?academicYearId=…` | 200 | 200 | 200 |
| `/subjects` | 200 | 200 | 200 |
| `/holidays?academicYearId=…` | 200 | 200 | 200 |
| `/timetable/bell-schedules?academicYearId=…` | 200 | 200 | 200 |
| `/timetable/sections/:id?academicYearId=…` | 200 | 200 | 200 |
| `/search?q=a` | 200 | 200 | 200 |

No query a screen sends was answered with `INVALID_REQUEST`. Every 403 above belongs to a screen or
a navigation item the person never reaches: the sidebar hides the destination, and the screen gates
its query on the capability and shows one sentence, so the refusal is only reachable by typing the
address. The year in each column is that role's own: the owner reads the year list and takes the
one marked current, while a teacher or a parent infers it from the sections they can see.

Task 20 live check, 22 September 2026, against the Sunrise seed on `127.0.0.1:3001` through the
Vite proxy, driven by Playwright's Chromium with a fetch sign-in inside the tab. The class teacher of
Nursery A (teacher1) saw "Attendance not marked yet" with a "Mark attendance" link on the dashboard,
the day list with seven sections and three marked, opened the roster with everyone present, set one
pupil absent and pressed "Save attendance"; the database then held 16 revision-1 rows (15 present,
1 absent) and one `attendance.record` audit row, and the dashboard said "Attendance marked · 1
absent". The parent (parent1, phone code) saw "100.0% this month · 0 absent" and "97.4% this month
· 0 absent" on the two child cards, opened Ishaan's September calendar (19 school days, 19 present)
and walked back to August. The owner saw "Registers marked 11 of 21" and "Absent today 7", the
whole day list, the staff register with "Save attendance", saved it (30 people, one audit row), and
the staff month grid with a letter per day and the percentage column. No console error on any
screen. By curl: teacher3, whose assignment to Class 1 A ended on 31 August, gets 404 on that
section's roster and on a mark, and the section is absent from their day list; teacher2, who
teaches Nursery A but is not its class teacher, may read and mark it; the parent gets 404 for
another family's child in either year and 403 on a write; the accountant gets 403 on every pupil
route and reads the staff register with no save; the owner's correction of a past day left the
original row at revision 1 and wrote a revision 2 row of kind `correction` whose reason is only in
the audit note.

## Tests

`pnpm --filter @erp/web test -- --run` — 33 files, 352 tests after Task 20 (31 files, 328 tests when
this section was first written). The screen files added in Task 7, with the data lifecycle cases Task 12 added to them:

| File | Tests | What they prove |
|---|---|---|
| `components/dashboard/office-dashboard.test.tsx` | 17 | The sentence about today in the singular and the plural, with cover and without, on a holiday and on a Sunday; each attention row with the link it points at and "All clear" when every key is zero; the glance tiles, the section pills and the twelve bars; holidays and birthdays; recent activity, and the security list only when the server sent one; the checklist shown at three of five steps and hidden at five; no "Admit student" without `students.create` |
| `components/dashboard/teacher-dashboard.test.tsx` | 12 | Now and next against a fixed clock: the class being taught, the one after it, a free period, before school, after the last class and a cover duty; no school on a Sunday with what Monday starts with; a named holiday; the not-linked empty state; the class list link; empty states for a week with no periods |
| `components/dashboard/parent-dashboard.test.tsx` | 7 | One card per child with class, class teacher and today's lessons; what the school is waiting on and "All done." when nothing is; no school today instead of an empty timetable; nothing claimed about a class or a holiday the server did not send; the no-children empty state; consents fetched only when the parent asks |
| `components/dashboard/accountant-dashboard.test.tsx` | 7 | The day, the student tiles and the fees note; the class strength card left out when the block was not sent, and empty and filled told apart when it was; the mix and movement tiles left out when only the roll was sent; when school reopens; only the links the person may follow |
| `components/dashboard/dashboard-route.test.tsx` | 8 | The skeleton while the first read is in flight; a refused read is one sentence; one request and the screen for the audience the server answered with, for all four audiences; the stored view is sent when the roles earn it and dropped when they do not |
| `components/dashboard/blocks/format.test.ts` | 15 | The date, time and month wording the blocks use, the twelve months of an academic year, the plural helper and `subjectColor`, which never picks an alert hue |
| `components/layout/nav.test.tsx` | 8 | Every allowed destination plus the counts and the year name; a teacher loses Staff and both section labels and never calls the count endpoints; a parent sees "My children" and no quick actions; a teacher who is also a parent and chose "Parent" gets the parent shape with the union of destinations; "Viewing as" is absent for one home, and for two lists them, ticks the current one, remembers the choice and invalidates the dashboard; the command menu hides actions it lacks and searches through `api.search.run`; a parent without `students.read_basic` never searches |
| `components/students/student-screens.test.tsx` | 13 | The roster sends the exact params and no `academicYearId`; the admit, import and promote actions disappear without their keys; a refused roster is one sentence; the record shows only the blocks the server allowed; the edit sheet sends the version the person was shown and invalidates the prefix; the bulk bar hides Export and polls the job |
| `components/admission/admit-state.test.ts` | 6 | The draft becomes a request the contract accepts, with `+91` E.164 phones; each contract problem lands on the step that can fix it; the import mapper only sends rows the contract can describe; every sample row carries a distinct admission number |
| `components/staff/staff.test.tsx` | 8 | The directory's exact list params and both header controls; controls vanish without `staff.create`/`staff.export`; a 403 is one sentence; assignments and the editor follow `staff.manage_assignments`; the employment save sends the shown version and omits `leavingDate` when blank; a record carrying only read keys shows no Pay panel and no edit control |
| `components/setup/setup-screens.test.tsx` | 9 | Classes send the year and hide every section control without `sections.manage`; the profile save sends every field with the version and normalises the phone, and is read-only without `school.update`; a 403 on holidays is a sentence; the holiday edit sheet sends the version the row carried; the subjects tab and Add button follow their keys |
| `components/settings/settings.test.tsx` | 9 | The directory renders what the server sent; Invite is absent without `members.invite`+`roles.assign`; no `members.read` means one sentence and no query; a role change sends the version the person was looking at and invalidates; the sheet refuses to change your own access; the audit log hides Export without `audit.export`; the staff login tab |
| `components/timetable/timetable-screens.test.tsx` | 15 | The grid draws what the server sent and Generate follows `allowedActions`; a missing bell schedule is an explained empty state; the schedule save sends `expectedVersion` and hides every editor without the key; a refused teacher-loads read is a sentence and no request; substitutions gate Add and Notify on the day's `allowedActions`; Change deletes before creating; a new period takes the next free index; a cell from a second bell schedule still renders |

Task 12 added twelve cases to those files and two more in `components/admission/admission-screens.test.tsx`: the consent step starts with nothing ticked and reports what was ticked; the review step lists the purposes and the method; the admission request carries one consent row per guardian and purpose with its `guardianIndex`, and none at all when nothing was ticked; the consent list renders and hides Give and Withdraw on the list's own `allowedActions`, and a withdrawal sends the right body; the APAAR id renders masked, reveals on demand and has no Reveal control without the sensitive read; the anonymise action is hidden without the key and sends the version and the reason; an anonymised record shows the tag; a guardian can be unlinked; a parent records a consent from the portal; and the audit note is shown, with Redact hidden without `audit.redact_notes`.

Task 13 added `components/students/export-record.test.tsx` (6): the export button is hidden without
`students.export_subject` on the record, a click fetches the export once and saves a file named by
admission number, the object URL is revoked, nothing is written to the query cache, and a failure is
reported through `describeError`. One more case in `components/settings/settings.test.tsx` covers the
audit screen's outcome chip.

Task 18 adds five cases across the same files, and `pnpm --filter @erp/web test` is now 333 tests across 31 files: the audit screen sends `outcome` to the server rather than filtering the loaded page; the staff Login tab asks the directory for the one membership linked to that staff record; the employment sheet shows a leaving date on file and sends `null` when the person clears it; the promote screen reads every page of a big section and sends it in runs of a hundred; and `describeError` keeps the sentence the server named when a refusal carries a reason.

The foundation tests they build on are `lib/api/api.test.ts` (28), `lib/permissions.test.ts` (22),
`lib/dashboard-view.test.ts` (7: the per-user store, the login seed and the fallback rules),
`lib/http.test.ts` (11), `lib/session.test.tsx` (8) and the Task 6 auth screens (47 across nine
files).

## Run locally

See [the web session](./WEB_SESSION.md#run-locally): the database, the migrations and the fixtures,
then `pnpm dev:api`, `pnpm --filter @erp/api dev:logins` and `pnpm --filter @erp/web dev`. The same
page lists the development sign-ins for each role and how to read a one-time code from the outbox.
The app must be opened at `http://localhost:5173`; the API refuses any other origin.

## Known gaps

Server gaps — a screen cannot do this until an endpoint or a contract field exists.

- Exams: the report card screen asks for the logo without knowing when it last changed, because a parent cannot read the school profile; a changed logo can show from the browser's cache until the page is reloaded. A `logoUpdatedAt` on `ReportCardView` would remove that.
- Exams: the settings preview draws a sample pupil. Its header lines come from the school profile when the person may read it, and from a sample school otherwise.
- Exams: the section page's two tabs are a search parameter (`?tab=`), not `PageTabs`, because `PageTabs` needs a route per tab.

- No school access version is readable, so ownership transfer (which needs
  `expectedSchoolAccessVersion`) is not built.
- `GET /staff` has no staff-type, status or employment filter.
- There is no per-staff bell schedule, so the teacher and substitution screens merge every schedule
  of the year by period index.
- `TimetableEntryRequest` has no `expectedVersion`: setting or clearing one slot is last-write-wins
  by design.
- `/timetable/conflicts` has no section filter and `TimetableConflictList` carries a kind rather
  than a message, so the sentences are built on the client and the list is narrowed to the open
  class.
- No "who is away" list for substitutions, and `AbsentTeacherPeriodList` carries no row id, so the
  panel matches an arrangement by section and period.
- `AuditEventSummary` has no "via", IP address or field-level change table, and
  `AuditEventListRequest` takes only `actorMembershipId`, `action`, `outcome`, `from` and `to`, the
  first two matched exactly.
- The audit log's scope redaction by audience is not implemented server-side (see
  [OPERATION_COVERAGE.md](./OPERATION_COVERAGE.md)).
- No guardian search or directory, so attaching an existing guardian during admission is an id
  field rather than a picker.
- Teacher loads carry no maximum periods per week, so the load bar is relative to the busiest
  teacher on screen.
- `GET /students` matches `academicYearId` against the current enrolment, so the roster sends none
  and the class chip does the narrowing.

Deliberate decisions — settled, not waiting on anything.

- Every member works out the current academic year by asking `GET /academic-years/current`, which is
  gated on `holidays.read` and so open to every role. The school context does not name the year and
  is not going to: one small read every role may make is simpler than widening the context for a
  teacher or a parent, and `useAcademicYear` reads it rather than guessing from the sections.
- A section whose class teacher is somebody the viewer may not read shows "Assigned". The response
  carries `classTeacherId` for everyone and `classTeacher` only where that staff record itself would
  be readable, so the screen can say a class has a teacher without naming them.

Screen gaps — known and deliberate for now.

- Roles are read-only. `roles.manage` is reserved, so the matrix is drawn from the frozen templates
  and there is no create, edit, duplicate or delete.
- `/settings/users` has no "last active" column and no bulk selection; there is no data source and
  no bulk endpoint.
- The student record has no photo, house, previous school, transport, religion, mother tongue,
  nationality, structured address or document upload. The admit form drops the same fields plus
  blood group and medical notes, which admission cannot write.
- The roster columns are person, class, admission number and status: `StudentBasic` carries nothing
  else. The staff directory is person, designation and department for the same reason.
- Section strengths are not shown on the admit and promote pickers, so there is no capacity
  warning.
- Printing a timetable is still a disabled "Phase 2" control.
- The dashboard figures on `/dashboard` itself (`qk.dashboard`) are not invalidated by a write made
  on another screen, so they refresh on navigation rather than immediately. A parent answering a
  consent is the one exception: it invalidates the dashboard so "waiting on you" is right at once.
  The sidebar counts do refresh, because they come from `students/count` and `staff/count` under the
  module prefixes.
- The roster search sends one request per keystroke, clamped to 100 characters. A shared debounce
  hook in `lib/` would be better.
- The browser pass covered the owner only: dashboard, navigation, roster, student record (all
  tabs, add guardian), members directory, staff record (assignment editor) at 1280px and 390px.
  The teacher and parent sessions, the timetable and the settings sheets were checked with curl
  and jsdom tests, not driven by hand at `localhost:5173`.
- Fixture drift worth knowing: the year marked `current` in fixture school A has no sections, so
  screens that resolve a year from the year list find nothing to show there while the data sits in
  an older year.
- Live check leftovers in fixture school A: staff records "Task Seven", "Review Leaver" and
  "Fix Leaver", a student admitted by a live check, a few audit rows with the reason "task 7 live
  check", and some queued export jobs.

## Office feedback, September 2026

Six small changes the school office asked for, all of them on screens that already existed:

1. Every form says what is wrong in plain English, through the one validation layer above.
2. Admission and the guardian sheet take an optional Aadhaar number for the pupil, and an optional
   office address, PAN and Aadhaar number for each guardian.
3. A number that is already on file is never echoed back: the box is replaced by "ending 1234" and a
   Replace button, and the typed number lives only in the form's own state.
4. Pupils and staff have a photograph, uploaded and removed on the record, shown on the detail
   header and in the list. It is fetched from a permission-checked route, so a picture the person
   may not see simply falls back to initials and says nothing about why.
   The browser re-encodes every picture as JPEG before it travels, so the server's checks on the
   type and on the description blocks a WebP may carry are only reached when that re-encoding
   failed; a browser that cannot rewrite the file says "Save the photo as JPEG or PNG and try
   again." and one that sends too many bytes says "Choose a photo smaller than 1 MB."
5. Promotion offers Leave out as well as Promote and Detain, with bulk controls and a count summary.
6. The substitutions screen has a "Free teachers today" panel.

Automatic birthday greetings were asked for at the same time and are deferred to Task 22
(communication), which is where messages get built. Task 22 built them, for pupils and staff.

Task 20 adds `components/attendance/attendance-screens.test.tsx` (5): the day screen renders
"Save attendance" only when the server's `window.record` is true and the record allows
`attendance.record`, and sends the whole roster; it renders "Save corrections" and no
"Save attendance" when only `window.correct` and `attendance.manage` apply, and sends only the
changed rows with the reason; it renders neither and shows the server's sentence otherwise; the
pupil month screen shows the percentage and a "Download PDF" button; and the staff register never
sends the caller's own row.

