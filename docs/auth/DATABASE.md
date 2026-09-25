# Database and tenant isolation

Task 1 adds `@erp/db`: PostgreSQL tables, Drizzle mappings, migrations, restricted database roles, a transaction helper and development fixtures. It does not connect the mock UI to the database or implement login, role delegation, resource authorization or safe API responses.

The SQL files in [packages/db/migrations](../../packages/db/migrations) define the database constraints, triggers, row-level security (RLS) and privileges. [schema.ts](../../packages/db/src/schema.ts) provides the matching Drizzle table mappings. Live database tests compare every application table's columns, types and nullability against those mappings. Use the SQL migration runner for changes; do not use `drizzle-kit push` to replace the reviewed policies or constraints.

## Run locally

Use Node 24.15+ (24.x), pnpm 10 and Docker. The PostgreSQL 18.6 container binds only to `127.0.0.1:54329`. Its passwords are development examples, not production credentials.

```sh
pnpm install --frozen-lockfile
docker compose -f compose.db.yml up -d --wait

MIGRATION_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp pnpm db:migrate
# One disposable database for every test suite: created, granted and migrated.
TEST_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp_test pnpm db:test:prepare
TEST_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp_test pnpm test:db

# Optional: populate the same development fixtures outside the test run.
FIXTURE_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp pnpm db:fixtures

MIGRATION_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp pnpm --filter @erp/db migrate:check
```

The test suite writes fixtures and test rows, so point `TEST_DATABASE_URL` only at a disposable test database such as `erp_test`. The `erp` database is the development one: it is for `pnpm dev:api`, `pnpm db:fixtures` and `pnpm --filter @erp/api dev:logins` only, and no test suite may be pointed at it. To remove this container and its local data, run `docker compose -f compose.db.yml down -v`.

The migration runner requires `MIGRATION_DATABASE_URL`; it never falls back to the runtime `DATABASE_URL`. It records SHA-256 checksums and rejects changes to applied migration files. Apply new numbered migrations once this branch is merged or used beyond disposable databases. The initial migrations create database roles, so provision them with an appropriately privileged operator account before using a restricted deployment migrator on managed PostgreSQL.

## Non-superuser migrators

A managed PostgreSQL gives the migrator a database owner with `CREATEROLE`, not a superuser; on Neon that is `neondb_owner`. Migrations 0002, 0009 and 0010 hand SECURITY DEFINER functions to the `NOLOGIN` roles `erp_identity_reader` and `erp_maintenance`, and `ALTER FUNCTION ... OWNER TO` asks two things of the migrator: it must be a member of the new owner role (otherwise "must be able to SET ROLE"), and the new owner must hold `CREATE` on the function's schema (otherwise "permission denied for schema public"). A superuser satisfies both implicitly, which is why local runs and CI never saw the failure.

`0001_z_migrator_role_bootstrap.sql` settles both before the first transfer: it creates the two roles idempotently, grants them `USAGE, CREATE ON SCHEMA public`, and grants their membership to `current_user`. Its name sorts after `0001_domain_integrity.sql` and before `0002_identity_bootstrap.sql`, because readdir order is the run order. `0011_revoke_bootstrap_create.sql` takes `CREATE` away again at the end; `USAGE` stays. Any later migration that transfers ownership of an object to one of these roles must `GRANT CREATE ON SCHEMA public` to it first and `REVOKE CREATE` at the end of the same file. `packages/db/tests/nonsuperuser-migrate.test.mjs` proves the whole run from empty against a fresh database owned by a `NOSUPERUSER` login.

## Credential boundaries

| Role | Purpose | Database access |
|---|---|---|
| Migration/operator account | Create and update schema; seed fixtures in development | Privileged. Never supply this credential to application request handling. |
| `erp_runtime` | School repositories | Tenant tables under forced RLS. Read-only fixed role catalogue; append-only audit. No auth-provider tables or identity bootstrap function. |
| `erp_auth` | Better Auth adapter | CRUD on the five global auth tables. No school-domain tables or identity bootstrap function. |
| `erp_identity` | Resolve memberships after verifying a session | Execute the membership bootstrap function. No direct membership, school or auth-table reads. |
| `erp_identity_reader` | Own the bootstrap function | Non-login role with the minimum read columns and dedicated RLS policies needed by that function. Never grant role membership to application logins. |
| `erp_maintenance` | Own the four sweep functions | Non-login role with permissive policies on the transient tables only (import previews, export jobs, outbox, invitations, and a read of memberships), plus `SELECT, DELETE` on the access log. No `BYPASSRLS`, no login, no grant to an application role. |

Production must provision login passwords through its secret-management system. The Docker initialization script provisions development logins. The runtime role must not own tables, bypass RLS, create roles/databases, or belong to another database role.

`activeMembershipsForUser` calls a security-definer function with a fixed search path. It returns only active adult memberships for the supplied verified user in active or trial schools. Its execute privilege is restricted to `erp_identity`. The authenticated user ID must come from the verified session, not a browser parameter. This function is a trusted server capability, not a replacement for session verification.

## Tenant transactions

Backend repositories call `withTenantTransaction(pool, verifiedRequestContext, callback)`. The helper takes the full server `RequestContext` contract, validates the actual checked-out connection's runtime and session roles, opens a transaction and sets the school and request ID locally. The callback receives pg and Drizzle clients on that same connection. Commit and rollback clear the local context; a failed rollback discards the connection.

Do not retain the callback's clients or use the unrestricted pool from a route handler. Await every query inside the callback. Task 2 constructs trusted contexts after session and membership verification. Task 3 applies permission, relationship, field and access-version checks before constructing repository queries.

RLS filters school-owned tables by `school_id`; the school root uses its own `id`. Missing context returns no rows and rejects writes. Both read and write policies are present and RLS is forced. This prevents an omitted tenant filter from exposing another school. It does not decide which children a parent may view, which classes a teacher teaches, or who may read salary. Those checks remain mandatory in the authorization and API tasks.

## Relationships and state

Composite foreign keys prevent references to another school's students, staff, guardians, memberships, roles and setup records. Section references that include an academic year also constrain that year. Bell-schedule grade membership uses a relation table with same-school foreign keys; the old array column is constrained to remain empty.

Adult memberships may hold both teacher and parent roles. Student memberships (a pupil's own login, Task 23) hold the student role alone and never an adult link or role; since migration 0019 they may be active. Role/link changes lock the relevant membership row to serialize conflicting changes. Membership removal is a status change in the future service, not deletion of a person's employment or historical records.

Invitations store a token digest, normalized destination, proposed fixed roles and an existing staff link where required. The database constrains their state and role shape. The invitation service must still verify the recipient, recheck the inviter's current delegation authority, enforce token expiry, rotate tokens on resend and consume invitations atomically.

Resource exceptions have typed targets, same-school references, validity dates, an author and a reason. Their supported permission/target pairs match the shared contracts. Referenced records cannot be deleted while a rule still references them, even if the rule is revoked. Prefer archiving such resources; any future deletion workflow must explicitly handle dependent rules and preserve audit history.

Fixed role grants are read-only to the runtime connection. Audit rows cannot be updated or deleted by it. Audit redaction, safe file downloads, outbox delivery/retries, ownership-transfer locks and immediate access-version invalidation belong to their service tasks. The database does not turn a generic SQL query or an audit JSON payload into a safe response.

## Data lifecycle

Migration `0009_data_lifecycle.sql` (Task 12) adds the tables and privileges behind consent, anonymisation and the daily sweep.

`guardian_consents` records what a guardian agreed to, for which student and purpose, by which method, and who took it down. It is append-only in the same two ways as `audit_events`: the runtime holds `SELECT, INSERT` only, and a trigger refuses `UPDATE` and `DELETE`. Withdrawal is a newer row, so the current answer for a purpose is simply the newest row of `(school_id, student_id, guardian_id, purpose)`, which the index serves.

`audit_event_notes` holds the words somebody typed into a reason box, one row per audit event. It exists so `audit_events.safe_changes` stays structural: no free text from a request body belongs in a row that can never be edited. The note can be redacted, so this table alone takes `UPDATE`.

Students, guardians and staff gain `anonymised_at`. Students keep only `apaar_last4` and `apaar_ciphertext`: the API seals the APAAR id with a key the database never sees. The unused `photo_url` columns and the full `apaar_id` are gone. `DELETE` is revoked on `students`, `guardians`, `staff` and `student_documents`: removing a person is a status change plus anonymisation, and the register row stays.

Three `SECURITY DEFINER` functions owned by `erp_maintenance` do the cross-school work that no request-scoped login may do. `sweep_tenant_transients()` clears expired import previews, finished export jobs and old outbox rows, blanks the contact on a spent invitation and deletes it after 90 days; only `erp_runtime` may execute it. `sweep_auth_transients()` clears expired verifications, sessions, throttle rows and held text messages, and `sweep_orphaned_credentials(grace)` deletes the sessions, accounts and second factor of an identity whose last membership ended longer ago than the grace and blanks its contact while keeping `id` and `name` for audit attribution; only `erp_auth` may execute those two. None is executable by `PUBLIC`. The invitation trigger allows exactly one change to a terminal row, blanking `identifier_normalized`, and still refuses any change of status.

## Export files

Migration 0012 widens `export_jobs.kind` to the six kinds a file can be produced for (`students`, `staff`, `audit`, `student_profile`, `staff_profile`, `timetable`) and adds `file_name` and `content_type`, both set only when the file becomes ready. Two more `SECURITY DEFINER` functions owned by `erp_maintenance` and executable by `erp_runtime` alone serve the daily route: `list_queued_export_jobs()` returns the jobs still waiting to be produced across every school, and `list_expired_export_files()` returns the storage keys of jobs past the sweep's deletion threshold, so the bytes are removed before `sweep_tenant_transients()` deletes the rows that name them.

## Office feedback: identity numbers and photographs

Migration `0013_office_feedback.sql` adds no table and no policy: RLS and the table-level grants already cover `students`, `guardians` and `staff`, so the new columns inherit both.

Students gain `aadhaar_ciphertext`, guardians gain `office_address`, `pan_ciphertext`, `pan_last4`, `aadhaar_ciphertext` and `aadhaar_last4`. Every identity number follows the APAAR id: the API seals the value with `DATA_ENCRYPTION_KEY` and the database holds only the ciphertext and the last digits a screen may show. Check constraints fix those shapes, four digits for an Aadhaar number and three digits and a letter for a PAN, so the masked form can never be stored as the whole number.

Students and staff gain `photo_storage_key`, `photo_content_type` and `photo_updated_at`. The bytes live in the private document store and are served only by a permission-checked route; the row never holds a public URL. A check constraint keeps the three columns written and cleared together, and a second limits the type to the three image types the API decides from the file's own first bytes.

## Version counters for the last three editable records

Migration `0014_setup_versions.sql` adds `version integer NOT NULL DEFAULT 1 CHECK (version > 0)` to `schools`, `holidays` and `bell_schedules`, and adds nothing else: RLS and the table-level grants already cover all three, so the new column inherits both.

These were the last editable records with no counter of their own. The school profile and a holiday compared a version derived from `updated_at` at microsecond granularity, and a bell schedule answered 1 for ever and refused any other `expectedVersion`, so two people editing one schedule could not be told apart. All three now go through the same `bumpVersion` every other record uses, which means a stale editor gets `VERSION_CONFLICT` rather than a silent overwrite or a puzzling `INVALID_REQUEST`. The change is additive and every existing row starts at 1, so the release before this one keeps running against the migrated database and simply ignores the column.

## Fees

Migration `0015_fees.sql` adds six tenant tables, each with `school_id`, forced RLS under the same `tenant_isolation` policy as its neighbours, and composite foreign keys that include `school_id`, so a fee row can never point at a pupil, a year, a class, a fee head or a receipt in another school.

| Table | What it holds | Runtime grants |
|---|---|---|
| `fee_heads` | The school's own list of what it charges: name, category, `applies_to` (`class` or `opt_in`), frequency, active, version. The name is unique in a school, ignoring case | SELECT, INSERT, UPDATE, DELETE |
| `fee_structures` | The amount of one head per instalment, for one academic year and one class; no class means every class, and a class row wins over it. Unique per year, head and class | the same |
| `fee_student_heads` | An optional fee one pupil takes, with an optional amount of their own and the dates it runs between | the same |
| `fee_concessions` | A concession for one pupil and year: basis points of every instalment, or an amount off every instalment of one head, with a category from a closed list and no free text | the same |
| `fee_receipts` | The ledger: payment, refund, cancellation, credit and debit adjustment. Server-assigned `receipt_number`, unique per school; `reverses_receipt_id` points at the row a refund or cancellation corrects; a partial unique index allows one cancellation per payment | SELECT, INSERT, and UPDATE on `payer_name` only |
| `fee_receipt_lines` | The amount of one ledger row split by fee head | SELECT, INSERT |

Money is `bigint` paise with a CHECK that it is positive and at most one hundred crore rupees. The Drizzle declarations use `bigint` in number mode; a raw query gets a string, which the API reads through `toPaise`.

The ledger is append-only in the database. The runtime login has no DELETE on either ledger table. `fee_receipts_no_change` refuses every DELETE and every UPDATE except one that sets `payer_name` to NULL and changes nothing else, which is what anonymising a pupil needs; `fee_receipt_lines_no_change` refuses everything. The migration gives no function to `erp_maintenance`, so it needs no CREATE grant on the schema.

Nothing about dues is stored. What a pupil owes is worked out from the structure of their class, their optional fees, their concessions and the days they were enrolled, in one set of common table expressions in `apps/api/src/modules/fees/charges.ts`.

Two CHECK constraints are widened: `number_sequences.kind` gains `receipt` (the period is the academic year id, as for admissions) and `export_jobs.kind` gains `fee_receipt`, `fee_dues` and `fee_collections`. Everything is additive, so the release before this one runs against it unchanged. The release also changes the role templates, so every existing school needs `pnpm db:sync-roles` after the migration; see [the release runbook](./RELEASE.md#4-deploying-a-change).

## Attendance

Migration `0016_attendance.sql` adds two tenant tables, each with `school_id`, forced RLS under the same `tenant_isolation` policy as its neighbours, and composite foreign keys that include `school_id`, so a mark can never point at a pupil, a section, a staff member or a membership in another school. A pupil mark also names its academic year through the `sections (school_id, academic_year_id, id)` key, so the section and the year travel together.

| Table | What it holds | Runtime grant |
|---|---|---|
| `attendance_entries` | One mark per pupil, date and revision: `mark` from the five, `revision` (1 for the first mark on a date, one more per row that supersedes it), `supersedes_entry_id`, `kind` (`marking` by whoever marks the register, `correction` by the office with a reason on the audit row), who recorded it and when. Unique per school, pupil, date and revision, so the current mark (the highest revision) is unambiguous | SELECT, INSERT |
| `staff_attendance_entries` | The same shape per staff member and date | SELECT, INSERT |

Both tables are append-only in the database. The runtime login holds no UPDATE and no DELETE, and the `attendance_entries_no_change` and `staff_attendance_entries_no_change` triggers refuse every UPDATE and every DELETE, whoever asks. The reason for a correction is never a column: it is the audit note. The migration gives no function to `erp_maintenance`, so it needs no CREATE grant on the schema.

Nothing about a percentage is stored. Which days are school days, who was on a roster and what the current mark is are worked out in one set of common table expressions in `apps/api/src/modules/attendance/figures.ts`.

One CHECK constraint is widened: `export_jobs.kind` gains `attendance_register`, `attendance_pupil_month` and `staff_attendance_register`. Everything is additive, so the release before this one runs against it unchanged. The release also changes the role templates, so every existing school needs `pnpm db:sync-roles` after the migration; see [the release runbook](./RELEASE.md#4-deploying-a-change).

## Exams and report cards

Migration `0017_exams.sql` (Task 21) adds seven tenant tables, each with `school_id`, forced RLS under the same `tenant_isolation` policy as its neighbours, and composite foreign keys that include `school_id`, so a mark, a publication or a card can never point at a pupil, an exam, a section, a subject or a membership in another school. An exam, a paper, a mark, a publication and a card all name their academic year through the `(school_id, academic_year_id, ...)` keys, so a paper can never join an exam to a section of another year.

The exam pattern is not a table. Every class follows the CBSE two-term scheme, which is a constant in `@erp/contracts`; a school sets only when each exam happens.

| Table | What it holds | Runtime grants |
|---|---|---|
| `exams` | One row per academic year and exam kind (`periodic_test_1`, `half_yearly`, `periodic_test_2`, `annual`): first and last day and the re-check deadline, in that order by CHECK; versioned | SELECT, INSERT, UPDATE |
| `exam_papers` | One sheet per exam, section and subject, made from `grade_subjects` when the office saves the exam | SELECT, INSERT, DELETE (a paper with a mark cannot be deleted: the foreign key from `exam_marks` refuses it) |
| `exam_marks` | One mark per paper, pupil, component and revision. `marks_tenths` is a whole number of tenths, so 7.5 is 75 and no float is stored; `status` is `marked`, `absent`, `medical` or `exempt`, and only `marked` carries a number. A CHECK holds each component to its maximum (100, 50, 50 and 800 tenths). `revision`, `supersedes_mark_id`, `kind` (`entry` or `correction`) and `reason_kind` (`recheck`, `entry_error`, `other`), which a CHECK requires on every revision after the first and on every correction. The exam, year, section and subject are copied from the paper through one composite foreign key. `recorded_at` defaults to `clock_timestamp()` | SELECT, INSERT |
| `exam_publications` | One row each time the office publishes an exam's results for a section; publishing again appends. `published_at` defaults to `clock_timestamp()` | SELECT, INSERT |
| `report_card_entries` | The class teacher's co-scholastic grades (A, B or C for four areas) and remarks for one pupil, section and term; versioned | SELECT, INSERT, UPDATE |
| `report_card_versions` | A published card, frozen: `content` (the figures, bands, display choice and layout at that moment), `remarks` kept apart, `content_hash`, `version_number` unique per pupil, year and card | SELECT, INSERT, and UPDATE on `remarks` only |
| `exam_settings` | One row per school: `display_mode`, `grade_bands` and `layout` as JSON checked by the API against the contracts; versioned. A school with no row uses the defaults | SELECT, INSERT, UPDATE |

Marks and publications are append-only in the database. The runtime login holds no UPDATE and no DELETE on them, and the `exam_marks_no_change` and `exam_publications_no_change` triggers refuse every UPDATE and every DELETE, whoever asks. A published card refuses DELETE and every UPDATE except one that sets `remarks` to NULL and changes nothing else (`report_card_versions_no_change`), which is what anonymising a pupil needs. The reason somebody typed for a change is never a column: it is the audit note.

Both timestamps that decide what a parent sees use `clock_timestamp()`, not `now()`. A mark is published when a publication of its exam for its section is at least as new as the mark, and both writers take the school lock first, so the time each row was really written orders them even when one transaction began before the other committed.

`schools` gains `logo_storage_key`, `logo_content_type` (PNG or JPEG) and `logo_updated_at`, with a CHECK that the key and the type are set together. The older `logo_url` stays and is unused. One CHECK constraint is widened: `export_jobs.kind` gains `exam_marks_register`, `report_card` and `report_cards_section`. Nothing is given to `erp_maintenance`, so the migration needs no CREATE grant on the schema.

Nothing about a total or a grade is stored outside a published card: the current mark is the highest revision, a total follows from the scoring rule in `@erp/contracts`, a grade from the school's bands. Everything is additive, so the release before this one runs against it unchanged. The release also changes the role templates, so every existing school needs `pnpm db:sync-roles` after the migration; see [the release runbook](./RELEASE.md#4-deploying-a-change).

## Messages

Migration `0018_communication.sql` (Task 22) adds five tenant tables with `school_id`, forced RLS under `tenant_isolation` and composite foreign keys that include `school_id`.

| Table | What it holds | Runtime grants |
|---|---|---|
| `communication_settings` | One row per school: the switches and options of the automatic messages and `automatic_since`; keyed by `school_id`, versioned. A school with no row has the defaults | SELECT, INSERT, UPDATE |
| `message_templates` | The school's notice templates and its own wording for automatic kinds (at most one live per automatic kind); archived, never deleted | SELECT, INSERT, UPDATE |
| `messages` | One announcement: kind, audience and the id it needs, rendered title and body, status and its times, author (null for the school's automatic messages, which carry a unique `dedupe_key` instead), template; versioned | SELECT, INSERT, UPDATE, DELETE (a draft only, by trigger) |
| `message_attachments` | Up to three files per message in the private store; the key is server state | SELECT, INSERT, DELETE |
| `message_recipients` | One row per guardian or staff member a message was for: outcome, in the app or not, the email's progress with a masked address, and when it was read; section, year and author copied from the message for the scope terms | SELECT, INSERT, and UPDATE of the email columns and `read_at` only |

The `messages_guard` trigger refuses any change to a message's words, audience, kind, author or send time once it has gone out, allows only `sent` to `withdrawn` as a status change, and allows blanking the words with `redacted_at` for anonymisation. It refuses a delete except of a draft, or by `erp_maintenance` in the retention sweep. `list_message_schools()` lets the daily cron route enumerate schools (a SELECT policy and a column grant on `schools.id` for `erp_maintenance` alone); `list_expired_message_attachments()`, `forget_message_attachment()` and `sweep_messages()` do the two-year retention in the files-before-rows order the export files use. `export_jobs.kind` gains `message_delivery`.

## Observability

Migration `0010_observability.sql` (Task 13) adds the access log and durable account lockout.

`access_log` holds one row per `/api` request: method, the route pattern, status, our error code, the user, membership and school ids, a keyed hash of the client address, duration and request id. It never holds the concrete URL, the query string, the body, cookies or the user agent. It is global infrastructure like `auth_throttle`, so it has no tenant policy and no foreign keys: a row must survive the deletion of what it names. `erp_runtime` holds `INSERT` and nothing else, because no API answer is ever built from this table; `erp_maintenance` holds `SELECT, DELETE` for the sweep, and reading it is an incident step taken with the migrator login. Indexes on `(at)` and `(membership_id, at)` serve the two questions an incident asks. A fourth `SECURITY DEFINER` function, `sweep_access_log()`, deletes rows older than 180 days and is executable by `erp_runtime` only.

`auth_user` gains `disabled_at`, `locked_until` and `failed_sign_ins`: ten failed password sign-ins lock the identity for fifteen minutes, and an operator can disable one outright. Both live on the identity because no school owns a cross-school identity, and `erp_auth` already holds `UPDATE`.

## Fixtures and checks

The deterministic development fixtures include two populated schools, unrelated families, one adult who is both teacher and parent, approved guardian-child access, a suspended member, a disabled student identity, and current/expired resource rules. Role fixtures come from the shared templates. Repeating the fixture command does not create duplicate grants or people.

Migration `0007_number_sequences.sql` (Task 8) adds `number_sequences`, the per-school counters behind server-assigned admission numbers and employee codes, keyed by `(school_id, kind, period)` under the same tenant RLS policy; `erp_runtime` may read, insert and update it and never delete it. The fixtures seed students `A/2026-27/001`, `A/2026-27/002` and `B/2026-27/001`, staff `A-E001`, and the school A counters that continue after them. How the API allocates from the table is documented in [protected school APIs](PROTECTED_APIS.md#server-assigned-numbers).

Tests use real PostgreSQL logins and the production transaction helper. They cover missing tenant context, wrong-school references, pooled connection reuse, rollback, auth/identity credential separation, forced-RLS coverage, database/Drizzle schema parity, provider field compatibility, relationship/state constraints, and the lifecycle rules above: no runtime `DELETE` on a person, append-only consents, one executor per sweep function, and a sweep that clears both schools under no tenant context. The observability tests check that the runtime may insert into `access_log` but not read or delete it, that `erp_auth` cannot touch it at all, that `sweep_access_log()` removes a 200-day-old row and keeps a 100-day-old one, and that the lockout columns exist with the counter defaulting to zero. These database tests complement the Task 0 contract tests; live API and browser authorization tests remain Task 9 work.

Provider fields are checked against the pinned Better Auth 1.7.4 core, phone and MFA schemas. Task 2 must configure UUID ID generation and map the exported auth tables into its Drizzle adapter. Provider field compatibility does not prove password, OTP, MFA, session or proxy behavior; those require Task 2 integration tests.

Design references: [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html), [Better Auth database schema](https://better-auth.com/docs/concepts/database), [phone plugin](https://better-auth.com/docs/plugins/phone-number), and [MFA plugin](https://better-auth.com/docs/plugins/2fa).

Migration `0020_member_restrictions.sql` (September 2026) replaces `reject_bad_exception_permission`: on the school target the catalogue also takes `students.read_sensitive`, `students.read_guardians` and `students.read_medical`, as a deny only, which is how a member restriction is stored (see [access management](./ACCESS_MANAGEMENT.md#member-restrictions)).

Migration `0019_student_login.sql` (Task 23) lifts the rule that refused an active student membership and adds what a pupil's own login needs: `grades.level` (Class 1 to 12, filled from class names such as "Class 9", "Std 10" or "Class XI"; pupils in 9 to 12 get a login), `auth_user.must_change_password`, three identity functions owned by `erp_identity_reader` and executable by `erp_identity` only (`active_memberships_for_user`, which replaces `active_adult_memberships_for_user`; `student_login_state`; `student_sign_in_user`, which reads the school login code, the admission number and the link through two new `identity_bootstrap` policies and column grants), the `student_password` purpose on `held_sms`, and on messages `recipients` (`families`, `students`, `both`; null for staff audiences), `grade_to_id` for the new `grade_range` audience and `message_recipients.is_student` for a pupil's own row. Its two backfills (class numbers, `recipients = 'families'` on existing messages) lift `FORCE ROW LEVEL SECURITY` for the statement only, because a managed database's migrator does not bypass row security.
