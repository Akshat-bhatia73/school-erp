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

## Credential boundaries

| Role | Purpose | Database access |
|---|---|---|
| Migration/operator account | Create and update schema; seed fixtures in development | Privileged. Never supply this credential to application request handling. |
| `erp_runtime` | School repositories | Tenant tables under forced RLS. Read-only fixed role catalogue; append-only audit. No auth-provider tables or identity bootstrap function. |
| `erp_auth` | Better Auth adapter | CRUD on the five global auth tables. No school-domain tables or identity bootstrap function. |
| `erp_identity` | Resolve memberships after verifying a session | Execute the membership bootstrap function. No direct membership, school or auth-table reads. |
| `erp_identity_reader` | Own the bootstrap function | Non-login role with the minimum read columns and dedicated RLS policies needed by that function. Never grant role membership to application logins. |
| `erp_maintenance` | Own the three sweep functions | Non-login role with permissive policies on the transient tables only (import previews, export jobs, outbox, invitations, and a read of memberships). No `BYPASSRLS`, no login, no grant to an application role. |

Production must provision login passwords through its secret-management system. The Docker initialization script provisions development logins. The runtime role must not own tables, bypass RLS, create roles/databases, or belong to another database role.

`activeMembershipsForUser` calls a security-definer function with a fixed search path. It returns only active adult memberships for the supplied verified user in active or trial schools. Its execute privilege is restricted to `erp_identity`. The authenticated user ID must come from the verified session, not a browser parameter. This function is a trusted server capability, not a replacement for session verification.

## Tenant transactions

Backend repositories call `withTenantTransaction(pool, verifiedRequestContext, callback)`. The helper takes the full server `RequestContext` contract, validates the actual checked-out connection's runtime and session roles, opens a transaction and sets the school and request ID locally. The callback receives pg and Drizzle clients on that same connection. Commit and rollback clear the local context; a failed rollback discards the connection.

Do not retain the callback's clients or use the unrestricted pool from a route handler. Await every query inside the callback. Task 2 constructs trusted contexts after session and membership verification. Task 3 applies permission, relationship, field and access-version checks before constructing repository queries.

RLS filters school-owned tables by `school_id`; the school root uses its own `id`. Missing context returns no rows and rejects writes. Both read and write policies are present and RLS is forced. This prevents an omitted tenant filter from exposing another school. It does not decide which children a parent may view, which classes a teacher teaches, or who may read salary. Those checks remain mandatory in the authorization and API tasks.

## Relationships and state

Composite foreign keys prevent references to another school's students, staff, guardians, memberships, roles and setup records. Section references that include an academic year also constrain that year. Bell-schedule grade membership uses a relation table with same-school foreign keys; the old array column is constrained to remain empty.

Adult memberships may hold both teacher and parent roles. Student memberships remain inactive and cannot carry adult links or roles. Role/link changes lock the relevant membership row to serialize conflicting changes. Membership removal is a status change in the future service, not deletion of a person's employment or historical records.

Invitations store a token digest, normalized destination, proposed fixed roles and an existing staff link where required. The database constrains their state and role shape. The invitation service must still verify the recipient, recheck the inviter's current delegation authority, enforce token expiry, rotate tokens on resend and consume invitations atomically.

Resource exceptions have typed targets, same-school references, validity dates, an author and a reason. Their supported permission/target pairs match the shared contracts. Referenced records cannot be deleted while a rule still references them, even if the rule is revoked. Prefer archiving such resources; any future deletion workflow must explicitly handle dependent rules and preserve audit history.

Fixed role grants are read-only to the runtime connection. Audit rows cannot be updated or deleted by it. Audit redaction, safe file downloads, outbox delivery/retries, ownership-transfer locks and immediate access-version invalidation belong to their service tasks. The database does not turn a generic SQL query or an audit JSON payload into a safe response.

## Data lifecycle

Migration `0009_data_lifecycle.sql` (Task 12) adds the tables and privileges behind consent, anonymisation and the daily sweep.

`guardian_consents` records what a guardian agreed to, for which student and purpose, by which method, and who took it down. It is append-only in the same two ways as `audit_events`: the runtime holds `SELECT, INSERT` only, and a trigger refuses `UPDATE` and `DELETE`. Withdrawal is a newer row, so the current answer for a purpose is simply the newest row of `(school_id, student_id, guardian_id, purpose)`, which the index serves.

`audit_event_notes` holds the words somebody typed into a reason box, one row per audit event. It exists so `audit_events.safe_changes` stays structural: no free text from a request body belongs in a row that can never be edited. The note can be redacted, so this table alone takes `UPDATE`.

Students, guardians and staff gain `anonymised_at`. Students keep only `apaar_last4` and `apaar_ciphertext`: the API seals the APAAR id with a key the database never sees. The unused `photo_url` columns and the full `apaar_id` are gone. `DELETE` is revoked on `students`, `guardians`, `staff` and `student_documents`: removing a person is a status change plus anonymisation, and the register row stays.

Three `SECURITY DEFINER` functions owned by `erp_maintenance` do the cross-school work that no request-scoped login may do. `sweep_tenant_transients()` clears expired import previews, finished export jobs and old outbox rows, blanks the contact on a spent invitation and deletes it after 90 days; only `erp_runtime` may execute it. `sweep_auth_transients()` clears expired verifications, sessions, throttle rows and held text messages, and `sweep_orphaned_credentials(grace)` deletes the sessions, accounts and second factor of an identity whose last membership ended longer ago than the grace and blanks its contact while keeping `id` and `name` for audit attribution; only `erp_auth` may execute those two. None is executable by `PUBLIC`. The invitation trigger allows exactly one change to a terminal row, blanking `identifier_normalized`, and still refuses any change of status.

## Fixtures and checks

The deterministic development fixtures include two populated schools, unrelated families, one adult who is both teacher and parent, approved guardian-child access, a suspended member, a disabled student identity, and current/expired resource rules. Role fixtures come from the shared templates. Repeating the fixture command does not create duplicate grants or people.

Migration `0007_number_sequences.sql` (Task 8) adds `number_sequences`, the per-school counters behind server-assigned admission numbers and employee codes, keyed by `(school_id, kind, period)` under the same tenant RLS policy; `erp_runtime` may read, insert and update it and never delete it. The fixtures seed students `A/2026-27/001`, `A/2026-27/002` and `B/2026-27/001`, staff `A-E001`, and the school A counters that continue after them. How the API allocates from the table is documented in [protected school APIs](PROTECTED_APIS.md#server-assigned-numbers).

Tests use real PostgreSQL logins and the production transaction helper. They cover missing tenant context, wrong-school references, pooled connection reuse, rollback, auth/identity credential separation, forced-RLS coverage, database/Drizzle schema parity, provider field compatibility, relationship/state constraints, and the lifecycle rules above: no runtime `DELETE` on a person, append-only consents, one executor per sweep function, and a sweep that clears both schools under no tenant context. These database tests complement the Task 0 contract tests; live API and browser authorization tests remain Task 9 work.

Provider fields are checked against the pinned Better Auth 1.7.4 core, phone and MFA schemas. Task 2 must configure UUID ID generation and map the exported auth tables into its Drizzle adapter. Provider field compatibility does not prove password, OTP, MFA, session or proxy behavior; those require Task 2 integration tests.

Design references: [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html), [Better Auth database schema](https://better-auth.com/docs/concepts/database), [phone plugin](https://better-auth.com/docs/plugins/phone-number), and [MFA plugin](https://better-auth.com/docs/plugins/2fa).
