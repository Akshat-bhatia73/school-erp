# Authorization and access scope

Task 3 adds `packages/authz`: the policy service that decides what a signed-in member of a school may read or write. It implements the `AuthorizationService` interface from [the contract handover](./CONTRACTS.md) against the Task 1 database, using the permission catalogue, the fixed role templates and the resource access rules described in [the permission matrix](./PERMISSION_MATRIX.md). It is defined in [the implementation plan](../AUTH_RBAC_IMPLEMENTATION_PLAN.md) (sections 6 and 9, and the Task 3 checklist).

It does not authenticate anyone. Sessions, assurance and membership resolution are Task 2, described in [authentication and sessions](./AUTHENTICATION.md). It also does not shape responses: field groups say which groups of fields a permission covers, but the projection that drops the rest is Task 5, now implemented in `apps/api/src/modules`; see [protected school APIs](./PROTECTED_APIS.md). Invitations, role assignment endpoints and ownership transfer are Task 4 and are now implemented; see [access management](./ACCESS_MANAGEMENT.md). The web integration is Tasks 6 to 8. The only endpoint wired to it today is `GET /api/schools/:schoolId/context`, whose `capabilities` list is now `capabilities(context)`: the set of permissions the member could exercise somewhere in the school, decided by the policy service rather than by a role template union.

Source files: [src/policy.ts](../../packages/authz/src/policy.ts), [src/snapshot.ts](../../packages/authz/src/snapshot.ts), [src/scope.ts](../../packages/authz/src/scope.ts), [src/service.ts](../../packages/authz/src/service.ts), [src/delegation.ts](../../packages/authz/src/delegation.ts), [src/versioning.ts](../../packages/authz/src/versioning.ts), [src/errors.ts](../../packages/authz/src/errors.ts).

## What the package gives a caller

```ts
import { createAuthorizationService } from '@erp/authz'

const authz = createAuthorizationService({ pool: pools.runtime })

await authz.authorize(context, 'students.read_basic', { schoolId, resourceType: 'student', id })
await authz.allowedActions(context, { schoolId, resourceType: 'student', id: studentId })
await authz.capabilities(context)
await authz.scopeQuery(context, 'students.read_basic', 'student')
await authz.explainAccess(viewer, targetMembershipId, 'students.read_medical', resource)
```

`context` is the server `RequestContext` built in `apps/api/src/auth/request-context.ts`. It is the only thing the service trusts about the caller, and it can only exist after a session and an active membership have been verified.

Every method opens one `withTenantTransaction` on the runtime pool, so all reads run as `erp_runtime` under forced row level security with the school set for the transaction. Loaders still add an explicit `school_id = $1` predicate to every statement; that is a second barrier, not the only one. Library code never uses the migrator or identity credentials, and never calls `Date.now()`: the clock comes from `context.now`.

`allowedActions` answers for one record: every active permission of that record's resource type the caller may use on it. `capabilities` answers for the whole school: every active permission the caller could exercise on some record in it. Each permission is decided against an aggregate resource standing for the whole school dataset, so a relationship scope answers when the caller has that relationship at all, and every other invariant still applies. A school wide deny exception removes the permission from the list, and a single factor session whose role requires two step verification is refused outright rather than handed an empty list.

`authorize` returns an `AuthorizationDecision`, never throws for a denial, and answers `{ allowed: false, code: 'ACCESS_DENIED' }` when the membership is suspended or gone. `allowedActions`, `capabilities`, `scopeQuery` and `explainAccess` throw `AuthorizationError` instead, because there is no partial answer they could give. `AuthorizationError` carries one of the contract `ErrorCode` values, so the HTTP boundary maps it without inventing text. Its messages are plain English and never contain another person's id or the reason text of a rule.

## Decision order

`evaluate` in `src/policy.ts` is pure: no database, no clock, no randomness. The service loads the four inputs (policy snapshot, relationship facts, resource facts and the context) and hands them over. The first failing step wins and the default is deny.

1. The permission must be a known `PermissionKey` and its catalogue availability must be `active`. A reserved permission such as a fees or attendance key denies with `ACCESS_DENIED`.
2. A student membership, or a context carrying the `student` role, denies with `FEATURE_DISABLED`. Student logins do not exist.
3. The resource must be in `context.schoolId` and its `resourceType` must be the one the catalogue records for the permission, and the resource facts must have loaded. Anything else is `RESOURCE_NOT_FOUND`. A record that exists in another school is reported exactly like a record that does not exist.
4. `snapshot.accessVersion` must equal `context.accessVersion`. A mismatch is `ACCESS_DENIED`: the caller's context predates a role or rule change and has to be resolved again.
5. Role level authentication strength. If any role in the context has `requiredMfa` (owner, principal, administrator, accountant) and `context.assurance` is not `mfa`, the answer is `MFA_REQUIRED`, whatever the action was.
6. Role grants. The grants for this permission are filtered by their scope predicate. Scopes are independent and are never ranked against each other.
7. Exceptions. `resource_access_rules` rows for this membership and school that name this permission, are not revoked, have started, have not expired, and whose target matches the resource.
8. Any applicable deny wins. A school wide deny overrides a narrow allow and every role grant.
9. If no grant and no allow matched, deny.
10. Action level authentication strength. When the session is single factor and every matched grant or allow sits in the permission's `privilegedScopes`, the answer is `MFA_REQUIRED`. One non privileged match is enough to allow. An exception never lowers the requirement: a school target counts as the `school` scope and a section target as `assigned_sections`.
11. Field groups. A `requestedFieldGroups` entry outside `fieldGroupsFor(permission)` denies. Otherwise the decision is `{ allowed: true, fieldGroups, accessVersion }`.

## Scope predicates

| Scope | Matches when |
|---|---|
| `school` | Always. School equality was already checked in step 3. |
| `self` | The resource carries a `staffId` equal to the caller's own staff record. |
| `assigned_sections` | The caller has a teaching assignment effective now whose section and academic year both match the resource, or is the class teacher of that section in a year that is not closed. The class teacher post names no subject, so it never counts for `assigned_subjects`. |
| `assigned_subjects` | The same assignment also matches one of the resource's subjects. |
| `own_children` | The resource's `studentId` is one of the caller's approved children. |
| `own_record` | Never. Student login is disabled. |
| `finance` | On every resource except `audit_event`, always at row level: the narrowing is done by field groups, not by rows. On `audit_event` the term is `action IN (FINANCE_AUDIT_ACTIONS)`, so a finance reader lists, counts and exports only the money actions declared in `@erp/contracts`. |

Section and year always travel together. An assignment to section 6A in the previous academic year does not open 6A in the current year. Children come from `membership_guardian_links` joined to `guardian_student_access` with status `approved` and no `revoked_at`; `receives_notifications` and a plain `student_guardians` row are contact details, not access.

Resources that summarise a whole dataset rather than one row, such as the dashboard or the resource `capabilities` asks about, are marked `aggregate`. For those, `assigned_sections` matches when the caller has any assignment or is the class teacher of any open section, `own_children` when the caller has any child, and `self` when the caller has a staff record of their own. Shared rows such as a section or a grade answer `own_children` through a current enrollment of one of the caller's own children, so a list and a detail read agree.

Relationship facts are loaded once per request in `src/snapshot.ts`: the staff link, the teaching assignments effective at `context.now`, and the approved children. `loadResourceFacts` maps each resource type to the attributes the predicates need, and returns null for reserved types such as fees, attendance and exams.

## Exception semantics

An exception is a `ResourceAccessRule` for one membership. Rows are validated with the contract schema as they are read; a row that does not parse is dropped from the allow set, so a malformed rule can never widen access.

- Effect `deny` beats everything, including a role grant and a broader allow.
- Effect `allow` adds access that no role gives, inside its target: the whole school, one section and year, one student, one staff member, or one document.
- `valid_from`, `expires_at` and `revoked_at` are compared against `context.now`. A future, expired or revoked rule does nothing.
- A rule belonging to another school or another membership is ignored, even if it is somehow present in the snapshot.
- An allow never satisfies the MFA requirement of a privileged scope, and never crosses the school boundary.

## Field groups

`fieldGroupsFor(permission)` is a fixed map, exported and used by both the decision and the caller. Reads of student data return `student_basic`, `student_sensitive`, `student_medical`, `guardian_contact`, `guardian_private` or `document_metadata`; staff reads return `staff_directory`, `staff_employment`, `staff_private` or `staff_pay`; `timetable.read` returns `timetable`, `audit.read` returns `audit_summary`, and the setup reads (school, academic years, grades, sections, subjects, holidays) return `setup`. Every write permission returns an empty list. A successful decision carries the groups the caller may project; Task 5 does the projection in `apps/api/src/modules` and must not widen it; see [protected school APIs](./PROTECTED_APIS.md).

## Plans and predicates for lists

A list must never answer what a single read would refuse. `scopeQuery` runs steps 1 to 5 of the same order, then builds an `AuthorizedReadPlan`:

```ts
const plan = await authz.scopeQuery(context, 'students.read_basic', 'student')
const table = scopedTableFor('student')
await withTenantTransaction(pool, context, async (conn) => {
  const page = await scopedList(conn, plan, table!, { page: 1, pageSize: 50 })
  const one = await scopedGet(conn, plan, table!, studentId)
})
```

The plan object itself is frozen and carries only the school, the membership, the permission, the resource type and the access version. The matched scopes, applicable rules, assigned section and year pairs, subject ids, child ids and staff id live in a module private `WeakMap` keyed by the plan. A caller can neither read them nor forge a plan: `planPredicate` on an object the authorizer did not issue throws `ACCESS_DENIED`.

`planPredicate` returns a Drizzle `SQL` boolean that always starts with `school_id = $1` and then ORs one term per matched scope and per applicable allow, and ANDs `NOT (...)` for every applicable deny. Nothing matched means `FALSE`, not an open query. Ids are always bound as parameters and cast with `::uuid`; no id is ever interpolated into SQL text. Predicates exist for `student`, `staff`, `section`, `enrollment`, `student_document`, `subject`, `grade`, `academic_year`, `holiday` and `guardian`, and `scopedTableFor` returns the column descriptor for each.

Action level MFA works differently for a plan than for a single read. A single factor session does not lose the whole list: the privileged scopes are dropped from the plan, and only when that leaves nothing does `scopeQuery` throw `MFA_REQUIRED`. `scopedList` orders by id and reports `total` with a `count(*)` over the same predicate, so paging is stable and the total matches the rows collected across pages. `scopedGet` applies the identical predicate, so a row missing from a list cannot be fetched by id.

## The version and locking protocol

Anything that changes what a membership can do (roles, access rules, status) must use `src/versioning.ts`, in this order and inside one transaction:

1. `lockMembershipForAccessChange(conn, schoolId, membershipId, expectedVersion)` takes `FOR UPDATE` on the membership row. A missing row throws `RESOURCE_NOT_FOUND`; a version that does not match what the caller read throws `VERSION_CONFLICT`. A second writer blocks here.
2. Apply the change.
3. `commitAccessChange(conn, schoolId, membershipId, expectedVersion)` bumps `version` and `access_version` together and touches `updated_at`. Zero rows updated means another writer got in first, so it throws `VERSION_CONFLICT`.

Writers of sensitive data call `assertAccessVersionCurrent(conn, context)` inside their own committing transaction. It re-reads the membership `FOR SHARE`, throws `ACCESS_DENIED` when the membership is no longer active and `VERSION_CONFLICT` when `access_version` has moved on. Because the access change holds `FOR UPDATE`, a request that started before it either waits or is rejected as stale. Once `access_version` changes, every context issued earlier fails step 4 of the decision order and the caller has to fetch school context again.

Ownership transfer and role escalation need more than a version check: `isFreshMfa` in [apps/api/src/auth/assurance.ts](../../apps/api/src/auth/assurance.ts) is the shared five minute freshness check that already guards `two-factor/disable`, and those flows reuse it before `mayTransferOwnership` is consulted. Task 4 implements them in `apps/api/src/memberships`; see [access management](./ACCESS_MANAGEMENT.md).

## Delegation rules

`src/delegation.ts` is pure and the service does not call it. The Task 4 workflows check it in addition to the `roles.assign` and `members.*` permissions; see [access management](./ACCESS_MANAGEMENT.md).

- `assignableRolesFor(actorRoleKeys)` is the union of `ROLE_DELEGATION_RULES` over the actor's roles.
- `checkRoleAssignment` refuses a member changing their own roles, refuses any proposal where the owner or student role appears in the proposal or in the target's current roles, refuses a target holding a role the actor cannot manage, and refuses any proposed or changed role outside the actor's assignable set. So a principal may add and remove teacher, but cannot touch a member who is also an owner.
- `checkMembershipLifecycle` covers suspend, remove and restore with the same self and manageability checks. An owner target is always refused; ownership only moves through the transfer workflow.
- `mayTransferOwnership(actorRoleKeys)` is true for an owner only.

Denials are one of `SELF_CHANGE`, `NOT_DELEGABLE`, `OWNER_OR_STUDENT_ROLE`, `TARGET_NOT_MANAGEABLE` or `NO_AUTHORITY`, for the caller to map onto a message.

## Explaining a decision

`explainAccess(viewer, targetMembershipId, permission, resource)` first checks that the viewer holds `access.explain` on the `access_decision` resource for that membership, and throws with that code when they do not. It then builds a synthetic context for the target membership, with the target's roles, kind and access version, assurance `mfa` and the viewer's clock, and returns `explain(...)` for it. The synthetic context is never used to serve data.

An explanation lists the invariant that failed, each matched role grant with its permission and scope, each relationship that was used, and each matched exception with its effect and target kind. It never carries the reason text of a rule or the id of another person.

## Run the tests

The package tests need the same local PostgreSQL database as `packages/db` and `apps/api`.

```sh
docker compose -f compose.db.yml up -d --wait
MIGRATION_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp pnpm db:migrate

pnpm --filter @erp/authz typecheck
TEST_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp_test pnpm db:test:prepare
TEST_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp_test pnpm test:authz
```

`TEST_DATABASE_URL` is the migrator URL, and it must name a disposable database such as `erp_test`; `erp` is the development database, reserved for `pnpm dev:api`, `pnpm db:fixtures` and `dev:logins`. `pnpm db:test:prepare` creates and migrates the named database. `tests/harness.ts` uses it to seed the `@erp/db` fixtures and to insert the extra rows the fixtures do not contain (enrollments, subjects, teaching assignments, staff and memberships), and derives the runtime URL from it by swapping the login, so the service under test always connects as `erp_runtime`. Extra rows use fresh UUIDs, so a repeated run does not collide. Files run one at a time because they share the database.

## What the tests prove

50 tests across five files: 13 in `policy.test.ts`, 10 in `delegation.test.ts`, 13 in `service.test.ts`, 10 in `scope.test.ts` and 4 in `versioning.test.ts`.

`policy.test.ts` is pure. It walks every role template against every active permission, with facts where the member is related through each relationship and where it is unrelated, and asserts that the answer is allowed exactly when a grant's scope predicate holds. It also covers the MFA rules in both directions (a teacher keeps single factor for the self scope but not for a privileged school scope), the invariants (reserved permission, student kind, wrong school, missing resource, stale version), the teacher and parent union (6A students and one's own child, but not other students in the child's section and not the child's sensitive or medical fields), the exception cases (current, expired, revoked, future, school deny beating a section allow, a section target for the wrong year, an allow that cannot bypass MFA or cross a school), the field group checks, and the shape of an explanation.

`delegation.test.ts` is pure and covers the assignment and lifecycle rules above.

`service.test.ts` runs against the database and fixtures: an owner reads a student with MFA and is refused without it, a school B resource is not found for a school A owner whichever school id is supplied, the teacher and parent member reads its own child and a student in its assigned section but not an unrelated student, the fixture school wide allow widens the basic read and an expired one does not, a suspended membership has no access, a student membership is a disabled feature, a stale access version is refused, `allowedActions` for a parent on its own child lists the basic and guardian contact reads and neither the sensitive read nor a basic update, `capabilities` gives an owner the medical read and the invite permission, refuses a single factor owner with `MFA_REQUIRED`, gives the teacher and parent member the basic student read, its own employment record and the timetable but not pay or medical notes, and gives a parent with a guardian link but no approved child nothing, and `explainAccess` needs the explain permission first.

`scope.test.ts` compares lists with single reads: for each caller the set returned by `scopedList` equals the set `authorize` allows one by one, and no row of the other school ever appears. It does that for students, for staff (the school scope, the self scope of the teacher and parent member, and a teacher with no staff record at all, whose plan is still issued and selects nothing), for sections (the section a member teaches plus the section its own child is enrolled in, and for a parent only its child's section), for subjects (only the assigned subject for the teacher, and the subject its child's class studies for the parent), for enrollments and for documents (where a parent has no grant, so no plan exists). It also proves that a deny exception removes the row from the list and from the detail read alike, that a plan for one school never returns a school B row even when its id is passed to `scopedGet`, that the total matches the rows collected across pages, and that a plan is refused for the same reasons a single read is.

`scope.test.ts` also proves the finance audit narrowing: a finance scoped plan lists only rows whose action is in `FINANCE_AUDIT_ACTIONS`, refuses the other rows one by one through `scopedGet`, and a school scoped plan reads the whole trail. The single-event decision agrees with the list: `ResourceFacts` for an `audit_event` carries the row's action, and `matchesScope` at the finance scope accepts only a finance action, so `authorize` and `explainAccess` on one audit row answer exactly what the plan would select.

`versioning.test.ts` proves the locking protocol: two access changes on the same membership serialise, a stale expected version conflicts, and a context issued before the commit fails the access version check afterwards.

## Known gaps

- Reserved resource types (fees, attendance, exams, messages) have no resource facts and no predicates. They deny today and need loaders when those modules land.
- `planPredicate` covers ten listable resource types, and the tests exercise six of them against single reads. Memberships, invitations, audit events and timetable entries are read one at a time or not at all so far.
- Nothing caches. Every call reloads the snapshot, the relationship facts and the resource facts inside its own transaction. That is deliberate for now: correctness first, and `access_version` gives a later cache a safe key.
- Field group projection is not implemented here. A caller that ignores the returned `fieldGroups` still sees whole rows, which is why Task 5 owns every response shape.
- Ownership transfer, invitations and the role assignment endpoints live in `apps/api`, not here. They use the delegation rules, the locking protocol and `isFreshMfa`; see [access management](./ACCESS_MANAGEMENT.md).
- `capabilities` is a school level navigation hint in the API today. It says a permission is usable somewhere in the school, not on any particular record, so a screen still has to call `authorize` or `scopeQuery` before it shows data. Per record capability lists for a detail screen are a Task 5 decision.
