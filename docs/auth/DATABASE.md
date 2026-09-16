# Database and tenant isolation

Task 1 adds `@erp/db`: PostgreSQL tables, Drizzle mappings, migrations, restricted database roles, a transaction helper and development fixtures. It does not connect the mock UI to the database or implement login, role delegation, resource authorization or safe API responses.

The SQL files in [packages/db/migrations](../../packages/db/migrations) define the database constraints, triggers, row-level security (RLS) and privileges. [schema.ts](../../packages/db/src/schema.ts) provides the matching Drizzle table mappings. Live database tests compare every application table's columns, types and nullability against those mappings. Use the SQL migration runner for changes; do not use `drizzle-kit push` to replace the reviewed policies or constraints.

## Run locally

Use Node 24.15+ (24.x), pnpm 10 and Docker. The PostgreSQL 18.6 container binds only to `127.0.0.1:54329`. Its passwords are development examples, not production credentials.

```sh
pnpm install --frozen-lockfile
docker compose -f compose.db.yml up -d --wait

MIGRATION_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp pnpm db:migrate
TEST_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp pnpm test:db

# Optional: populate the same development fixtures outside the test run.
FIXTURE_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp pnpm db:fixtures

MIGRATION_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp pnpm --filter @erp/db migrate:check
```

The test suite writes fixtures and test rows. Point `TEST_DATABASE_URL` only at a disposable test database. To remove this container and its local data, run `docker compose -f compose.db.yml down -v`.

The migration runner requires `MIGRATION_DATABASE_URL`; it never falls back to the runtime `DATABASE_URL`. It records SHA-256 checksums and rejects changes to applied migration files. Apply new numbered migrations once this branch is merged or used beyond disposable databases. The initial migrations create database roles, so provision them with an appropriately privileged operator account before using a restricted deployment migrator on managed PostgreSQL.

## Credential boundaries

| Role | Purpose | Database access |
|---|---|---|
| Migration/operator account | Create and update schema; seed fixtures in development | Privileged. Never supply this credential to application request handling. |
| `erp_runtime` | School repositories | Tenant tables under forced RLS. Read-only fixed role catalogue; append-only audit. No auth-provider tables or identity bootstrap function. |
| `erp_auth` | Better Auth adapter | CRUD on the five global auth tables. No school-domain tables or identity bootstrap function. |
| `erp_identity` | Resolve memberships after verifying a session | Execute the membership bootstrap function. No direct membership, school or auth-table reads. |
| `erp_identity_reader` | Own the bootstrap function | Non-login role with the minimum read columns and dedicated RLS policies needed by that function. Never grant role membership to application logins. |

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

## Fixtures and checks

The deterministic development fixtures include two populated schools, unrelated families, one adult who is both teacher and parent, approved guardian-child access, a suspended member, a disabled student identity, and current/expired resource rules. Role fixtures come from the shared templates. Repeating the fixture command does not create duplicate grants or people.

Tests use real PostgreSQL logins and the production transaction helper. They cover missing tenant context, wrong-school references, pooled connection reuse, rollback, auth/identity credential separation, forced-RLS coverage, database/Drizzle schema parity, provider field compatibility and relationship/state constraints. These database tests complement the Task 0 contract tests; live API and browser authorization tests remain Task 9 work.

Provider fields are checked against the pinned Better Auth 1.7.4 core, phone and MFA schemas. Task 2 must configure UUID ID generation and map the exported auth tables into its Drizzle adapter. Provider field compatibility does not prove password, OTP, MFA, session or proxy behavior; those require Task 2 integration tests.

Design references: [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html), [Better Auth database schema](https://better-auth.com/docs/concepts/database), [phone plugin](https://better-auth.com/docs/plugins/phone-number), and [MFA plugin](https://better-auth.com/docs/plugins/2fa).
