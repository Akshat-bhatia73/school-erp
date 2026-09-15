# Access management: members, invitations and ownership

Task 4 adds `apps/api/src/memberships` and `apps/api/src/invitations`: the workflows that change who belongs to a school and what they may do. It joins the Task 2 session service to the Task 3 policy service, so every write is decided by [the policy service](./AUTHORIZATION.md), delegated according to the delegation rules, and recorded in the audit log. The endpoints and their bodies are the `ACCESS_ENDPOINTS` entries in [the contract handover](./CONTRACTS.md). It is defined in [the implementation plan](../AUTH_RBAC_IMPLEMENTATION_PLAN.md) (sections 7 and 8, and the Task 4 checklist).

Source files: [memberships/routes.ts](../../apps/api/src/memberships/routes.ts), [memberships/authorize.ts](../../apps/api/src/memberships/authorize.ts), [memberships/audit.ts](../../apps/api/src/memberships/audit.ts), [memberships/directory.ts](../../apps/api/src/memberships/directory.ts), [memberships/lifecycle.ts](../../apps/api/src/memberships/lifecycle.ts), [memberships/roles.ts](../../apps/api/src/memberships/roles.ts), [memberships/ownership.ts](../../apps/api/src/memberships/ownership.ts), [memberships/recovery.ts](../../apps/api/src/memberships/recovery.ts), [invitations/routes.ts](../../apps/api/src/invitations/routes.ts), [invitations/service.ts](../../apps/api/src/invitations/service.ts), [invitations/tokens.ts](../../apps/api/src/invitations/tokens.ts).

## Scope

In scope: the member directory, invitations and their acceptance, role changes, suspend, remove and restore, ownership transfer, administrator started credential recovery, and the access explanation endpoint.

Out of scope, deliberately. There is no web UI: no screen calls these routes and the web app still runs on its mock API, which is Tasks 6 to 8. There is no real message delivery: an invitation is handed to the sandbox adapter described in [authentication and sessions](./AUTHENTICATION.md), and `DELIVERY_MODE=provider` still refuses to start. There are no custom roles: the assignable set is the fixed role templates from `@erp/contracts`, role rows are looked up by key inside the school, and nothing here creates a role. Field level projection of responses is still Task 5.

## Endpoints

Every route runs `requireMembership`, so a session, an active membership in the path school and the role level MFA rule are already satisfied before the handler starts. Bodies are `z.strictObject` contracts, so an unknown key is rejected. Errors are the `ApiError` envelope with a fixed message.

| Method and path | Permission | Extra checks | Success | Error codes |
|---|---|---|---|---|
| `GET /api/schools/:schoolId/members` | `members.read` | Page request bounds | 200 | `INVALID_REQUEST`, `ACCESS_DENIED`, `AUTHENTICATION_REQUIRED` |
| `GET /api/schools/:schoolId/members/:membershipId/access-explanation` | `access.explain` | Checked inside `explainAccess` | 200 | `INVALID_REQUEST`, `ACCESS_DENIED`, `RESOURCE_NOT_FOUND` |
| `POST /api/schools/:schoolId/invitations` | `members.invite` and `roles.assign` | Delegable roles, fresh MFA for a privileged role, free staff record, no existing membership, no pending invitation | 201 | `INVALID_REQUEST`, `ACCESS_DENIED`, `FRESH_AUTHENTICATION_REQUIRED`, `RESOURCE_NOT_FOUND`, `IDENTITY_LINK_CONFLICT`, `INVITATION_UNAVAILABLE` |
| `POST /api/schools/:schoolId/invitations/:invitationId/resend` | `members.invite` and `roles.assign` | Row still pending, `expectedVersion`, delegable roles, fresh MFA | 200 | `INVALID_REQUEST`, `ACCESS_DENIED`, `FRESH_AUTHENTICATION_REQUIRED`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT`, `INVITATION_UNAVAILABLE` |
| `POST /api/schools/:schoolId/invitations/:invitationId/revoke` | `members.invite` | Row still pending, `expectedVersion` | 200 | `INVALID_REQUEST`, `ACCESS_DENIED`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT`, `INVITATION_UNAVAILABLE` |
| `POST /api/invitations/accept` | None; a verified session only | Token digest, identity match, inviter still has authority, no existing membership | 200 | `INVALID_REQUEST`, `AUTHENTICATION_REQUIRED`, `INVITATION_UNAVAILABLE`, `IDENTITY_LINK_CONFLICT` |
| `PUT /api/schools/:schoolId/members/:membershipId/roles` | `roles.assign` | `checkRoleAssignment`, fresh MFA for an added privileged role, target active, `expectedVersion`, owner survives | 200 | `INVALID_REQUEST`, `ACCESS_DENIED`, `FRESH_AUTHENTICATION_REQUIRED`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT`, `LAST_OWNER_PROTECTED` |
| `POST /api/schools/:schoolId/members/:membershipId/suspend` | `members.suspend` | `checkMembershipLifecycle`, allowed transition, `expectedVersion`, owner survives | 200 | `INVALID_REQUEST`, `ACCESS_DENIED`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT`, `LAST_OWNER_PROTECTED` |
| `POST /api/schools/:schoolId/members/:membershipId/remove` | `members.remove` | The same, plus every exception of that membership is revoked | 200 | The same as suspend |
| `POST /api/schools/:schoolId/members/:membershipId/restore` | `members.restore` and `roles.assign` | The same, plus `checkRoleAssignment` and fresh MFA on the reviewed role set | 200 | The same as suspend, plus `FRESH_AUTHENTICATION_REQUIRED` |
| `POST /api/schools/:schoolId/ownership/transfer` | `ownership.transfer` | `mayTransferOwnership`, fresh MFA, candidate has a second factor, `expectedSchoolAccessVersion` | 200 | `INVALID_REQUEST`, `ACCESS_DENIED`, `FRESH_AUTHENTICATION_REQUIRED`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT`, `LAST_OWNER_PROTECTED` |
| `POST /api/schools/:schoolId/members/:membershipId/recovery` | `members.manage_credentials` | `checkMembershipLifecycle`, target active, `expectedVersion` | 202 | `INVALID_REQUEST`, `ACCESS_DENIED`, `RESOURCE_NOT_FOUND`, `VERSION_CONFLICT`, `FEATURE_DISABLED`, `SERVICE_UNAVAILABLE` |

`authorizeSchoolAction` and `authorizeOnMembership` in `memberships/authorize.ts` are the only place a route asks whether the caller may act. They load the snapshot, the relationship facts and the resource facts and call the shared `evaluate`. No route writes a role check of its own. A suspended or removed actor membership is refused as `ACCESS_DENIED` before anything else.

The directory lists memberships in creation order with a `count(*)` total. A membership with no roles is dropped from the list, because it grants nothing. Display names come from the school's own staff or guardian record first, and only fall back to `auth_user.name` through the auth pool, which may not read a tenant table.

## The invitation lifecycle

An invitation row moves through `pending`, then one of `accepted`, `revoked` or `expired`. Creating one takes `members.invite` and `roles.assign`, and every proposed role must be in `assignableRolesFor` for the actor's roles. A partial unique index keeps one pending invitation per school and normalised identifier; a racing duplicate is answered `INVITATION_UNAVAILABLE`. Resending mints a new token, which silently kills the old one, and extends the expiry. Revoking closes the row. A pending row past its expiry is reported as `expired` in responses without a write, and is written as `expired` the moment somebody tries to use it.

The token is `<schoolId>.<32 random bytes, base64url>`. The school id prefix is routing information only: the accept request has no school in the path, and the tenant transaction needs a school before row level security lets it read anything. It proves nothing, because the row is always found by the SHA-256 digest of the secret half. Only that digest is stored in `school_invitations.token_digest`. The raw token exists in memory in the request that created it and is passed to the delivery adapter and nowhere else. It is in no response body, no audit row and no log line, and the request logger redacts `req.body.token` and disables request body logging.

Invitations live 48 hours (`INVITATION_TTL_HOURS`). The masked destination stored on the row and returned in the summary is `f***@example.com` or `+91******21`, enough to recognise your own address and not enough to learn somebody else's.

Delivery is queued, not synchronous. The write transaction inserts a `delivery_outbox` row with the masked destination and commits; only then does the process call the adapter and flip that row to `sent` or `failed` in a second, short transaction. So a delivery failure never rolls back an invitation that already exists, and the `deliveryStatus` on the response tells the caller what actually happened. In sandbox mode the adapter keeps the message in memory and logs a line that says nothing was sent, so the only way to read an invitation token is the in-memory outbox in a test.

## Identity binding on acceptance

Accepting requires the invitee's own session. The link alone is never enough. The signed-in identity must be the one the invitation was addressed to: for an email invitation the session's email must equal the normalised identifier and must not be a generated `.invalid` address, and for a phone invitation the number must match and `phone_number_verified` must be true. A mismatch answers `INVITATION_UNAVAILABLE`, the same code as a revoked or expired token, so no answer says which half did not match.

Because an invitee may never have signed in here, the invite step provisions the login. `findOrProvisionUser` looks for an existing `auth_user` by lowercased email or by phone number, and creates one through `src/identity/provision.ts` when there is none. An email identity is created with a random password nobody ever learns: the person proves control of the mailbox through the ordinary password reset flow, which is also why control of the credential, rather than a verification flag, is what acceptance treats as proof. A phone identity is created with no credential at all, and its number counts as verified, which makes it eligible for OTP sign-in. That is a global side effect, so it only happens after the caller's authority has been settled: a first read-only tenant transaction runs the permission, delegation, fresh MFA, staff and duplicate checks, then the login is provisioned, then the write transaction repeats those checks before inserting the row. A member without invite authority therefore cannot cause a login to exist. Provisioning still happens before the write transaction, so a failure later leaves a login with no membership. It can enter no school, so it is harmless, and the next invitation reuses it.

Acceptance then creates the membership, inserts one `membership_roles` row per proposed role key, links the staff record when the invitation named one, marks the invitation `accepted`, and returns the new `MemberSummary`. If the inviter's membership is no longer active, or its roles no longer delegate what the invitation proposes, the invitation is revoked inside the same transaction with a denied audit row and the caller is answered `INVITATION_UNAVAILABLE`. Two concurrent accepts lose the `(school_id, user_id)` uniqueness check and the loser gets `IDENTITY_LINK_CONFLICT`.

## The write protocol

Every workflow that changes a membership follows the same order inside one `withTenantTransaction` on the runtime pool.

1. `lockSchool` takes `FOR UPDATE` on the `schools` row, so two access changes in one school serialise instead of racing the owner check.
2. Authorize through the policy service, with `authorizeOnMembership` for a named target and `authorizeSchoolAction` for a school wide action.
3. Check delegation: `checkRoleAssignment`, `checkMembershipLifecycle`, `assignableRolesFor` or `mayTransferOwnership`. A permission says the action exists for this caller; delegation says this target is theirs to touch.
4. Assert fresh MFA when the change hands out a privileged role or moves ownership. `isFreshMfa` is the same five minute check that guards `two-factor/disable`; see [authentication and sessions](./AUTHENTICATION.md). A role the target already holds is not re-granted and does not ask for a new proof.
5. `lockMembershipForAccessChange` with the caller's `expectedVersion`, apply the change, `assertSchoolKeepsOwner`, then `commitAccessChange`, which bumps `version` and `access_version` together. See the locking protocol in [authorization and access scope](./AUTHORIZATION.md).
6. `recordAuditEvent` in the same transaction, exactly one row per committed change. The summary is plain English and `safe_changes` carries ids, role keys, statuses and the caller's reason, never a name, address, phone number or token.
7. Re-read the row and return a `MemberSummary` parsed against the contract, so the answer always describes committed state.

`assertSchoolKeepsOwner` counts active memberships holding the `owner` role and fails the whole transaction with `LAST_OWNER_PROTECTED` when the count is zero. A school with no active owner has nobody who can restore access, so it is never allowed to exist.

## Ownership transfer

Only an owner may transfer, and only to an active adult membership that is not already an owner and is not the caller. The candidate's `auth_user` is read through the auth pool and must have `two_factor_enabled`, because an owner is always an MFA identity. The caller must have proven the second factor in the last five minutes.

The whole workflow is one optimistic unit against the school row: the caller states `expectedSchoolAccessVersion`, `lockSchool` compares it, and a second transfer that started from the same version loses with `VERSION_CONFLICT`. Both membership rows are locked in ascending id order, so two transfers in one school cannot deadlock. The owner role is inserted on the target and deleted from the actor, `schools.access_version` is bumped, both memberships are committed through `commitAccessChange`, and the owner assertion runs before the audit row.

The demotion rule: the outgoing owner stays in the school. A membership with no roles grants nothing and would vanish from the directory, so when ownership was their only role they are given `principal` instead of being left blank. An owner who already held another role keeps exactly what remains.

## Suspension, removal and restore

The transitions come from the server side `MEMBERSHIP_TRANSITIONS` table, never from the request body. An owner target is always refused by `checkMembershipLifecycle`; ownership only moves through the transfer workflow. Nobody may act on their own membership.

Suspending sets the status and bumps the access version. Every context issued earlier fails the access version check, and `requireMembership` re-reads the membership on the next request, so the person loses that school immediately and keeps their other schools.

Removing does the same and additionally revokes every `resource_access_rules` row of that membership, because an exception is a grant on top of a membership and ends with it. Removal deletes nothing: the membership row, its staff link, its role history and its audit events all survive, because the record of who had access has to outlive the person leaving.

Restoring is the only lifecycle event that also states a role set, so it needs `roles.assign` as well and runs the full assignment check on the reviewed roles. It deliberately does not bring back expired or revoked exceptions. A reviewed return of access is the role set, not the old exceptions.

## Recovery and explanation

`POST .../recovery` lets an administrator start credential recovery for another member without ever seeing or using the result. The target must be active and pass the same lifecycle check, and the caller states the target's `expectedVersion`, which is only compared and never bumped, because recovery changes no grant. The channel is chosen server side: a real email address wins, a phone number is the fallback, and an identity with neither is answered `FEATURE_DISABLED`. The decision is audited inside the tenant transaction, then the provider is asked to send a reset. A provider failure writes a second `failed` audit row and answers `SERVICE_UNAVAILABLE`. The response is always `202 {"status":"queued"}` and says nothing about the destination.

`GET .../access-explanation` answers, for one target membership and one permission and resource, why the answer would be what it is. The route does no check of its own: `explainAccess` verifies the viewer holds `access.explain` for that membership first and throws otherwise, because a second copy of the rule here would be a second thing to keep correct. The response is parsed through `AccessExplanation`, which carries the failing invariant, the matched grants and the matched exceptions, and never another person's id or the reason text of a rule.

## Run the tests

The API tests need the same local PostgreSQL database as `packages/db`.

```sh
docker compose -f compose.db.yml up -d --wait
MIGRATION_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp pnpm db:migrate

pnpm --filter @erp/api typecheck
pnpm test:api
```

`tests/harness.ts` starts the app on a reserved local port, seeds the `@erp/db` fixtures, and gives each test its own cookie jar and an in-memory delivery outbox. Files run one at a time because they share the database. There is no mocked database, provider or policy service.

## What the tests prove

The suite is 89 tests across nine files. Task 4 adds 35 of them: 14 in `invitations.test.ts`, 9 in `membership-lifecycle.test.ts`, 6 in `members.test.ts` and 6 in `ownership.test.ts`. The other five files are the Task 2 authentication tests (11 mfa, 5 password-reset, 11 phone-otp, 11 scaffold, 16 session).

`invitations.test.ts`: an owner invites a teacher by email and a parent by phone, the invitee accepts once and becomes a member, two concurrent accepts create exactly one membership, a different signed-in person cannot use the token, a revoked invitation cannot be accepted, an expired one is written as expired when it is used, resending replaces the token so the old one stops working, an invitation dies with the authority behind it, a principal cannot invite an accountant, a stale second factor cannot grant a privileged role, an invitation whose details do not add up is refused, a teacher's invite attempt is refused before any login is created, and an anonymous caller cannot accept.

`membership-lifecycle.test.ts`: an owner reviews the roles of a teacher, a stale expected version changes nothing, ownership cannot be granted through the roles endpoint, a principal may only assign what it may delegate, granting a privileged role needs a recent second factor, a suspended member loses the school on its very next request, removal ends one school only and keeps the exception history, nobody suspends themselves and no outsider reaches this school, and an owner queues credential recovery for a member only.

`members.test.ts`: an owner reads the directory, the page size is honoured and an invalid one refused, a member of one school cannot read another school's directory, a parent has no permission to read it, an anonymous caller is told nothing, and an owner can explain another membership's access decision.

`ownership.test.ts`: a transfer must state the school access version it read, an owner is always an identity with a second factor, a transfer asks for the second factor again, only an owner may transfer, two transfers from the same version leave exactly one owner, and an owner hands the school to a verified candidate.

## Known gaps

- Email verification is inferred, not recorded. Acceptance treats control of the credential as proof of the address, because the provisioned password is random and only a mailbox can complete a reset. There is no verified-at column and no verification email of our own.
- No real delivery. Sandbox is the only supported mode, so an invitation link is readable only from the in-memory outbox. Provider failure handling, retries and a real outbox worker are later work.
- A phone-only invitee still gets a login with no password, so they sign in by OTP and cannot enrol in two factor, which keeps them out of any privileged role. The same limitation is described in [authentication and sessions](./AUTHENTICATION.md).
- Recovery of an identity with neither a real email nor a phone number answers `FEATURE_DISABLED`. There is no other channel.
- No expiry sweeper. A pending invitation is only written as `expired` when somebody tries to use it, so a stale row can sit in the table indefinitely.
- No endpoint exposes `schools.access_version`, so a caller of ownership transfer has to learn `expectedSchoolAccessVersion` some other way. The transfer screen in Task 6 needs it.
- No UI. Nothing in `apps/web` calls any of these routes yet.
- `apps/api` has no lint script, so the repo wide `pnpm -r lint` does not reach this source.
