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
| Sidebar, mobile nav, command menu | `students/count`, `staff/count` (office only), `search`, academic years or sections through `useAcademicYear` | Office: every destination its permission allows, plus student and staff counts and the year name. Teacher: Dashboard, Students, Staff, Timetable. Parent: "My children" and Timetable, no quick actions, no year tag. Accountant: Dashboard, Students, Staff, School setup reads, Audit log | No count for a role without `students.read_basic` / `staff.read_directory`; no year name for a teacher or parent |
| `/dashboard` | `dashboard` only: one request, `api.dashboard.get(schoolId)`. The screen calls no other endpoint; the parent consent block asks for a child's consents when the parent opens it | Office: one sentence about today (school day, holiday or Sunday, teachers away and periods without cover), the things needing a person with a link to each, the student mix and students per teacher, class strength per section, admissions by month, holidays and birthdays ahead, recent activity with a security list for an owner, and a setup checklist that disappears once all five steps are done. Teacher: what they are teaching now and next from the browser clock, today's timeline with cover duty marked, the whole week, their own class and the holidays ahead; an honest empty state when the login is not linked to a staff record. Parent: one card per child with class, class teacher, today's lessons, the next holiday and what the school is waiting on, plus "Manage consent" (Give and Withdraw when the list allows `students.manage_consents`, recorded through the portal) and "Download my child's record" for `students.export_subject`, saved as `<admission number>-record.json`. Accountant: the day, the student tiles and a note where fee cards will go (the accountant role holds no `sections.read_strengths`, so no class strength card is drawn) | A block the caller may not read is absent from the answer, so the screen says nothing rather than showing a zero. A teacher's export of their own week is not offered: nothing on the web side knows their staff id. Attendance, exam and fee cards: no table carries them yet |

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
`packages/contracts/src/role-templates.ts`. The dashboard variant comes from `audienceFor`, which
mirrors the server's own audience rule.

| Role | Navigation | Dashboard | Actions |
|---|---|---|---|
| Owner (71 grants) | Everything: Students, Staff, Timetable, Fees, all five School setup screens, Users and logins, Roles and permissions, Audit log | Office, with the security list | Every write in the app: admit, import, promote, export students; add and edit staff including pay; edit the timetable, periods and substitutions; all setup writes; invite, change roles, suspend, remove, restore, send a sign-in reset, explain access; read and export the audit log |
| Principal (64) | Same as owner | Office | Same as owner except staff pay (no `staff.read_pay`/`update_pay`), ownership transfer and audit export. Can read the audit log |
| Admin (56) | Same as principal, without Audit log | Office, with the fee cards | Same as principal, minus the audit log entirely; collects fees and reads statements but never sets, refunds, adjusts or exports them |
| Accountant (21) | Dashboard, Students, Staff, Fees, School profile, Academic years, Classes, Subjects, Holidays, Audit log. No Timetable | Accountant — the day, the student tiles and the four fee cards; no class strength | Everything about fees: setup, collect, refund, cancel, adjust, export. Otherwise read-only, plus staff pay, staff export and audit export (the money trail only). No student, setup or member write |
| Teacher (16) | Dashboard, Students, Staff, Timetable | Teacher — now and next, today's timeline, the week, their own class and the holidays ahead | None. Reads their own pupils, the staff directory, the timetable, classes, subjects and holidays. No Users, no audit log, no academic years |
| Parent (13) | My children, Timetable, Fees | Parent — one card per child: class, class teacher, today's lessons, the next holiday, fees due and what the school is waiting on | None. Reads their own children, the timetable of their class, and their children's fee statements and receipts for every year they were enrolled |

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

## Tests

`pnpm --filter @erp/web test -- --run` — 31 files, 328 tests. The screen files added in Task 7, with the data lifecycle cases Task 12 added to them:

| File | Tests | What they prove |
|---|---|---|
| `components/dashboard/office-dashboard.test.tsx` | 17 | The sentence about today in the singular and the plural, with cover and without, on a holiday and on a Sunday; each attention row with the link it points at and "All clear" when every key is zero; the glance tiles, the section pills and the twelve bars; holidays and birthdays; recent activity, and the security list only when the server sent one; the checklist shown at three of five steps and hidden at five; no "Admit student" without `students.create` |
| `components/dashboard/teacher-dashboard.test.tsx` | 12 | Now and next against a fixed clock: the class being taught, the one after it, a free period, before school, after the last class and a cover duty; no school on a Sunday with what Monday starts with; a named holiday; the not-linked empty state; the class list link; empty states for a week with no periods |
| `components/dashboard/parent-dashboard.test.tsx` | 7 | One card per child with class, class teacher and today's lessons; what the school is waiting on and "All done." when nothing is; no school today instead of an empty timetable; nothing claimed about a class or a holiday the server did not send; the no-children empty state; consents fetched only when the parent asks |
| `components/dashboard/accountant-dashboard.test.tsx` | 7 | The day, the student tiles and the fees note; the class strength card left out when the block was not sent, and empty and filled told apart when it was; the mix and movement tiles left out when only the roll was sent; when school reopens; only the links the person may follow |
| `components/dashboard/dashboard-route.test.tsx` | 6 | The skeleton while the first read is in flight; a refused read is one sentence; one request and the screen for the audience the server answered with, for all four audiences |
| `components/dashboard/blocks/format.test.ts` | 15 | The date, time and month wording the blocks use, the twelve months of an academic year, the plural helper and `subjectColor`, which never picks an alert hue |
| `components/layout/nav.test.tsx` | 5 | Every allowed destination plus the counts and the year name; a teacher loses Staff and both section labels and never calls the count endpoints; a parent sees "My children" and no quick actions; the command menu hides actions it lacks and searches through `api.search.run`; a parent without `students.read_basic` never searches |
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

The foundation tests they build on are `lib/api/api.test.ts` (28), `lib/permissions.test.ts` (21),
`lib/http.test.ts` (11), `lib/session.test.tsx` (8) and the Task 6 auth screens (47 across nine
files).

## Run locally

See [the web session](./WEB_SESSION.md#run-locally): the database, the migrations and the fixtures,
then `pnpm dev:api`, `pnpm --filter @erp/api dev:logins` and `pnpm --filter @erp/web dev`. The same
page lists the development sign-ins for each role and how to read a one-time code from the outbox.
The app must be opened at `http://localhost:5173`; the API refuses any other origin.

## Known gaps

Server gaps — a screen cannot do this until an endpoint or a contract field exists.

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
(communication), which is where messages get built.
