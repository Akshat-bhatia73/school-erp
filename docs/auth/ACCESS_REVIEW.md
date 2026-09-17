# Access review

An independent read of the access boundaries before release. Written by a reviewer who did
not build the security suite. It covers three things: what the server actually does, what the
acceptance suite proves about it, and what is still untested or weak.

Companion documents: `docs/auth/RELEASE_MATRIX.md` (scenario to test), `AUTHORIZATION.md`,
`PROTECTED_APIS.md`, `ACCESS_MANAGEMENT.md`.

## What I verified by reading the server

I read `apps/api/src` and `packages/db` rather than trusting the tests.

**One transaction per request, with the tenant set inside it.**
`withTenantTransaction` (`packages/db/src/index.ts:26`) takes a pooled client, asserts it is a
runtime role that cannot bypass row-level security, opens the transaction, and sets
`app.school_id` and `app.request_id` with `set_config(..., true)` — transaction-local, so the
value cannot survive on a pooled connection into the next request. A rollback that itself fails
destroys the client instead of returning it to the pool. This is the mechanism the whole model
rests on, and it is small enough to audit by eye.

**A gate that runs before every handler.**
`protectedRoute` (`apps/api/src/modules/shared/route.ts`) refuses at startup to register a route
whose declared permission is unknown or reserved, so a route with no permission cannot exist.
At request time it requires a membership, then decides the declared permission against the
school as a whole in its own short transaction, then parses the request, then parses the
response through the route's contract and refuses to send an object that fails it. That last
step matters more than it looks: a projection bug becomes a 503, not a leak.

**Lists and details share one decision.**
Module reads build a plan with `readPlan` and AND `planPredicate(plan, scopedTableFor(...))`
into the SQL (`apps/api/src/modules/students/reads.ts`, `routes.ts`). The plan is built from the
same evaluator and the same policy snapshot the detail read uses, on the same connection. I
found no place in the students module that fetches a school-wide set and filters in JavaScript.
`allowedActionsFor` recomputes the per-record actions on that same snapshot, so the buttons a
client is told about and the answers it gets come from one decision.

**Writes lock, compare and audit.**
`lockSchool` takes `SELECT ... FOR UPDATE` on the school row and returns its access version.
`bumpVersion` puts the expected version in the `WHERE` clause, so two editors cannot both win,
and distinguishes "gone" from "someone got in first" with a second read rather than a guess. It
refuses any column name outside a strict pattern and refuses `id`, `school_id`, `version`,
`created_at` and `updated_at` outright, and every value is a bound parameter. `writeAudit` takes
the actor, membership and request id from the verified context, never from the request, and runs
on the caller's connection, so the change and its audit row commit or roll back together.

My conclusion from reading: the boundary is enforced in one place per concern, and the
dangerous shortcuts (filter in JS, trust a body field, write audit after commit) are structurally
hard to take rather than merely discouraged.

## What the acceptance suite proves

`tests/security` is seven files, 47 cases, driving the real server against a real PostgreSQL.
I ran it twice on the same scratch database without re-migrating between runs: 47 pass, 0 skipped after the MFA fix (46 pass, 1 skipped when first run),
0 fail, both times. `pnpm --filter @erp/security-tests typecheck` is clean.

The parts that add something no earlier suite had:

- **The anonymous sweep is a sweep, not a sample.** It reads Fastify's own route table and
  requires 401 with `AUTHENTICATION_REQUIRED` from every school route. A route added next month
  is covered the moment it is registered.
- **Identity tampering is attacked from four directions** — query string, request body, cookie and
  header — and each is checked against the decided context, the stored rows and the stored version,
  not just the status code.
- **Relationship scope is tested with purpose-built members**, not the shared fixtures: a teacher
  with two sections, a teacher who is also a parent, a guardian contact with no membership. The
  fixture "combined" member carries a school-wide exception that would have quietly widened the
  result; the suite avoids it deliberately.
- **Expiry is live.** An exception is expired by moving only its window — no new sign-in, no access
  version bump — and the very next request is refused. That is the hard version of the test.
- **Hidden values are unique strings the suite writes itself**, then hunted through sorts, filters,
  free text, counts, the global search, audit rows, audit exports and the stored export criteria.
  A leak would be found rather than argued about.
- **The concurrency cases really race** (`Promise.all`), and they assert the invariant afterwards
  (owner count, stored salary, membership roles), not only the status codes.
- **Every denial test has a permitted twin.** I checked this rather than taking it on trust: each
  file performs a successful, permitted request against the same route before or after the refusal.
  A server that denied everything would fail this suite in several places at once.

Matrix accuracy: I spot-checked twenty of the "covered elsewhere" citations, including their line
numbers, and every one named a real test that asserts what the row claims.

## What remains untested or weak

1. **Re-enrolling the second factor did not end sessions stamped by the old authenticator.**
   This was a real server gap, found by the suite: a session that passed MFA before a re-enrolment
   still entered the school afterwards. It was fixed after this review was written: the `after`
   hook in `apps/api/src/auth/better-auth.ts` now clears `mfa_verified_at` on every session of the
   person when the authenticator is enabled or disabled, and the test that found it passes. A
   release reviewer should still confirm the fix on the release commit.
2. **The last-owner concurrency row is proved structurally, not by a successful race.** Owner
   memberships cannot be changed through the member lifecycle routes at all, so both racing
   requests are refused and the invariant is never stressed. The real race is the ownership
   transfer test (`apps/api/tests/ownership.test.ts:215`). That is adequate, but it means the
   suite would not notice if lifecycle routes were ever opened to owner targets.
3. **There is no contact-change route**, so the "recovery replaces the contact" half of the
   recovery row has nothing to test. If an email or phone change is ever added, it needs a case
   that ends other sessions and notifies the old identifier.
4. **The built-bundle scan is a no-op in a clean tree.** `production-guards.test.ts` scans
   `apps/web/dist` only when a build is present. The standing guard is the source scan plus
   `pnpm check:assets`, which I did not run and which is owned by another track. Do not treat the
   green suite as evidence that a production bundle is clean; run `check:assets` against a real build.
5. **Browser coverage is elsewhere.** A real school switch with a request in flight, and inspection
   of network responses during a signed-in session, need Playwright specs in `tests/browser`. The
   API leg of both is covered here; the client leg is not.
6. **Delivery failure is injected, not provoked.** There is no third-party provider in this build,
   so a scripted adapter stands in for a timeout. That is the honest thing to do, but it does not
   exercise a slow provider, only a throwing one.
7. **A few assertions are broader than they need to be** — accepting 403 or 404 where only one is
   possible, or checking a JSON substring instead of a parsed field. None of them hides a failure
   today; they make the suite slower to notice a regression tomorrow. They are listed in the
   review notes for this track.

## Verdict

The boundary is coherent and the suite is adversarial rather than confirmatory. I would release on
it, with the MFA re-enrolment fix confirmed on the release commit and `pnpm check:assets` run against
the real production build before cutover.
