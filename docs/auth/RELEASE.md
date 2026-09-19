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

`GET /api/maintenance/sweep` deletes transient copies: expired import previews
and export jobs, delivery outbox and invitation rows past ninety days, expired
sessions, one-time codes, throttle rows and held text messages, the login
credentials of people whose last membership ended more than thirty days ago, and
access-log rows older than 180 days. It
never touches a person's record. `vercel.json` schedules it at 20:30 UTC, which
is 02:00 in India. The route is registered only when `CRON_SECRET` is set and
refuses any other bearer token; it logs one line with the counts it removed, one of which is `access_log`.

## 6.2 The retention schedule

This is the schedule the system enforces, and the one to publish to a school. The periods that the
code acts on are constants in `@erp/contracts` (`RETENTION`), so the API, the sweep and the screens
quote the same numbers. Periods start when the purpose ends, not when the row was created.

| Data | Keep while | Then | Enforced by |
|---|---|---|---|
| Student register fields (name, admission number, dates, class history, outcome) | Permanently, as state education rules require an admission register | Nothing; these are the register | `DELETE` is revoked from the runtime login |
| Student sensitive fields (birth date, Aadhaar fragment, APAAR, category, religion, medical notes, address, documents) | Enrolled, plus 3 years after leaving | Anonymise: clear the fields, delete the documents | `POST /students/:id/anonymise`, refused before the period has run |
| Guardian records | While any linked student is within the period above | Anonymised when the last link ends | The same route, and guardian unlink |
| Staff records (salary, identifier fragments, private contact) | Employed, plus 8 years after leaving for statutory payroll records | Anonymise contact and identifiers; keep employment dates and designation | `POST /staff/:id/anonymise` |
| Login identity and credentials | While the person holds any active membership | Sessions end when the last membership is removed; credentials go 30 days later, keeping `auth_user.id` and the name for audit attribution | Membership removal, then `sweep_orphaned_credentials` |
| Sessions, one-time codes, reset tokens, throttle rows, held text messages | Until expiry | Deleted | `sweep_auth_transients`, daily |
| Import previews | 24 hours | Deleted | `sweep_tenant_transients`, daily |
| Invitations | Until terminal | The identifier is blanked at that point; the row is deleted after 90 days | `sweep_tenant_transients`, daily |
| Delivery outbox | 90 days after delivery or failure | Deleted | `sweep_tenant_transients`, daily |
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

## 12. Scope

This release covers staff and parent sign-in, teacher invitations and the
access lifecycle, role changes, relationship-based limits, private responses
and downloads, database isolation and the test suites. Student sign-in is
designed but switched off; the server rejects it. Mobile layout, native apps,
offline data, a policy editor, custom roles and the AI assistant are not part
of it.
