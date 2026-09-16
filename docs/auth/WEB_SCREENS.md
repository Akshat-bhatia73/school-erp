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
| `/dashboard` | `dashboard` (one of four audiences), then office only: `sections/strengths`, `sections`, `grades`, `subjects`, `school`, `academic-years`, `audit-events?pageSize=8`; teacher: `timetable/bell-schedules`; parent: `timetable/sections/:id` per child | Office: active students, staff count, strength per section, setup checklist, recent activity. Teacher: assigned classes and today's periods. Parent: one card per child with class and today's timetable. Accountant: the server's message and two links | Attendance and fee panels, gender split, admitted-this-year and teaching/non-teaching sub-lines: no endpoint carries them |

### Students

| Screen | Endpoints | What each role sees | Not yet |
|---|---|---|---|
| `/students` | `students` (page, search, sectionId, status, sort), `sections`, `grades`, `students/export` + `exports/:id` | Office: the roster, the class chip, search, and Admit / Import / Promote / Export as their permissions allow. Teacher: their own pupils, no write action. Parent: their own children | No gender or admission-type filter, no "N boys / N girls" footer, no bulk move or leave, and the roster deliberately sends no `academicYearId` (the server matches it against the current enrolment, which hid every past pupil) |
| `/students/:id` | `students/:id`, `/guardians`, `/siblings`, `/documents`, `/enrollments`, `files/student-document`, plus `updateBasic`, `updateSensitive`, `move`, `leave`, `addGuardian`, `updateGuardian` | Each block and tab appears only because the server sent it and listed the action: edit name, edit details, move section, mark as left, guardians, siblings, documents, class history | Correcting a guardian already on file (the contract has no guardian version), photo, house, transport, structured address, document upload |
| `/students/new` | `students/count`, `sections`, `grades`, `students` (create) | Needs `students.create`; attaching an existing guardian also needs `students.manage_guardians` | Medical fields, religion, mother tongue, nationality, Aadhaar, APAAR, previous school, transport and the structured address; attaching an existing guardian is an id field, not a picker |
| `/students/import` | `students/import/preview`, `students/import/commit`, `sections`, `grades` | Needs `students.import`; the counts and the row errors are the server's, never the browser's | The admission number must be supplied; the school does not generate one |
| `/students/promote` | `academic-years`, `sections`, `grades`, `students/promote/preview`, `students/promote` | Needs `students.promote`; a reason is required | 100 students per run (`IdList`), no capacity warning, no attendance column |

### Staff

| Screen | Endpoints | What each role sees | Not yet |
|---|---|---|---|
| `/staff` | `staff` (page, search, sort), `staff/departments`, `staff/export` + `exports/:id` | Office: the directory with Add staff and Export. Teacher: the staff they may see, no write action. Parent: refused, and the destination is not in the navigation | No staff-type, status, employment or department filter on the server; the department chip narrows the loaded page only. No photo, phone, employee code or subject count in the list |
| `/staff/:id` | `staff/:id`, `staff/:id/assignments`, `assign`, `unassign`, `updateEmployment`, `updatePrivate`, `updatePay`, plus `members` for the Login tab and `sections`/`grades`/`subjects` for the assignment pickers | Employment, Contact and Pay panels appear only when the server sent that block; each Edit only when the record allows it. The Login tab needs `members.read`; the Timetable tab needs `timetable.read` | The employment sheet cannot clear a leaving date, because the detail response never carries one. No "class teacher of", no room number, no separate status actions |
| `/staff/new` | `staff/departments`, `staff` (create) | Needs `staff.create` | Pay, address, experience, blood group and the old "create a login" switch: creation never makes a login, an invitation does |

### School setup

| Screen | Endpoints | What each role sees | Not yet |
|---|---|---|---|
| `/setup/school` | `school`, `school` (update) | Office roles read it; only `school.update` sees the form, everybody else reads the same values as plain facts | Principal name, website, established year, logo, and the split city/district/state/PIN address: the contract has one free-text address |
| `/setup/academic-years` | `academic-years`, create, update (also "Make current") | `academic_years.manage` sees Add and the row menu | No delete |
| `/setup/classes` | `grades`, `sections`, `sections/strengths`, create/update/delete for both, `staff` for class-teacher names | `sections.read_strengths` sees the Students column; `staff.read_directory` sees a teacher's name, otherwise "Assigned" | No `classTeacher` on the section response, so the name comes from the first 100 staff; a refused delete only says the record is still in use |
| `/setup/subjects` | `subjects`, `grades`, `grade-subjects`, create/update/delete, `setGradeSubjects` | `subjects.manage` sees Add and the editable matrix; `grades.read` sees the "By class" tab | — |
| `/setup/holidays` | `holidays` (year optional), create, update, delete | Every role holding `holidays.read` sees the list, including a teacher or parent who cannot read years | The type chip filters the loaded year in the browser; the server takes only `academicYearId` |

### Timetable

| Screen | Endpoints | What each role sees | Not yet |
|---|---|---|---|
| `/timetable` | `grades`, `sections`, `timetable/bell-schedules/for-grade`, `timetable/sections/:id`, `timetable/conflicts`, `grade-subjects`, `generate`, `free-teachers`, `setEntry`, `clearEntry` | Anybody with `timetable.read` sees the grid for a class they may see. Editing a cell needs the record's `timetable.manage_entries`; Generate needs `timetable.generate`; the conflicts panel needs `timetable.read_conflicts` | Setting one slot has no `expectedVersion` (last write wins); the conflicts endpoint has no section filter, so the list is narrowed in the browser and labelled as this class's |
| `/timetable/periods` | `timetable/bell-schedules`, create, update | `timetable.manage_periods` edits; everybody else reads the same schedule as text | The bell schedule has no version column, so `expectedVersion` is always 1 and a concurrent edit is not detected. Reordering or removing a period renumbers and can move existing entries; the screen warns about it |
| `/timetable/teachers` | `timetable/teacher-loads`, `timetable/bell-schedules`, `timetable/staff/:id` | Needs `timetable.read_teacher_loads`; a teacher or parent gets one sentence and no request is made | No per-staff bell schedule, so the rows are every schedule of the year merged by period index. No max-periods limit, no per-day counts from the load row |
| `/timetable/substitutions` | `timetable/substitutions`, `bell-schedules`, `staff/search`, `absent-periods`, `free-teachers`, create, delete, `notify` | Arranging needs the day's `timetable.manage_substitutions`; notifying needs `timetable.notify_substitutions` | No "who is away" list on the server: the away list is today's arrangements plus whoever was added in this browser session, and it resets when the date changes |

### Access management and settings

| Screen | Endpoints | What each role sees | Not yet |
|---|---|---|---|
| `/settings/users` | `members` (page), `changeRoles`, `suspend`, `remove`, `restore`, `startRecovery`, `access-explanation`, `invitations` create/resend/revoke, `staff/search` | `members.read` sees the directory. Invite needs `members.invite` and `roles.assign` and at least one assignable role. Each lifecycle button needs its own key and the transition. The sheet also respects the delegation rules: self, an owner target and an unmanageable target each get a sentence instead of a form | No invitation list endpoint, no server-side member search or role/status filter, no ownership transfer, no "last active", no bulk selection |
| `/settings/roles` | none | `roles.read` sees the frozen role templates and a read-only matrix of roles against active permission keys | Roles are not editable: `roles.manage` is reserved |
| `/settings/audit-log` | `audit-events` (page, action, from, to), `audit-events/export` + `exports/:id` | `audit.read` sees the list; `audit.export` sees the Export button | The action filter is an exact match, there is no entity or free-text filter and no "who" picker, and the export queues a job with no download |

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
| Owner (61 grants) | Everything: Students, Staff, Timetable, all five School setup screens, Users and logins, Roles and permissions, Audit log | Office | Every write in the app: admit, import, promote, export students; add and edit staff including pay; edit the timetable, periods and substitutions; all setup writes; invite, change roles, suspend, remove, restore, send a sign-in reset, explain access; read and export the audit log |
| Principal (55) | Same as owner | Office | Same as owner except staff pay (no `staff.read_pay`/`update_pay`), ownership transfer and audit export. Can read the audit log |
| Admin (52) | Same as principal, without Audit log | Office | Same as principal, minus the audit log entirely |
| Accountant (17) | Dashboard, Students, Staff, School profile, Academic years, Classes, Subjects, Holidays, Audit log. No Timetable | Accountant — the server's message and links to Staff and the audit log | Read-only everywhere, plus staff pay, staff export and audit export. No student, setup or member write |
| Teacher (14) | Dashboard, Students, Staff, Timetable | Teacher — assigned classes and today's periods | None. Reads their own pupils, the staff directory, the timetable, classes, subjects and holidays. No Users, no audit log, no academic years |
| Parent (9) | My children, Timetable | Parent — one card per child with class and today's timetable | None. Reads their own children and the timetable of their class |

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

`pnpm --filter @erp/web test -- --run` — 23 files, 199 tests. The screen files added in Task 7:

| File | Tests | What they prove |
|---|---|---|
| `components/dashboard/dashboard.test.tsx` | 6 | Office renders both counts, the joined section strengths and recent activity; a principal without `students.create`, `audit.read` or `sections.read_strengths` sees none of those and neither query fires; teacher and parent variants; a parent without `students.read_enrollments` is not told their child has no class; a 403 is one sentence |
| `components/layout/nav.test.tsx` | 5 | Every allowed destination plus the counts and the year name; a teacher loses Staff and both section labels and never calls the count endpoints; a parent sees "My children" and no quick actions; the command menu hides actions it lacks and searches through `api.search.run`; a parent without `students.read_basic` never searches |
| `components/students/student-screens.test.tsx` | 7 | The roster sends the exact params and no `academicYearId`; the admit, import and promote actions disappear without their keys; a refused roster is one sentence; the record shows only the blocks the server allowed; the edit sheet sends the version the person was shown and invalidates the prefix; the bulk bar hides Export and polls the job |
| `components/admission/admit-state.test.ts` | 4 | The draft becomes a request the contract accepts, with `+91` E.164 phones; each contract problem lands on the step that can fix it; the import mapper only sends rows the contract can describe; every sample row carries a distinct admission number |
| `components/staff/staff.test.tsx` | 8 | The directory's exact list params and both header controls; controls vanish without `staff.create`/`staff.export`; a 403 is one sentence; assignments and the editor follow `staff.manage_assignments`; the employment save sends the shown version and omits `leavingDate` when blank; a record carrying only read keys shows no Pay panel and no edit control |
| `components/setup/setup-screens.test.tsx` | 9 | Classes send the year and hide every section control without `sections.manage`; the profile save sends every field with the version and normalises the phone, and is read-only without `school.update`; a 403 on holidays is a sentence; the holiday edit sheet sends the version the row carried; the subjects tab and Add button follow their keys |
| `components/settings/settings.test.tsx` | 8 | The directory renders what the server sent; Invite is absent without `members.invite`+`roles.assign`; no `members.read` means one sentence and no query; a role change sends the version the person was looking at and invalidates; the sheet refuses to change your own access; the audit log hides Export without `audit.export`; the staff login tab |
| `components/timetable/timetable-screens.test.tsx` | 15 | The grid draws what the server sent and Generate follows `allowedActions`; a missing bell schedule is an explained empty state; the schedule save sends `expectedVersion` and hides every editor without the key; a refused teacher-loads read is a sentence and no request; substitutions gate Add and Notify on the day's `allowedActions`; Change deletes before creating; a new period takes the next free index; a cell from a second bell schedule still renders |

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

- No invitation list endpoint. Invitations created in one browser session are held in component
  state under "Sent this session" and disappear on reload; resend and revoke only work on those.
- No lookup of a membership by staff id. The staff Login tab pages the member directory 100 at a
  time until it finds the person, because `GET /members` has no `staffId` filter.
- No school access version is readable, so ownership transfer (which needs
  `expectedSchoolAccessVersion`) is not built.
- No download for a finished export job. Students, staff and the audit log all queue a job, poll it
  and say in plain English that the file is not available yet.
- The school context does not name the current academic year, so a teacher or a parent — who hold
  no `academic_years.read` — have it inferred from the sections they can see. `useAcademicYear` is
  the one place that guesses.
- `GET /staff` has no department, staff-type, status or employment filter; `GET /members` has no
  search, role or status filter. Both chips narrow the loaded page only and say so in the footer.
- Promotion is capped at 100 students per run by `IdList`; a larger section is refused with a
  sentence telling the person to ask the office.
- `GuardianPrivate` carries no version, so a guardian already on file cannot be corrected.
- `StaffDetailResponse` never returns `employment.leavingDate`, so the sheet cannot tell "blank
  because unknown" from "blank because cleared" and never sends `null`.
- No endpoint names a section's class teacher, so the classes screen maps ids against the first 100
  staff and shows "Assigned" for anybody outside it.
- No setup record (school, year, grade, section, subject, holiday) carries `allowedActions`, so
  those screens gate on school-wide capabilities only.
- A refused delete of a grade, section or subject answers `INVALID_REQUEST` with no reason, so the
  copy is the generic "This still has students or a timetable. Move them first."
- Bell schedules have no version column, so `expectedVersion` is always 1 and a concurrent edit is
  not detected; and there is no per-staff bell schedule, so the teacher and substitution screens
  merge every schedule of the year by period index.
- `TimetableEntryRequest` has no `expectedVersion`: setting or clearing one slot is last-write-wins
  by design.
- `/timetable/conflicts` has no section filter and `TimetableConflictList` carries a kind rather
  than a message, so the sentences are built on the client and the list is narrowed to the open
  class.
- No "who is away" list for substitutions, and `AbsentTeacherPeriodList` carries no row id, so the
  panel matches an arrangement by section and period.
- `AuditEventSummary` has no "via", IP address or field-level change table, and
  `AuditEventListRequest` takes only `actorMembershipId`, `action`, `from` and `to`, all matched
  exactly.
- The audit log's scope redaction by audience is not implemented server-side (see
  [OPERATION_COVERAGE.md](./OPERATION_COVERAGE.md)).
- No guardian search or directory, so attaching an existing guardian during admission is an id
  field rather than a picker.
- Teacher loads carry no maximum periods per week, so the load bar is relative to the busiest
  teacher on screen.
- `GET /students` matches `academicYearId` against the current enrolment, so the roster sends none
  and the class chip does the narrowing.

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
- The dashboard figures on `/dashboard` itself (`qk.dashboard`) are not invalidated by a write, so
  they refresh on navigation rather than immediately. The sidebar counts do refresh, because they
  come from `students/count` and `staff/count` under the module prefixes.
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
