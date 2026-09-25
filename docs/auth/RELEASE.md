# Release runbook

What to set up, what to check and who says yes before a real school's data goes
into this system. Written for the person doing the cutover, not for a machine.

Two things run: the **site** (the built single-page app on Vercel) and the
**API** (a container running `apps/api`). The browser only ever talks to the
site's own address. Everything under `/api` is forwarded by Vercel to the API,
so the session cookie stays on one origin and no cross-origin rules apply.

## 0. Hosting decisions

Decided on 17 September 2026 for the MVP, where every service must be free
and the users are internal testers.

| Need | Decision | Consequence |
|---|---|---|
| Site | Vercel (Hobby) | Unchanged. |
| API | Vercel Functions in the same project as the site | `/api` is same-origin, so the rewrite to another host, `API_TRUST_PROXY` and the cross-host cookie questions in sections 1 and 3 fall away once the Vercel entry ships. The Dockerfile and the rewrite stay in the repository as the documented path for a real container later. Hobby is for non-commercial use: the first paying school means the Pro plan. |
| PostgreSQL | Neon, through the Vercel Marketplace | Free tier; the four logins are created with plain SQL; row-level security works; a database branch is the disposable test database. Compute suspends when idle, so the first request after a quiet spell is slow. |
| Email | Resend (free tier) with a domain the project controls; Brevo if there is no domain yet | One delivery adapter behind `DELIVERY_MODE=provider`. |
| SMS | **Stays sandboxed.** Parent phone codes are read from the sandbox outbox by testers | Indian transactional SMS needs DLT registration under a company entity and approved templates, so there is no free, legitimate route to arbitrary numbers. Twilio's trial can reach numbers each tester verifies if real phones become necessary. MSG91 with DLT when a real school signs. Until then checklist item 6 is accepted for testing, never for a real school. |
| Private documents | Vercel Blob, private access | One storage adapter behind the existing `DocumentStorage` interface. |
| Secrets | Vercel environment variables | |
| Backups | Neon's restore window plus a weekly `pg_dump` from a GitHub Actions cron kept as an artifact | Satisfies item 9 once the first restore has been rehearsed. |
| Errors and uptime | Sentry (free) for errors and the denied-access alert; Better Stack (free) for uptime | Vercel log drains are a paid feature, so the API ships its own signals. |

Section 0.1 is the path in use. Sections 1 and 3 describe the container path
and stay correct for it; section 2 applies to both.

## 0.1 The Vercel path, as built

The Vercel project's root directory is the repository root, with no framework
preset and no command overrides, so the root `vercel.json` governs. `pnpm
build` builds the site into `dist/` and bundles the API into
`apps/api/dist/vercel.mjs` (`apps/api/scripts/build-vercel.mjs`); `api/index.js`
re-exports that bundle as the one function, and `vercel.json` rewrites
`/api/(.*)` to `/api` before the single-page catch-all. The workspace packages
are bundled because they publish TypeScript sources; registry packages are
traced from `node_modules`. `apps/api/src/runtime.ts` assembles the app for
both `server.ts` and the function, so there is one way to start it.

Production environment variables, beyond the three database URLs and
`AUTH_SECRET` of section 2:

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Turns on the production guards. |
| `APP_ORIGIN` | `https://<site>` | The one origin; the API is under it. |
| `API_TRUST_PROXY` | `true` | A function is reachable only through Vercel's edge, which overwrites `X-Forwarded-For`, so the client address in it is real. Without this every visitor shares one rate limit. |
| `DELIVERY_MODE` | `provider` | Email through Resend. |
| `RESEND_API_KEY`, `EMAIL_FROM` | key; a bare address on the verified domain | Startup refuses provider mode without both. |
| `DOCUMENT_STORAGE` | `blob` | A function has no disk. Needs `BLOB_READ_WRITE_TOKEN`, which the Blob store adds. |
| `SENTRY_DSN`, `VITE_SENTRY_DSN` | the API and site DSNs | Errors only: no bodies, cookies, headers, query strings, users or breadcrumbs leave the process. Each `ACCESS_DENIED` is one warning event grouped by code, which is what the alert of section 7 counts. |
| `HELD_SMS_TOKEN` | 32+ characters, **test builds only** | See below. |

**Text messages in a test build.** There is no SMS provider. In provider mode
an SMS fails, so nobody is told "sent". With `HELD_SMS_TOKEN` set, the message
is kept in `held_sms` for ten minutes instead, and whoever presents the token
reads it at `GET /api/held-codes` (the `/test-codes` page on the site). The
token reads every parent's one-time code, so it is for a database of invented
people only. Checklist item 6: it must be unset before a real school's data
exists.

**Neon.** The database owner (`neondb_owner`) is the migration login: it holds
`BYPASSRLS`, so it must never be one of the three runtime URLs. The
integration writes it to `DATABASE_URL`; override that variable for Production
with the `erp_runtime` URL. The owner is not a superuser, and migrations that
hand a function to `erp_identity_reader` (0002, 0004) need two grants a
superuser would not:

```sql
GRANT erp_identity_reader TO neondb_owner WITH SET TRUE, INHERIT FALSE; -- keep
GRANT CREATE ON SCHEMA public TO erp_identity_reader;  -- before migrating
REVOKE CREATE ON SCHEMA public FROM erp_identity_reader; -- straight after
```

The migrations create the three runtime roles without a login; give each one
with `ALTER ROLE ... LOGIN PASSWORD '...'` and `GRANT CONNECT`.

**Seeding a test database.** `dev:seed` refuses `NODE_ENV=production` and
makes one round trip per row, so against a distant hosted database it times
out. Seed a local scratch database and copy the data across:

1. Create and migrate a scratch database locally. Run `pnpm --filter @erp/api
   dev:seed` against it with the **hosted** `AUTH_SECRET` (second factor
   secrets are encrypted with it), `NODE_ENV=development`,
   `DELIVERY_MODE=sandbox`, a private `SEED_PASSWORD` and
   `SEED_LOGINS_FILE=hosted-logins.csv`. The development password is public,
   so never seed a reachable database with it.
2. `pg_dump --data-only --no-owner --no-privileges` it, excluding
   `erp_schema_migrations` and the data of `auth_session`, `auth_rate_limit`
   and `auth_throttle`.
3. Remove the dump's `set_config('search_path', '', false)` line (a trigger
   function names tables without a schema) and load the file into the empty
   hosted database inside one `BEGIN; ... COMMIT;` as the owner. The circular
   key between `schools` and `academic_years` is deferred, so one transaction
   is enough and no trigger needs disabling.
4. Drop the scratch database and delete the dump: it holds password hashes
   and second factor secrets.

Privileged testers add their `totp_secret` from the CSV to an authenticator
app. Seeding again makes new secrets, so every tester would start over.

## 1. How the two halves are joined

`vercel.json` holds two rewrites, in this order:

1. `/api/(.*)` to `https://api.<your domain>/api/$1`
2. `/(.*)` to `/index.html`

Order matters. If the catch-all came first, every API call would be answered
with the app's HTML page and the login would fail in a way that looks like a
frontend bug.

Vercel cannot read environment variables in that file, so the repository ships
the placeholder `https://api.REPLACE-WITH-YOUR-DOMAIN/api/$1`. Replacing it is
the first item on the checklist. `pnpm check:assets` refuses a build that still
contains the placeholder unless `ALLOW_PLACEHOLDER_API_ORIGIN=true` is set; CI
sets it, because this repository has no domain yet.

Because Vercel forwards the request, the API sees Vercel's address, not the
visitor's, unless it is told to read the forwarded headers. Behind the rewrite
the API must run with:

- `API_TRUST_PROXY=true`, so the forwarded protocol and host are used
- `APP_ORIGIN=https://<your site>`, the site address, not the API address

Set `API_TRUST_PROXY=true` only when the API can be reached *only* through
Vercel. If the API's own address is open to the internet, anyone can send a
forged `X-Forwarded-Host` and the server will believe it.

## 2. Environment variables

The API needs three database URLs, each with its own login. They point at the
same database; the difference is what each login may do. This is deliberate: a
break in one path cannot reach the others.

| Variable | Login | Why that login |
|---|---|---|
| `DATABASE_URL` | `erp_runtime` | School data, read and written inside the tenant transaction. Row-level security applies to it. |
| `AUTH_DATABASE_URL` | `erp_auth` | Sessions, passwords, one-time codes and rate limits. No school tables. |
| `IDENTITY_DATABASE_URL` | `erp_identity` | Creating and recovering identities. Narrow on purpose. |
| `MIGRATION_DATABASE_URL` | `erp_migrator` | Deploy-time only, never in the running container. It owns the schema. |

Two more secrets belong to the data lifecycle work:

| Variable | Required | What it is for |
|---|---|---|
| `DATA_ENCRYPTION_KEY` | Yes | Base64 of 32 bytes. Seals sensitive text such as the APAAR id with AES-256-GCM. Production refuses the example value. Losing it makes the sealed fields unreadable, so keep it in the secret store with the rest. |
| `CRON_SECRET` | No, but needed for the daily sweep | 32 characters or more. The daily sweep route exists only when this is set, and accepts only `Authorization: Bearer <CRON_SECRET>`. Vercel sends this header for a scheduled job. |

The running API refuses to start if any of its three URLs signs in as
`erp_migrator`.

Also set: `AUTH_SECRET` (a fresh 32+ character value from your secret store,
never the one in `.env.example`), `APP_ORIGIN`, `API_TRUST_PROXY=true`,
`DELIVERY_MODE`, `PORT`, `HOST=0.0.0.0` (the image sets it), `NODE_ENV=production` and `DOCUMENT_STORAGE_DIR` on a
volume that survives a restart.

Never set in production: `DEV_SANDBOX_OUTBOX` (the server refuses it) and
`ALLOW_SANDBOX_DELIVERY` (sandbox delivery logs one-time codes instead of
sending them; only a controlled staging rehearsal may set it).

The full table is in [authentication and sessions](./AUTHENTICATION.md).

## 3. The API container

`apps/api/Dockerfile` builds from the repository root:

```bash
docker build -f apps/api/Dockerfile -t erp-api .
```

It installs with the frozen lockfile, runs `pnpm --filter @erp/api deploy
--prod` into `/app`, and runs as the unprivileged `node` user. It starts the
server with `tsx`, not a compiled bundle: every workspace package publishes
TypeScript sources and both `pnpm dev:api` and the test suites run them through
`tsx`, so compiling only for the image would create a second, untested way to
start the server. `tsx` is installed separately in the image because `--prod`
drops development dependencies.

`HEALTHCHECK` calls `GET /api/health`, the liveness route registered in
`apps/api/src/app.ts`. Point the platform's health probe at the same path.

The server listens on `HOST`, which defaults to `127.0.0.1` so a developer
machine never exposes the API. The image sets `HOST=0.0.0.0` so the proxy can
reach the container. Publish that port only to the private network the proxy
uses, never to the internet; checklist item 16 checks both halves.

## 4. Deploying a change

1. Merge to `main` with CI green.
2. Run the migrations before the new code starts:
   `MIGRATION_DATABASE_URL=... pnpm db:migrate`
3. Confirm nothing is pending: `pnpm --filter @erp/db migrate:check`
4. Roll the API container.
5. Let Vercel build the site (`pnpm build`), then check the result:
   `pnpm check:assets`.

Migrations run as `erp_migrator` and only at deploy time. The running service
never holds that login.

Migration `0021_assistant.sql` is the assistant release (Task 24, part 24a). It
is additive: four new tables (`assistant_settings`, `assistant_threads`,
`assistant_messages`, `assistant_usage`), one `SECURITY DEFINER` function owned
by `erp_maintenance` (`sweep_assistant`), the `ai_assistant` consent purpose
added to the `guardian_consents` CHECK, and `ai_assistant.use` accepted as a
school-target deny by the restriction trigger, so the previous version of the
code runs against it. **It changes the role templates**: `ai_assistant.use`
becomes active at `self` for all seven roles and `ai_assistant.manage` at
`school` for owner and principal, so every existing school needs
`pnpm db:sync-roles` after the migration: 9 grants per school. It needs new
settings: `ASSISTANT_ENABLED=true` to switch it on at all (it stays off without
it), `ASSISTANT_MODEL` (default `google/gemini-3.5-flash-lite`) and
`ASSISTANT_PROVIDER`: `gateway` (the default; on Vercel the project's OIDC
token reaches the AI Gateway on its own, off Vercel set `AI_GATEWAY_API_KEY`;
the gateway needs a card on the Vercel team) or `google` (Google AI Studio
directly with `GOOGLE_GENERATIVE_AI_API_KEY`, a free-tier key for test data
only). `ASSISTANT_ZERO_DATA_RETENTION` stays `true`; per-request
zero data retention needs the Vercel Pro plan, so a free-plan test deployment
with test data only may set it to `false`, and a real school never. Each school
still switches it on itself under Settings → Assistant. The function's
`maxDuration` is 300 seconds for long answers. The order is the same: migrate,
`migrate:check`, `db:sync-roles`, merge, deploy, smoke.

Migration `0020_member_restrictions.sql` is the member restrictions release
(September 2026). It only replaces `reject_bad_exception_permission`, so the
catalogue trigger also accepts a school-target deny for
`students.read_sensitive`, `students.read_guardians` and
`students.read_medical`, and refuses an allow for them. Additive: the previous code never writes such a row. **It
changes the role templates**: `access.manage` becomes active for owner and
principal, so every existing school needs `pnpm db:sync-roles` (2 grants per
school). No new setting. The order is the same: migrate, `migrate:check`,
`db:sync-roles`, merge, deploy, smoke.

Migration `0019_student_login.sql` is the student login release (Task 23).
It is additive for the previous code apart from one rule it lifts (an active
student membership is now allowed; the previous code never creates one and
still refuses a pupil a session): `grades.level`, filled in from class names,
`auth_user.must_change_password`, three identity functions owned by
`erp_identity_reader` (created under the temporary CREATE grant the rule from
0011 describes), two `identity_bootstrap` policies with column grants,
`held_sms` gains the `student_password` purpose, and messages gain
`recipients`, `grade_to_id` and `message_recipients.is_student` with their
constraints. Its two backfills lift `FORCE ROW LEVEL SECURITY` for the
statement only, so they work for a migrator that does not bypass row security;
check after the migration that every class named "Class 9" to "Class 12" has
its number (`SELECT name, level FROM grades`) and set any other in setup.
**It changes the role templates**: `students.manage_login` for owner,
principal and admin and twelve grants for the student role, so every existing
school needs `pnpm db:sync-roles` (15 grants per school). No new setting. The
order is the same: migrate, `migrate:check`, `db:sync-roles`, merge, deploy,
smoke. Nobody gets a login by the release itself: the office gives the pupils
already in Class 9 to 12 theirs with "Give student logins", and every password
text is held for testers until Task 16.

Migration `0018_communication.sql` is the messages release (Task 22). It is
additive: five new tables (`communication_settings`, `message_templates`,
`messages`, `message_attachments`, `message_recipients`), a policy and a column
grant that let `erp_maintenance` list school ids, four `SECURITY DEFINER`
functions owned by `erp_maintenance` (`list_message_schools`,
`list_expired_message_attachments`, `forget_message_attachment`,
`sweep_messages`, created while the migration holds the temporary CREATE grant
the rule from 0011 describes), and one CHECK constraint widened
(`export_jobs.kind` gains `message_delivery`), so the previous version of the
code runs against it. **It changes the role templates**: the four
`communication.*` keys become active. Every existing school therefore needs
`pnpm db:sync-roles` with the migrator credential, after the migration and
before the smoke test; a school on the previous templates gains 17 grants (four
each for owner, principal and admin, three for teacher, one each for the
accountant and parent). Without it nobody holds a message key and the Messages
screen is missing. It needs no new setting: email goes through the same Resend
key, files through the same private store, and the second cron entry in
`vercel.json` uses the same `CRON_SECRET`. The order is the same as for exams:
migrate, `migrate:check`, `db:sync-roles`, merge, deploy, smoke. A school's
automatic messages start the first time the pump runs for it, never earlier, so
the release sends nothing about old absences or results.

Migration `0017_exams.sql` is the exams and report cards release (Task 21).
It is additive: seven new tables (`exams`, `exam_papers`, the append-only
`exam_marks` and `exam_publications`, `report_card_entries`, the frozen
`report_card_versions` and `exam_settings`), three nullable logo columns on
`schools`, and one CHECK constraint widened (`export_jobs.kind` gains
`exam_marks_register`, `report_card` and `report_cards_section`), so the
previous version of the code runs against it. **It changes the role
templates**: the five `exams.*` and the four `report_cards.*` keys become
active. Every existing school therefore needs `pnpm db:sync-roles` with the
migrator credential, after the migration and before the smoke test; a school
on the previous templates gains 38 grants (nine each for owner, principal and
admin, eight for teacher, three for parent, none for the accountant). Without
it nobody in an existing school holds an exam key: the Exams screen is missing
and every exam and report card route answers `ACCESS_DENIED`. The order is the
same as for fees and attendance: migrate, `migrate:check`, `db:sync-roles`,
merge, deploy, smoke. The mark and publication tables refuse UPDATE and DELETE
by trigger, and a published card allows only its remarks to be cleared, so a
rollback of the code leaves them in place. No real school's data goes in
before the database moves to an Indian region (Task 17), and no result notice
goes to a parent before Task 22.

Migration `0016_attendance.sql` is the attendance release (Task 20). It is
additive: two new append-only tables (`attendance_entries`,
`staff_attendance_entries`) and one CHECK constraint widened
(`export_jobs.kind` gains three attendance kinds), so the previous version of
the code runs against it. Like the fees release it **changes the role
templates**: the four `attendance.*` and the four `staff_attendance.*` keys
become active, and every role but student gains grants. Every existing school
therefore needs `pnpm db:sync-roles` with the migrator credential, after the
migration and before the smoke test; a school on the previous templates gains
29 grants (eight each for owner, principal and admin, three for teacher, one
for parent and one for the accountant). Without it nobody in an existing
school holds an attendance key: the Attendance screen is missing and every
attendance route answers `ACCESS_DENIED`. The order is the same as for fees:
migrate, `migrate:check`, `db:sync-roles`, merge, deploy, smoke.

Migration `0015_fees.sql` is the fees release (Task 19), and it was the first
release that needed **two** steps before the new code starts. The
migration is additive: six new tables (`fee_heads`, `fee_structures`,
`fee_student_heads`, `fee_concessions`, `fee_receipts`, `fee_receipt_lines`) and
two CHECK constraints widened (`number_sequences.kind` gains `receipt`,
`export_jobs.kind` gains three fee kinds), so the previous version of the code
still runs against it. But the release also **changes the role templates**: the
four fee permissions become active and owner, principal, accountant, admin and
parent gain grants. Role grants live in `role_permissions` per school, so every
existing school needs `pnpm db:sync-roles` with the migrator credential, after
step 2 and before the smoke test. Without it nobody in an existing school,
the owner included, holds a fee key: the Fees screen is missing and every fee
route answers `ACCESS_DENIED`. The order is: migrate, `migrate:check`,
`db:sync-roles` (it prints how many grants each school gained; a school on the
previous templates gains 15: four each for owner, principal and accountant, two
for admin and one for parent), merge, deploy, smoke. The
ledger tables refuse UPDATE and DELETE by trigger, so a rollback of the code
leaves them in place; see section 11. No real school's money goes in before the
database moves to an Indian region (Task 17).

Migration `0014_setup_versions.sql` is the screen and contract gaps release. It
adds one column, `version`, to `schools`, `holidays` and `bell_schedules`, with a
default of 1, so the previous version of the code still runs against it and step
2 above is the whole release step. It adds no table, no policy and no
permission, so `pnpm db:sync-roles` has nothing to bring across: no role sync is
needed for this release.

Migration `0012_export_files.sql` is the export-file release. It adds two
nullable columns to `export_jobs`, widens the job-kind constraint and creates
two `SECURITY DEFINER` functions for the daily route, so the previous version of
the code still runs against it and step 2 above is the whole release step. It
needs no new setting: export files are written to the same private store the
student documents already use, through the same `DOCUMENT_STORAGE` choice and
the same `BLOB_READ_WRITE_TOKEN`.

## 5. Backups and restore

A backup nobody has restored is not a backup.

Everything about backups now lives in [BACKUPS.md](./BACKUPS.md): what Neon
keeps and for how long on the current plan, how to restore to a point in time as
a branch, the weekly encrypted dump (`scripts/backup-dump.sh`, never a GitHub
Actions artifact), the quarterly rehearsal with `scripts/restore-rehearsal.mjs`,
and what to do when the primary is lost.

Two facts to carry away from it. Today the only backup that exists is Neon's
six-hour history window on the Free plan. No restore has ever been rehearsed;
every rehearsal goes in [the restore log](../compliance/RESTORE_LOG.md).

## 6. Audit retention and reading

Every membership change, role change and protected write leaves exactly one row
in `audit_events`, written in the same transaction as the change. Keep them for
at least seven years, which covers a student's time at the school. Do not delete
rows to save space; archive whole years to cold storage instead.

Detail reads of one person's record leave a row too: opening a student, their
guardians or their consents, a staff record, an APAAR reveal, a document
download and a subject-access export each write one `allowed` row naming which
blocks were returned. Lists do not, so the volume follows the number of profiles
opened, not roster paging. Every refusal a member receives leaves one `denied`
row. Both are the same seven-year retention.

Audit rows can contain what changed. Read them through the audit API, which
applies the same permission rules as the record itself. Do not hand out direct
database access to read them.

## 6.1 The daily sweep

`GET /api/maintenance/sweep` deletes transient copies: expired import previews,
the bytes of expired export files and then the export job rows themselves,
delivery outbox and invitation rows past ninety days, expired
sessions, one-time codes, throttle rows and held text messages, the login
credentials of people whose last membership ended more than thirty days ago, and
access-log rows older than 180 days. It
never touches a person's record. `vercel.json` schedules it at 20:30 UTC, which
is 02:00 in India. The route is registered only when `CRON_SECRET` is set and
refuses any other bearer token; it logs one line with the counts it removed, one of which is `access_log`.

The same route also produces the export jobs that were too large to make inside
the request that asked for them. Each one is produced under the requester's own
access, in its own transaction, so a job whose requester has lost the permission
is recorded as failed rather than made.

It also removes the assistant's conversations 30 days after each message was
written, then conversations with nothing left, then question counts after 13
months (`sweep_assistant`).

It also removes messages two years after they went out (and drafts untouched for
a year): the attachment bytes first, then the rows (`sweep_messages`), reported
as `messages.files_removed`, `messages.files_left` and `messages.messages`.

## 6.1.1 The message pump

`GET /api/maintenance/messages`, scheduled in `vercel.json` at 02:30 UTC (08:00 in
India), runs the message pump for every school: scheduled messages whose time
has come, the automatic messages that are due (absences, results, report cards,
fee reminders, birthdays) and the email queue. Like the sweep it exists only when
`CRON_SECRET` is set, refuses any other bearer token, stops after 45 seconds
(reporting `schools_left`) and logs one line of counts. The same pump also runs
in the background whenever a member of the school has the app open (the unread
count asks every minute) and after a message is sent now. On the Hobby plan a
cron job runs once a day, so with nobody signed in a scheduled message or an
absence notice waits for that morning run; before the first paying school the
project moves to Pro and this cron to every five minutes (`*/5 * * * *`).

## 6.2 The retention schedule

This is the schedule the system enforces, and the one to publish to a school. It is the engineering
copy of `docs/compliance/RETENTION_SCHEDULE.md`; the two must say the same thing. The columns the
last four rows below are about are added by migration `0013_office_feedback.sql`. The periods that the
code acts on are constants in `@erp/contracts` (`RETENTION`), so the API, the sweep and the screens
quote the same numbers. Periods start when the purpose ends, not when the row was created.

| Data | Keep while | Then | Enforced by |
|---|---|---|---|
| Student register fields (name, admission number, dates, class history, outcome) | Permanently, as state education rules require an admission register | Nothing; these are the register | `DELETE` is revoked from the runtime login |
| Student sensitive fields (birth date, Aadhaar fragment, APAAR, category, religion, medical notes, address, documents) | Enrolled, plus 3 years after leaving | Anonymise: clear the fields, delete the documents | `POST /students/:id/anonymise`, refused before the period has run |
| Student Aadhaar number (the whole number, sealed, with the last four digits beside it) | The same period as the other sensitive fields | Cleared by the same anonymisation step, last four digits included | `POST /students/:id/anonymise` |
| Student photograph | While the photographs consent stands, and no longer than the sensitive period above | Withdrawing the consent removes the bytes the same day; anonymisation removes them in any case | `POST /students/:id/consents`, `DELETE /students/:id/photo`, `POST /students/:id/anonymise` |
| Guardian records | While any linked student is within the period above | Anonymised when the last link ends | The same route, and guardian unlink |
| Guardian PAN and Aadhaar numbers (sealed, with the last four characters beside them) and office address | While any linked student is within the period above | Cleared with the rest of the guardian record | The same route, and guardian unlink |
| Staff photograph | Employed, plus the staff period below | Removed with the rest of the private staff details | `POST /staff/:id/anonymise`, `DELETE /staff/:id/photo` |
| Fee ledger (`fee_receipts`, `fee_receipt_lines`: receipts, refunds, cancellations, adjustments, with number, date, amount, mode and bank reference) | 8 years after the pupil's last fee transaction, as for staff pay | Nothing prunes it today; removal after the period is a school decision and a later task | The runtime login holds no DELETE; the `fee_receipts_no_change` and `fee_receipt_lines_no_change` triggers refuse every edit |
| Payer's name on a receipt (`fee_receipts.payer_name`) | The same period as the student sensitive fields | Cleared by the pupil's anonymisation; the money row stays | `POST /students/:id/anonymise`; the one UPDATE the ledger trigger allows |
| A pupil's concessions and optional fees | With the fee ledger | Kept, because a balance cannot be explained without them; a concession's reason is an audit note, never a column | `fees.manage` routes only |
| Fee heads and structures | Permanently; school setup, not personal data | Nothing | `fees.manage` routes only |
| Pupil attendance (`attendance_entries`: one mark per pupil and school day, with its revision, who recorded it and the row it supersedes) | With the student sensitive fields: enrolled, plus 3 years after leaving | Nothing prunes it today, and anonymisation clears nothing here: a mark identifies nobody on its own | The runtime login holds no UPDATE or DELETE; the `attendance_entries_no_change` trigger refuses every edit |
| Staff attendance (`staff_attendance_entries`) | With the staff record: employed, plus 8 years | Nothing prunes it today | The same grant and the `staff_attendance_entries_no_change` trigger |
| Exam marks and publications (`exam_marks`, `exam_publications`), co-scholastic grades (`report_card_entries`) and published report cards (`report_card_versions.content`) | Permanently, as the pupil's academic record | Nothing | The runtime login holds no UPDATE or DELETE on marks and publications and the `exam_marks_no_change` and `exam_publications_no_change` triggers refuse every edit; `report_card_versions_no_change` refuses every edit of a published card except clearing its remarks |
| The class teacher's remarks (`report_card_entries.remarks`, `report_card_versions.remarks`) | With the student sensitive fields: enrolled, plus 3 years after leaving | Anonymise | `POST /students/:studentId/anonymise` clears both in the same transaction |
| Staff records (salary, identifier fragments, private contact) | Employed, plus 8 years after leaving for statutory payroll records | Anonymise contact and identifiers; keep employment dates and designation | `POST /staff/:id/anonymise` |
| Login identity and credentials | While the person holds any active membership | Sessions end when the last membership is removed; credentials go 30 days later, keeping `auth_user.id` and the name for audit attribution | Membership removal, then `sweep_orphaned_credentials` |
| Sessions, one-time codes, reset tokens, throttle rows, held text messages | Until expiry | Deleted | `sweep_auth_transients`, daily |
| Import previews | 24 hours | Deleted | `sweep_tenant_transients`, daily |
| Export files (a spreadsheet or document made from a list, a record or a timetable) | 24 hours from the moment the file is ready | The bytes are deleted first, then the job row; the audit row saying who asked stays | `list_expired_export_files ()` then `sweep_tenant_transients`, daily |
| Invitations | Until terminal | The identifier is blanked at that point; the row is deleted after 90 days | `sweep_tenant_transients`, daily |
| Delivery outbox | 90 days after delivery or failure | Deleted | `sweep_tenant_transients`, daily |
| Assistant conversations (`assistant_messages`, sealed; `assistant_threads`, title sealed) | 30 days after each message was written | Deleted; a conversation goes once it has no messages and was last used 30 days ago. A person deletes their own at once; anonymising a pupil deletes theirs | `sweep_assistant()`, daily; `DELETE /assistant/threads/:id`; `POST /students/:id/anonymise` |
| Assistant question counts (`assistant_usage`: who, which day, tokens, no words) | 13 months | Deleted | `sweep_assistant()`, daily |
| Audit events | 7 years, covering a child's time at the school plus the one-year log requirement | Archive whole years to cold storage; never edit | Manual; see section 6 |
| Audit notes | With their event, unless redacted on request | Redaction removes the text and keeps the event | `POST /audit-events/:id/note/redact` |
| Access logs | 180 days | Deleted | `access_log` and `sweep_access_log()`, daily. CERT-In wants these kept in India and the database is in Neon `us-east-1`; see section 6.3 |

Anonymisation is never automatic. The sweep deletes transient copies only; clearing a person's
record is a decision a school takes through a permission-gated route, and the route refuses while
the period is still running.

## 6.3 The access log

Every `/api` request except `/api/health` leaves one row in `access_log`, written
by an `onResponse` hook in `apps/api/src/http/access-log.ts` through the runtime
pool. The row holds the method, the **route pattern** (`GET
/api/schools/:schoolId/students/:studentId`, never the concrete URL), the status,
our own error code when one was sent, the user, membership and school ids when
the request had them, an `ip_hash`, the duration and the request id. The
`ip_hash` is an HMAC-SHA256 of the client address keyed by `AUTH_SECRET`, hex,
first 32 characters: two rows can be compared and a suspected address can be
confirmed by hashing it, but no address is stored. Nothing else goes in — no
query string, no body, no cookie, no user agent, no name.

The insert is fire-and-forget. Nothing the client waits for awaits it, and a
failure is logged once and dropped, so the log can never fail a request.

Rows are kept 180 days and removed by `sweep_access_log()` in the daily sweep.
The runtime login holds `INSERT` only; `SELECT` and `DELETE` belong to the
maintenance login and the sweep function. There is no API route that reads the
table. Reading it directly is permitted only during an incident, with the
migrator login, recorded in the incident record: see
[the incident runbook](../compliance/INCIDENT_RESPONSE.md).

**Region.** The database, and therefore this log, is in Neon `us-east-1`. CERT-In
direction 5 requires system logs to be kept within India for 180 days. Neon has
no Indian region, so the retention half is met and the region half is not. This
is a known, written-down gap, not an oversight; the hosting decision belongs to
Task 14 and is finding F19 of
[the data protection assessment](../compliance/DATA_PROTECTION.md).

## 6.4 Disabling an identity

`pnpm --filter @erp/api ops:identity -- --email <address> --disable` sets
`auth_user.disabled_at` and deletes every session that identity holds. `--enable`
reverses it; `--unlock` only clears a lockout from failed sign-ins. It reads
`AUTH_DATABASE_URL`, so run it with the production value from the secret store
and not from a shared shell. Ten failed password sign-ins already lock an
identity for fifteen minutes without anyone doing anything; see
[authentication](./AUTHENTICATION.md#lockout-and-disable). This is the first
containment step in the incident runbook.

## 7. Alerting on repeated denied access

Every refused request logs one line from the API's error handler, in JSON:

```
{"level":40,"requestId":"...","code":"ACCESS_DENIED","msg":"request failed"}
```

The message is always `request failed`; the field to watch is `code`. Alert on:

- `"code":"ACCESS_DENIED"` more than 20 times in 5 minutes from one instance:
  someone is walking through records they cannot see.
- `"code":"AUTHENTICATION_REQUIRED"` in a sudden burst: credential stuffing.
- `"msg":"provider request failed"` in a burst: failed sign-ins.
- `"msg":"phone otp send failed"` at all: delivery is broken, and the caller was
  told nothing on purpose.

A refusal a member receives also leaves a `denied` audit row in that school's
trail, so the audit screen answers who tried what; anonymous refusals have no
school and appear in the access log only. When one membership collects twenty or
more refusals inside ten minutes, the API sends one Sentry event, level error,
message `denial burst`, fingerprint `denial-burst:<membershipId>`, tags
`schoolId`, `membershipId` and `count`. The fingerprint means one issue per
membership, so a burst is one alert and not two hundred. Configure a Sentry alert
rule on that issue — "a new issue is created" with the tag `membershipId`
present — to notify immediately rather than in a digest, and treat it as
severity S2 in [the incident runbook](../compliance/INCIDENT_RESPONSE.md). Sentry
holds ids only: no names, no request bodies, no addresses.

Send these to whoever runs the school's IT, not only to a dashboard. Request
bodies, cookies, passwords, one-time codes and invitation tokens are redacted
before logging and must stay that way.

## 8. HTTPS, cookies and secrets

- HTTPS everywhere. The API refuses to start in production with a plain `http`
  `APP_ORIGIN` unless it is localhost.
- The session cookie is `HttpOnly`, `SameSite=Lax`, host-only and `Secure`
  outside development. It is never given a `Domain`, so it cannot leak to a
  sibling host.
- The database is not reachable from the public internet. The API reaches it on
  a private network.
- `AUTH_SECRET` and the database passwords live in the platform's secret store.
  They are never in the repository, in a build log or in an image layer.
- Rotating `AUTH_SECRET` signs everyone out. Do it deliberately, out of hours,
  and tell the school first.

## 9. Checks that must pass

Run from a clean checkout. CI runs all of these on every pull request and on
`main`; the release manager re-runs them against the release commit.

The "CI check" column is the name the check reports under, which is also the
name to require in the `main` ruleset.

| Check | CI check | Command | What it proves |
|---|---|---|---|
| Types | `typecheck` | `pnpm typecheck` | Nothing compiles by accident. |
| Lint | `lint` | `pnpm --filter @erp/web lint` | No unused or dead code in the app. |
| Contracts | `contracts` | `pnpm test:contracts` | The permission catalogue and API schemas still agree. |
| Database and policy | `database` | `pnpm test:db` then `pnpm test:authz` | Tenant isolation and row-level security hold in real PostgreSQL, and every permission decision matches the matrix. |
| API | `api` | `pnpm test:api` | The protected routes deny, allow and audit as specified. |
| Web | `web` | `pnpm test:web` | The screens read what the server decided. |
| Security | `security` | `pnpm test:security` | The adversarial cases in section 13 of the plan: cross-school reads, forged bodies, expired exceptions. |
| Browser | `browser` | `pnpm test:browser` | Session transitions in a real browser: login, school switch, suspension, sign-out. |
| Assets and advisories | `release` | `pnpm build && pnpm check:assets`, then `pnpm audit:deps` | The shipped site contains no fixture data, no development credentials, no sandbox outbox route, no mock store import and no source maps; and no dependency carries a high or critical advisory. |

Typecheck, lint and contracts were one `static` entry until Task 14. They are
three now so a red pull request names what is red, and so the ruleset can
require each by name.

`pnpm audit:deps` runs `scripts/audit-deps.mjs`. It no longer only reports: the
step blocks the pull request. A high or critical advisory passes only if
`.audit-exceptions.json` holds an entry for it (`{ "id", "package", "reason",
"until" }`, `id` being the numeric advisory id or the GitHub advisory id or its
URL), and the run fails once that `until` date has passed. Every accepted
exception is printed on a green run, so nobody has to open the file to see what
was let through. Today the repository has no exceptions and one moderate
advisory (`GHSA-67mh-4wv8-2f99` in `esbuild`, reached through `drizzle-kit`),
which does not block.

Each database suite needs `TEST_DATABASE_URL` pointing at a disposable database
(`erp_test`), prepared with `pnpm db:test:prepare`. Never point one at `erp`.

## 10. Release checklist

Tick every line. "Verified by" is a person, not a team.

| # | Item | How to verify | Signed off by |
|---|---|---|---|
| 1 | The `/api` rewrite points at the function in this project, or at the real API host | `vercel.json` has no `REPLACE-WITH-YOUR-DOMAIN`; `node scripts/check-deploy-config.mjs` passes without `ALLOW_PLACEHOLDER_API_ORIGIN` | Release manager |
| 2 | The API runs behind the rewrite with `API_TRUST_PROXY=true` and `APP_ORIGIN=https://<site>` | Sign in on the live site; the cookie is set on the site's own host with no `Domain` | Release manager |
| 3 | The API's own address is not reachable from the internet | Request `https://api.<domain>/api/health` from outside; it must fail or be restricted to Vercel | Infrastructure owner |
| 4 | The runtime uses least-privilege logins | `DATABASE_URL`, `AUTH_DATABASE_URL`, `IDENTITY_DATABASE_URL` use `erp_runtime`, `erp_auth`, `erp_identity`; startup refuses `erp_migrator` | Infrastructure owner |
| 5 | `AUTH_SECRET` is fresh and from the secret store | Not the `.env.example` value, 32+ characters; startup refuses otherwise | Infrastructure owner |
| 6 | Sandbox delivery is off, or consciously accepted for staging | `ALLOW_SANDBOX_DELIVERY` and `HELD_SMS_TOKEN` unset in production; `GET /api/held-codes` returns 404; nobody is told "sent" when nothing was sent. During the MVP, SMS stays sandboxed by decision (section 0); email must be real before any outside tester is invited | Product owner |
| 7 | `DEV_SANDBOX_OUTBOX` is unset | Startup refuses it under `NODE_ENV=production`; `GET /api/dev/outbox` returns 404 on the live site | Release manager |
| 8 | Migrations applied | `pnpm db:migrate` then `pnpm --filter @erp/db migrate:check` reports nothing pending. On Neon the migrator is the database owner, not a superuser, and the bootstrap migration `0001_z_migrator_role_bootstrap.sql` handles the role membership and schema grants, so no manual grant is needed any more. Then `pnpm db:sync-roles` with the same credential: system role grants live in `role_permissions` per school and only a sync brings existing schools up to a changed template; read its "extra" lines before ever passing `--prune` | Release manager |
| 9 | Backup and a real restore | [docs/compliance/RESTORE_LOG.md](../compliance/RESTORE_LOG.md) has an entry against the production database with `Outcome: passed`, giving the date, the elapsed time and the checker output from `node scripts/restore-rehearsal.mjs`. See [BACKUPS.md](./BACKUPS.md) section 5 | Infrastructure owner |
| 10 | Audit retention set | Retention policy configured and the audit API returns rows for a test change | Product owner |
| 11 | Denied-access alerting live | Trigger one denial on staging and see the alert arrive | Infrastructure owner |
| 12 | All suites green on the release commit | CI run linked in the release notes | Release manager |
| 13 | Production assets clean | `pnpm build && pnpm check:assets` passes on the release commit | Release manager |
| 14 | No high or critical advisories | `pnpm audit:deps` passes on the release commit. CI runs the same command in the `release` check, so a green CI run is the evidence; any exception in `.audit-exceptions.json` is read out loud in the release notes with its reason and its `until` date, and no `until` date is in the past | Release manager |
| 15 | Independent access review done | [docs/auth/ACCESS_REVIEW.md](./ACCESS_REVIEW.md) is signed and its findings are closed or accepted in writing | Reviewer (not the implementer) |
| 16 | The container accepts traffic from the proxy and from nowhere else | `HOST=0.0.0.0` in the image; `curl` the API from the proxy network and get a response; the same request from the internet is refused (see section 3) | Infrastructure owner |
| 17 | The demo cannot come back | No route serves the old mock store; `pnpm check:assets` fails on any fixture data or `api/seed` / `api/store` import | Release manager |

## 11. Rollback

The site rolls back in Vercel by promoting the previous deployment. The API
rolls back by redeploying the previous image tag.

Migrations do not roll back automatically. Write every migration so the
previous version of the code still runs against it: add columns, do not rename
or drop in the same release as the code change. If a release must remove
something, ship the code first and the removal in a later release.

Rolling back the fees release is a code rollback only. The fee tables and the
fee grants stay: the previous code never reads the tables, and it treats the fee
keys as reserved, so a grant it does not recognise is simply never asked about.
Do not try to empty `fee_receipts`: it refuses DELETE by design.

The same holds for the attendance release: the two attendance tables and the
attendance grants stay, the previous code never reads them and treats the keys
as reserved, and both tables refuse UPDATE and DELETE by design.

## 12. Scope

This release covers staff and parent sign-in, teacher invitations and the
access lifecycle, role changes, relationship-based limits, private responses
and downloads, database isolation and the test suites. Student sign-in is
designed but switched off; the server rejects it. Mobile layout, native apps,
offline data, a policy editor, custom roles and the AI assistant are not part
of it.
