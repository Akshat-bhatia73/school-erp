# Auth and RBAC contract handover

Task 0 defines the rules and shared TypeScript contracts for the auth work. It does not implement login, database isolation, authorization middleware or permission-driven screens. The current application still uses mock data and its legacy role switcher.

Read the [implementation plan](../AUTH_RBAC_IMPLEMENTATION_PLAN.md), [permission summary](PERMISSION_MATRIX.md), [exact generated matrix](PERMISSION_MATRIX.generated.md) and [operation coverage](OPERATION_COVERAGE.md) together. The executable catalogue and fixed templates are authoritative for Task 0 defaults where the earlier plan uses broader role descriptions.

## Package boundary

Import schemas and inferred types from `@erp/contracts`. Import trusted server interfaces from `@erp/contracts/server`. Existing shared-package consumers can opt in through `@erp/shared/contracts`; the legacy shared barrel and mock RBAC remain unchanged.

Requests use strict Zod objects: reject unknown keys, including caller-supplied roles, school ownership, access versions outside the specified concurrency field, and bypass flags. Identifiers are opaque strings, timestamps are ISO timestamps with a timezone, dates are calendar dates, and phone numbers use E.164. List inputs are bounded. Mutation versions are positive integers; services must compare them atomically, not merely parse them.

Response schemas are allowlists, not database row serializers. Separate student basic, sensitive and medical data; separate staff directory, employment, private and pay data. Optional response groups must be omitted when unauthorized. A schema accepting a group is not permission to send it. Domain agents may extend validated business fields as needed, but must update coverage and boundary tests when doing so.

`ACCESS_ENDPOINTS` specifies application access routes, schemas and success statuses. Provider login, OTP, MFA and recovery routes are configured in Task 2. Endpoint permission properties are necessary checks, not a complete authorization implementation.

## Login and trusted identity

Staff use email/password. Privileged roles require authenticator MFA before school data access. Teachers without email may use verified phone OTP. This fallback does not bypass MFA when a teacher is later assigned privileged access. Parents use verified phone OTP and approved guardian-child links. Student identity is modelled, but student login remains disabled and its template has no grants.

The server derives identity from a verified session and reloads the selected school's active membership, roles and access version. A school ID in a URL selects a context; it never proves membership. Never construct `RequestContext` from request JSON or trust browser capabilities as policy. Its TypeScript brand helps prevent accidental construction; it is not a security boundary against malicious code.

School contact changes must not change a person's global verified login email or phone. Credential recovery must verify identity through the auth provider, return no secrets and cannot reset another person's MFA merely because a school administrator requested it. A multi-school identity must not lose other schools' memberships when removed from one school.

## Decision order and scopes

Deny by default. Reject unknown or reserved actions, disabled student access, invalid sessions, inactive memberships and mismatched schools before considering a grant. Apply MFA, field restrictions and business-state checks. Then evaluate applicable role grants and approved resource allows; a matching resource deny wins over either. No exception may bypass school isolation, MFA, inactive membership, reserved actions or ownership rules.

Scopes are independent predicates, never a hierarchy:

| Scope | Required relationship |
|---|---|
| `school` | Resource belongs to the selected school. Other checks still apply. |
| `self` | Resource belongs to the staff record linked to this membership, or is that person's own timetable. |
| `assigned_sections` | A current, effective teaching assignment links this member to the resource's section and academic year. |
| `assigned_subjects` | An effective assignment matches both the section and subject, within the same academic year. Teaching a subject elsewhere does not qualify. |
| `own_children` | An approved, active guardian link connects this member to the child in this school. It does not reveal other guardians' private details or unlinked siblings. |
| `own_record` | Resource belongs to this student's linked record. Reserved for later student activation. |
| `finance` | Resource is in this school and the requested projection is approved for the finance workflow. This is not school-wide access to all fields. |

For teachers, historical enrollment rows are limited to the authorized assignment period; a current assignment must not reveal a child's unrelated historical sections. Parent enrollment summaries remain limited to their linked children. Subject and class labels may be returned only where needed by the authorized view.

Several applicable grants may union their authorized records. They must not combine independent relationships into broader access. Use `privilegedScopes` to decide action-level MFA; the `privileged` flag is descriptive shorthand. Any role with `requiredMfa` requires MFA for school data, even if another role provides a nonprivileged grant.

Filter in the database before pagination, counts, search and aggregates. Apply the same scope to nested joins, exports, file downloads and background jobs. Recheck current membership and access version when a job executes and when a result is downloaded. `AuthorizedReadPlan` is an opaque interface for the future policy engine and repositories, not an implemented query filter.

## Field restrictions

Basic student updates cannot change medical, guardian, enrollment, login or permission fields. Restricted edits require `students.update_sensitive`; medical writes additionally require `students.read_medical`. Apply that additional check to medical fields in admission and import too. An administrator without medical access cannot submit those fields indirectly.

Document listing and download require their respective document permissions. A medical document also requires medical access; an identity document requires sensitive-record access. Filter metadata as well as content. Never return storage keys or permanent public URLs. A timetable may contain minimal teacher attribution without granting directory access.

Salary is available by default only to owner and accountant. Private contact and bank projections must be limited to the needs of the matched audience. Audit events must not expose raw before/after objects, credentials, medical data or salary to an audience without the corresponding access.

## Inviting, changing and removing members

Role assignment needs both `roles.assign` and `ROLE_DELEGATION_RULES`. Membership lifecycle actions also need `ROLE_MANAGEMENT_RULES`. Check every current role on the target and every proposed role. Principal and admin can manage teacher-only targets; a target who is both teacher and owner does not qualify. Deny self-service privilege changes. Generic role assignment cannot create an owner or enable a student.

Invite, resend and restore recheck assignment authority. Store hashed invitation tokens, bind them to the normalized verified destination, school and proposed roles, and enforce expiry and single use. Acceptance must recheck the inviter's current authority and the school's current state. Resend rotates the token; it cannot revive a revoked, accepted or expired invitation. Mask destinations in management responses. Link an existing staff record before activating a staff login; verify parent links separately.

Suspending or removing a school membership immediately invalidates that school's access and queued work. Restore explicitly reviews roles instead of silently restoring old privileges. Lock and compare versions in the transaction, increment access versions, invalidate caches and write audit events with the change. Keep employment records and historical audit records when removing login access.

Ownership transfer is a separate transaction requiring fresh MFA, a verified active adult target and a last-owner lock. It cannot be emulated through role assignment, removal, suspension or a resource exception. The DB and service tasks must implement the session freshness policy and concurrent last-owner tests before exposing this route.

## Resource exceptions

`ResourceAccessRule` defines a limited future allow/deny record with school, membership, action, typed target, validity window, revocation, author, reason and version. Target/action compatibility is validated. No public exception editor or active `access.manage` grant is included. Task 3 implements evaluation; a later feature can add administration without replacing the role model. Any future writer must verify grant authority and all referenced records' school membership.

## Implementation baseline

Use PostgreSQL with Drizzle for the next database task, and Node with Fastify and Better Auth for backend/auth work. Tenant foreign keys, scoped queries and PostgreSQL row-level security must reinforce each other. Application database roles must not bypass RLS. Auth-provider tables do not replace school membership and permission tables.

The workspace was checked with Node 24.15.0, pnpm 10.34.4, TypeScript 6.0.3 and Zod 4.5.4. Zod and TypeScript are pinned for this package. Package metadata reviewed during planning identified Fastify 5.12.4, Better Auth 1.7.4, Drizzle ORM 0.45.2 and pg 8.23.0 as a candidate backend baseline. Those backend packages are not installed or integration-tested by Task 0. Task 2 must pin its final versions and test sessions, OTP, MFA, the Drizzle adapter and transaction behavior together before proceeding.

## Checks and next owners

Run `pnpm test:contracts`, `pnpm typecheck`, `pnpm lint` and `pnpm build:web`. After changing the catalogue or templates, run `pnpm --filter @erp/contracts docs:generate`. Tests check schema boundaries, role defaults, delegation envelopes, generated-matrix drift and coverage of current mock operations and routes. These are contract tests; they do not prove live tenant isolation.

Task 1 implements PostgreSQL schema, tenant constraints and RLS. Task 2 implements verified sessions and login methods. Task 3 implements the authorization evaluator and scoped repositories. Task 4 implements membership workflows. Task 5 replaces mock APIs with protected endpoints and safe projections. Tasks 6 and 7 integrate session state and permission-driven UI. Task 8 makes admission numbers and employee codes server-assigned. Task 9 proves cross-school, cross-person, field, export, concurrency and revocation boundaries against the running stack.
