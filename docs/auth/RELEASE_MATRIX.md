# Release matrix

Every scenario in section 13 of `docs/AUTH_RBAC_IMPLEMENTATION_PLAN.md`, with the test that proves it.

- **covered elsewhere** — an existing suite already proves the row; it is cited, not duplicated.
- **new here** — the row is proved by `tests/security/*.test.ts`, the adversarial acceptance suite.
- **not applicable** — the thing the row describes does not exist in this build; the reason and the compensating control are stated.

Run the new suite with:

```
TEST_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp_sec pnpm test:security
```

It reuses the API harness (`apps/api/tests/harness.ts`), seeds the shared fixtures, creates its own members, sections, students and staff per run, and is idempotent on a reused database. Every test name begins with its matrix id. Each one includes at least one permitted request, so a server that denied everything would fail the suite.

## The matrix

| id | Scenario | Status | Test |
|---|---|---|---|
| anon-every-endpoint | Anonymous request to every business endpoint | new here | `tests/security/tenant-isolation.test.ts` — `[anon-every-endpoint] every registered school route refuses an anonymous caller` (sweeps the Fastify route table, so a new route is covered as soon as it is registered) |
| client-identity-tampering | Change role/user/school values in localStorage or request bodies | new here | `tests/security/identity-tampering.test.ts` — `[client-identity-tampering] a query cannot name another membership or another role`, `… the context route reports the session identity, not the query`, `… an identity carried in a write body changes nothing`, `… a forged cookie value is not a session`, `… a header cannot promote a signed-in caller`. Browser side: `apps/web/src/lib/session.test.tsx` `ignores and removes the old localStorage identity keys` |
| cross-school-record | School A user requests School B record/list/export/file | new here (was covered) | `tests/security/tenant-isolation.test.ts` — `[cross-school-record] school B records, lists and exports are unreachable from school A`, `… a setup read of another school never crosses the boundary`. Also `apps/api/tests/modules-students.test.ts:234`, `packages/authz/tests/service.test.ts:90` |
| teacher-unrelated-student | Teacher opens unrelated student in the same school | covered elsewhere | `apps/api/tests/modules-students.test.ts:251` `a teacher reads the class she teaches and nothing beside it`; `packages/authz/tests/scope.test.ts:366` |
| teacher-staff-private-fields | Teacher reads staff/timetable/search joins | covered elsewhere | `apps/api/tests/modules-staff.test.ts:230/241/411`; `apps/api/tests/modules-timetable.test.ts:215`. Reinforced here by `tests/security/field-boundaries.test.ts` — `[per-action-separation] reading the staff directory never implies export or pay` |
| teacher-two-sections | Teacher with two section assignments | new here | `tests/security/relationship-scope.test.ts` — `[teacher-two-sections] the roster is the union of both classes and nothing else`, `… the section list matches the assignments` |
| teacher-also-parent | Teacher who is also a parent | new here | `tests/security/relationship-scope.test.ts` — `[teacher-also-parent] the union is one class plus one child, with no finance` (a purpose-built member, not the fixture combined member whose school-wide allow exception widens it) |
| parent-guesses-child | Parent changes child ID or guesses admission number | covered elsewhere | `apps/api/tests/modules-students.test.ts:276`; `apps/api/tests/modules-search.test.ts:285`; `apps/api/tests/modules-files.test.ts:215` |
| guardian-no-portal | Guardian's contact receives notifications but the portal link is absent or revoked | new here | `tests/security/relationship-scope.test.ts` — `[guardian-no-portal] a guardian contact with no membership has no way in`, `… revoking the portal grant closes the child on the same session` |
| student-login-endpoint | Future student login endpoint called now | covered elsewhere | `apps/api/tests/session.test.ts:164`; `apps/api/tests/phone-otp.test.ts:243`; `packages/authz/tests/service.test.ts:169` |
| student-policy-fixtures | Future student policy fixtures | new here | `tests/security/identity-tampering.test.ts` — `[student-policy-fixtures] the student template carries no finance or administrative key`, `… a student membership cannot even be created` (the database refuses a new student membership, so there is no HTTP surface left to test) |
| forbidden-fields-on-edit | Client adds salary, role IDs, school ID or relationship changes to a normal edit | covered elsewhere | `apps/api/tests/modules-staff.test.ts:250/315/354`; `apps/api/tests/modules-students.test.ts:370/649`; `apps/api/tests/modules-setup.test.ts:280/336/602/627/651`. Identity fields specifically: `tests/security/identity-tampering.test.ts` `[client-identity-tampering] an identity carried in a write body changes nothing` |
| hidden-field-query | Query sorts, filters or counts on a hidden field | new here | `tests/security/field-boundaries.test.ts` — `[hidden-field-query] a sort or filter cannot name a field the caller may not read`, `… free text never matches on a hidden value, and the count agrees` (the medical note, guardian phone and salary are written by the suite with unique strings and then hunted for) |
| bulk-mixed-ids | Bulk request mixes permitted and forbidden IDs | covered elsewhere | `apps/api/tests/modules-students-bulk.test.ts:740/624/830`; `apps/api/tests/modules-staff.test.ts:517`; `apps/api/tests/modules-setup.test.ts:460` |
| clerk-delegation-limits | Clerk assigns owner/accountant, edits a privileged role or resets a privileged identity | new here | `tests/security/lifecycle-and-concurrency.test.ts` — `[clerk-delegation-limits] an administrator may manage a teacher but not a privileged member`, `… an administrator cannot start recovery for a privileged member`. There is no `clerk` role key in this build; `admin` is the least-authority office role and carries the row |
| missing-teacher-role-setup | Missing teacher role in setup | new here | `tests/security/lifecycle-and-concurrency.test.ts` — `[missing-teacher-role-setup] an invitation never falls back to another role` (unknown key, empty set, `owner`, and a mixed set; no invitation row is written and no substituted role is echoed) |
| suspended-session-reuse | Suspended member reuses a valid session | covered elsewhere | `apps/api/tests/membership-lifecycle.test.ts:265`. Also proved mid-flight here: `tests/security/sessions-and-recovery.test.ts` `[session-switch-in-flight] a suspension mid-session closes the school on the next request` |
| removed-member-other-school | Removed member still belongs to another school | covered elsewhere | `apps/api/tests/membership-lifecycle.test.ts:301` `removal ends one school only and keeps the exception history` |
| passwordless-mfa-bypass | User uses passwordless login to avoid privileged MFA | covered elsewhere | `apps/api/tests/phone-otp.test.ts:222`; `apps/api/tests/mfa.test.ts:177/240` |
| recovery-revokes-sessions | Recovery resets the password or replaces MFA/contact | partly new here; one leg open | `tests/security/sessions-and-recovery.test.ts` — `[recovery-revokes-sessions] a reset ends every other session and the old password` (two live sessions, single-use token, old password dead, new password works). The MFA-replacement leg: `[recovery-revokes-sessions] re-enrolling the second factor invalidates the earlier enrolment` (a session stamped by the replaced authenticator is refused the school on its next request). The contact-change leg has no route in this build; see "Open findings" |
| invitation-invalid-states | Expired, revoked, replayed or wrong-recipient invitation | covered elsewhere | `apps/api/tests/invitations.test.ts:310/329/348/368/260` |
| inviter-loses-authority | Inviter loses grant authority before acceptance | covered elsewhere | `apps/api/tests/invitations.test.ts:395` `an invitation dies with the authority behind it` |
| single-consumption | Two requests accept one invitation or use one OTP | covered elsewhere | `apps/api/tests/invitations.test.ts:291`; `apps/api/tests/phone-otp.test.ts:205`; `apps/api/tests/mfa.test.ts:220` (all real `Promise.all` races) |
| concurrent-last-owner | Two administrators remove or demote the last owners concurrently | new here | `tests/security/lifecycle-and-concurrency.test.ts` — `[concurrent-last-owner] two concurrent attempts on a second owner change nothing`, `… two lifecycle writes from one version serialise`, `… the school keeps an owner when the last one is attacked twice`. An owner membership is only ever changed by the ownership transfer workflow, so the invariant holds structurally as well; the transfer race itself is `apps/api/tests/ownership.test.ts:215` |
| deny-wins | Explicit allow plus matching deny | new here | `tests/security/relationship-scope.test.ts` — `[deny-wins] a matching deny beats an explicit allow in list, detail, export and actions` |
| exception-expiry-live | Exception expires or a teaching assignment ends | new here | `tests/security/relationship-scope.test.ts` — `[exception-expiry-live] an assignment that ends closes access on the same cookie`, `… an exception stops applying when its window passes` (the second one moves only the window: no new sign-in and no access-version bump) |
| role-revoked-during-write | Role revoked during a sensitive write or export | new here | `tests/security/lifecycle-and-concurrency.test.ts` — `[role-revoked-during-write] a pay write racing its own revocation never half-commits`, `… an export made under an access version that then changes is not served` |
| service-unavailable-no-fallback | Permission or database service unavailable | new here | `tests/security/production-guards.test.ts` — `[service-unavailable-no-fallback] a read is refused, not answered, when the runtime pool is gone`, `… an anonymous caller is still refused during the outage` |
| tenant-context-pooling | Missing tenant context and reused pooled connections | covered elsewhere | `packages/db/tests/tenant-isolation.test.mjs:44/259/339`; `packages/db/tests/connection-boundaries.test.mjs:99/149/170` |
| audit-leak | Audit event contains sensitive changes | new here | `tests/security/field-boundaries.test.ts` — `[audit-leak] no audit row carries a hidden value, for any reader`, `… the audit reader never sees the pay amount it changed`. The test also pins today's breadth: `audit.read` at the finance scope reads the whole log, asserted as current behaviour so narrowing it later shows up |
| session-switch-in-flight | Logout or school switch while requests are in flight | partly new here (API leg) | `tests/security/sessions-and-recovery.test.ts` — `[session-switch-in-flight] a read racing a sign-out never answers after it`, `… a suspension mid-session closes the school on the next request`. Client guard: `apps/web/src/lib/http.test.ts:70`. The browser leg (a real school switch with a request in flight) belongs to `tests/browser` and is not in this suite |
| production-bundle-clean | Production browser bundle and network responses | new here | `tests/security/production-guards.test.ts` — `[production-bundle-clean] the deleted mock data layer has not come back`, `… no fixture, seed or credential marker reaches the web sources`, `… a built bundle, if one is present, carries none of them either`. The last one is a no-op when nothing is built; `pnpm check:assets` is what runs the same scan over a real build |
| delivery-failure | Delivery provider fails or times out | new here, within the sandbox adapter | `tests/security/sessions-and-recovery.test.ts` — `[delivery-failure] a failed delivery is not a silent success, and the retry does not duplicate`, `… a failed reset delivery still answers generically and leaks no token`. There is no third-party delivery provider in this build (`DELIVERY_MODE=sandbox`; provider mode fails startup, `apps/api/tests/scaffold.test.ts:38`), so the failure is injected through a scripted adapter rather than a real timeout |
| private-doc-after-revocation | Private document copied URL after permission removal | new here | `tests/security/sessions-and-recovery.test.ts` — `[private-doc-after-revocation] a copied download URL dies with the permission`, `… a parent without the download key never gets the bytes`. There is no public storage URL to fall back to: document metadata never carries a storage key or a link (`apps/api/tests/modules-students.test.ts:315`), so that half of the row is **not applicable** by design |
| per-action-separation (closing sentence) | View must not imply export, edit, approve or delegate | new here | `tests/security/field-boundaries.test.ts` — `[per-action-separation] reading students never implies exporting them`, `… reading the staff directory never implies export or pay`, `… an audit reader is not an audit exporter`. Matrix-driven policy units: `packages/authz/tests/policy.test.ts:92/308`. Real-database RLS and transaction tests: `packages/db/tests`. Browser tests for session transitions live in `tests/browser` |

## Files in this suite

| File | Rows |
|---|---|
| `tests/security/tenant-isolation.test.ts` | anon-every-endpoint, cross-school-record |
| `tests/security/identity-tampering.test.ts` | client-identity-tampering, student-policy-fixtures |
| `tests/security/relationship-scope.test.ts` | teacher-two-sections, teacher-also-parent, guardian-no-portal, deny-wins, exception-expiry-live |
| `tests/security/field-boundaries.test.ts` | hidden-field-query, audit-leak, per-action-separation |
| `tests/security/lifecycle-and-concurrency.test.ts` | clerk-delegation-limits, missing-teacher-role-setup, concurrent-last-owner, role-revoked-during-write |
| `tests/security/sessions-and-recovery.test.ts` | recovery-revokes-sessions, session-switch-in-flight, private-doc-after-revocation, delivery-failure |
| `tests/security/production-guards.test.ts` | production-bundle-clean, service-unavailable-no-fallback |
| `tests/security/support.ts` | shared scaffolding: members, teachers, sections, students, portal grants, exception rules, a scripted delivery adapter |

## Behaviour this suite pins, which was not obvious

- A member whose relationship set is empty (a parent with no children left, a teacher whose last assignment ended) is refused the whole area with `403 ACCESS_DENIED` at the gate, before any record lookup. With one relationship left, the same request is `404 RESOURCE_NOT_FOUND`. Both are refusals. The list route is the pinned case: with an empty relationship set it answers `403` (asserted exactly), and the detail route is accepted as either code because which one applies depends on how many relationships are left.
- A resource-scoped allow exception does not open the gate: the gate decides the permission against an aggregate resource, which no student-, staff- or document-targeted rule matches. An exception therefore widens a caller who already holds the area, and cannot let an outsider in. This fails closed, so it is asserted as current behaviour.
- `admin` may assign only `teacher` and manage only `teacher`, and holds no `members.manage_credentials` at all: credential recovery is the owner's alone.
- Restore states the reviewed role set (`roleKeys`), and resend takes the version alone.
- No role template grants a parent `students.download_documents`; a portal download is an explicit exception.
- A caller who is a teacher of one class and the parent of one child cannot see another teacher's staff record at all: `GET /staff/:id` is `404`. Her own record is `200` and carries no `monthlySalary`, which is the positive control for the pay field being hidden rather than the record being refused.
- When delivery fails, the invitation is still created: the response is `201` with `deliveryStatus: "failed"` and the `delivery_outbox` row is `failed`. A recovered resend answers `deliveryStatus: "sent"`, which is the positive control for that field.
- A free-text search or count on a hidden value (medical note, guardian phone, salary) is a normal `200` with zero results, not a rejection.

## Open findings

1. **Replacing the TOTP enrolment did not end the sessions stamped by the old one.** Found by this suite and fixed in the same task: the `after` hook in `apps/api/src/auth/better-auth.ts` now clears `mfa_verified_at` on every session of the person when `two-factor/enable` or `two-factor/disable` succeeds. The test that found it runs and passes.
2. **The contact-change leg of `recovery-revokes-sessions` is untested.** There is no route in this build that changes an account's email or phone, so there is nothing to test; if one is added, it needs a case that ends other sessions and notifies the old identifier.
3. **The browser leg of `session-switch-in-flight` and of `production-bundle-clean` is not here.** Both need Playwright specs in `tests/browser`.
