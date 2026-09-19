# Authentication and sessions

Task 2 adds `apps/api`: a Fastify service that runs Better Auth 1.7.4 against the Task 1 database, verifies every request against a database-backed session, resolves school memberships through the restricted identity role, and returns the Task 0 contract shapes. It is defined in [the implementation plan](../AUTH_RBAC_IMPLEMENTATION_PLAN.md) (sections 4, 5 and 11, and the Task 2 checklist).

It does not decide what a signed-in person may read or write. Permission, relationship, field and access-version checks are Task 3; safe API responses, invitations, delegation, the web integration and browser tests are Tasks 4 to 8. The web app still runs on its mock API and does not call this service yet.

Source files: [src/config.ts](../../apps/api/src/config.ts), [src/db.ts](../../apps/api/src/db.ts), [src/app.ts](../../apps/api/src/app.ts), [src/auth](../../apps/api/src/auth), [src/identity](../../apps/api/src/identity), [src/delivery](../../apps/api/src/delivery), [src/routes/identity.ts](../../apps/api/src/routes/identity.ts).

## Run locally

Start the database first; see [database setup](./DATABASE.md). Then copy the development environment file and run the service.

```sh
docker compose -f compose.db.yml up -d --wait
MIGRATION_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp pnpm db:migrate
FIXTURE_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp pnpm db:fixtures

cp apps/api/.env.example apps/api/.env
pnpm dev:api          # http://127.0.0.1:3001
pnpm test:api
pnpm --filter @erp/api typecheck
```

`pnpm dev:api` loads `apps/api/.env` with `node --env-file-if-exists`; there is no dotenv dependency. [apps/api/.env.example](../../apps/api/.env.example) holds development values only: the local container passwords and a throwaway `AUTH_SECRET`. Deployments must supply real values from their secret store.

Variables: `AUTH_DATABASE_URL`, `IDENTITY_DATABASE_URL`, `DATABASE_URL`, `AUTH_SECRET` (32 characters or more), `APP_ORIGIN` (the single browser origin), `API_TRUST_PROXY` (default `false`), `DELIVERY_MODE` (`sandbox` or `provider`), `ALLOW_SANDBOX_DELIVERY` (default `false`), `DEV_SANDBOX_OUTBOX` (default `false`), `DOCUMENT_STORAGE_DIR` (default `.documents`), `DOCUMENT_STORAGE` (`local` or `blob`), `BLOB_READ_WRITE_TOKEN`, `RESEND_API_KEY`, `EMAIL_FROM`, `HELD_SMS_TOKEN`, `SENTRY_DSN`, `PORT`, `HOST` (default `127.0.0.1`), `NODE_ENV`. They are read once in `src/config.ts` with Zod. An invalid value stops the process and the message names the fields, never their values.

| Variable | Default | What it does |
|---|---|---|
| `AUTH_DATABASE_URL` | none | Better Auth tables. Signs in as `erp_auth`. |
| `IDENTITY_DATABASE_URL` | none | Identity provisioning. Signs in as `erp_identity`. |
| `DATABASE_URL` | none | School data through the tenant transaction. Signs in as `erp_runtime`. |
| `AUTH_SECRET` | none | Signs sessions. 32 characters or more. |
| `APP_ORIGIN` | none | The one browser origin allowed to call the API. |
| `API_TRUST_PROXY` | `false` | Honour `X-Forwarded-*`. Set `true` only behind a proxy you control. |
| `DELIVERY_MODE` | `sandbox` | `sandbox` keeps messages in memory; `provider` sends email through Resend and needs `RESEND_API_KEY` and `EMAIL_FROM`, or startup stops. |
| `HELD_SMS_TOKEN` | unset | Test builds only, provider mode only. There is no SMS provider: with this unset a text message fails; with it set the message is held for ten minutes and the token reads it at `GET /api/held-codes`. Never set for a real school. |
| `DOCUMENT_STORAGE` | `local` | `blob` reads private documents from a Vercel Blob store and needs `BLOB_READ_WRITE_TOKEN`. |
| `SENTRY_DSN` | unset | Error reporting. Reports carry no body, cookie, header, query string or user. |
| `ALLOW_SANDBOX_DELIVERY` | `false` | Sandbox delivery logs codes instead of sending them; never in real use. With `NODE_ENV=production`, startup is refused on `DELIVERY_MODE=sandbox` unless this is `true`. |
| `DEV_SANDBOX_OUTBOX` | `false` | Publishes `GET /api/dev/outbox`. Refused when `NODE_ENV=production`. |
| `DOCUMENT_STORAGE_DIR` | `.documents` | Where private student documents are written. |
| `PORT` | `3001` | Listen port. |
| `HOST` | `127.0.0.1` | Listen interface. Loopback on a developer machine; the container sets `0.0.0.0` and publishes the port only to the proxy's private network. |
| `NODE_ENV` | `development` | `production` adds the release guards below. |

With `NODE_ENV=production` the server also refuses to start when `AUTH_SECRET` is the value in `apps/api/.env.example` or shorter than 32 characters, when `APP_ORIGIN` is not `https` (localhost excepted), when delivery is the sandbox without `ALLOW_SANDBOX_DELIVERY=true`, or when any database URL signs in as `erp_migrator`, the login that owns the schema. The runbook is [docs/auth/RELEASE.md](./RELEASE.md).

### Messages in development

`DELIVERY_MODE=sandbox` is the development and test mode. The sandbox adapter keeps messages in memory, logs one line prefixed `[SANDBOX DELIVERY]` that states nothing was sent and omits the code or token, and exposes the list to tests. Nothing leaves the process, so a one-time code or reset link is read from that in-memory outbox in a test, or from the sandbox adapter in a REPL — not from a mailbox or a phone. `GET /api/auth-config` reports the delivery mode so a future sign-in screen can say plainly that no message was sent. `DELIVERY_MODE=provider` sends email through Resend (`src/delivery/resend.ts`): links point at `APP_ORIGIN` and the adapter logs nothing. It has no SMS provider, so a text message fails rather than implying a delivery, unless a test build holds it (`HELD_SMS_TOKEN`, see the release runbook section 0.1).

## Credential boundaries

The service opens three pools and never shares one across boundaries.

| Pool | Login | Use |
|---|---|---|
| auth | `erp_auth` | The Better Auth drizzle adapter (provider `pg`) with an explicit mapping of `auth_user`, `auth_session`, `auth_account`, `auth_verification`, `auth_two_factor` and `auth_rate_limit`. IDs are UUIDs (`advanced.database.generateId`). It cannot read schools, memberships or roles. |
| identity | `erp_identity` | Executes `active_adult_memberships_for_user` and `user_has_student_membership` and nothing else. |
| runtime | `erp_runtime` | Tenant tables through `withTenantTransaction` under forced row-level security. `assertRuntimeRole` checks the connected role at startup. |

`src/auth/request-context.ts` is the only place that builds a server `RequestContext`. It casts through `unknown` for the contract's brand, so a context can only exist after a session and a membership have been verified in this process.

## Endpoints

| Endpoint | Notes |
|---|---|
| `GET /api/health` | Liveness only. |
| `GET /api/auth-config` | Delivery mode and `studentLoginEnabled: false`. Schoolless, no user directory. |
| `GET /api/me` | `MeResponse`, parsed against the contract before sending. A generated `@phone-only.invalid` identifier is never returned as an email. |
| `GET /api/schools/:schoolId/context` | `SchoolContextResponse`. Its `capabilities` list is a navigation hint. Task 3 replaced the role template union with `capabilities(context)` from [the policy service](./AUTHORIZATION.md): the set of permissions the member could exercise somewhere in the school. |
| `/api/auth/*` | Only the routes allowlisted in [src/auth/provider-routes.ts](../../apps/api/src/auth/provider-routes.ts). |

`GET /api/sessions` and `POST /api/sessions/:sessionId/revoke` are the application's own device list and revoke pair. They speak in opaque `auth_session` ids scoped to the signed-in identity; the provider's `list-sessions` and `revoke-session` routes are blocked because they return and accept raw session tokens.

The allowlist publishes email sign-in and sign-out, whole-account session revocation, password reset request and reset, change password, the phone send-otp and verify pair, and the six two-factor routes that are configured (enable, disable, get-totp-uri, verify-totp, verify-backup-code, generate-backup-codes). Everything else returns a plain 404 in the `ApiError` envelope: `sign-up/email`, `update-user`, `delete-user`, `change-email`, `phone-number/update`, `sign-in/phone-number`, the unconfigured `two-factor/send-otp`, `two-factor/verify-otp` and `two-factor/view-backup-codes`, and any route a future provider release adds. The password reset request route is `request-password-reset`; 1.7.4 has no `forget-password`.

Every response under `/api`, including every error, carries `Cache-Control: no-store`. Every error is the `ApiError` envelope with a request id and a fixed, non-specific message from `src/http/errors.ts`; provider text, database messages, tokens and the existence of an identifier never reach the client. A provider failure is mapped onto our own codes by status (401 `AUTHENTICATION_REQUIRED`, 403 `ACCESS_DENIED`, 404 `RESOURCE_NOT_FOUND`, 429 `RATE_LIMITED`, 5xx `SERVICE_UNAVAILABLE`, anything else `INVALID_REQUEST`) and its body is dropped. A framework failure such as an unsupported content type or an oversized body is a client error (`INVALID_REQUEST`), not an outage.

Successful provider bodies are filtered too: the bearer `token` is removed, the user is projected to id, name, a real (non `.invalid`) email, the phone and `twoFactorEnabled`, and a session is projected to its id and timestamps. The session lives in the HttpOnly cookie and nowhere else.

## Sessions

Sessions are database-backed. The cookie cache is disabled, so a revoked session fails on its very next request; `src/auth/session.ts` re-verifies with `auth.api.getSession` every time and caches nothing. Cookies are `HttpOnly`, `SameSite=Lax`, path `/`, host-only (no `Domain`) and `Secure` outside development. `APP_ORIGIN` is the single trusted origin used for the base URL and the CSRF and origin checks. With `API_TRUST_PROXY=false` the forwarded protocol and host headers are ignored, so a forged `X-Forwarded-Host` cannot change the URL the provider signs against.

On top of the provider expiry the API applies its own limits, chosen from the strongest role the person holds in any school.

| Memberships | Absolute life | Idle limit |
|---|---|---|
| Any role that requires MFA (owner, principal, admin, accountant) | 8 hours | 30 minutes |
| Teacher | 12 hours | 60 minutes |
| Parent only | 7 days | none |
| No usable membership | 12 hours | 60 minutes |
| Shared device, any role | 2 hours | 15 minutes |

A sign-in or OTP/second-factor verification may send `sharedDevice: true`. The flag is stripped from the body, stored on `auth_session.shared_device`, and overrides the role profile with the shorter limits; remembered devices are off for everyone, so a shared browser keeps nothing.

The limits apply to `/api/auth/*` as well: the same check runs in the provider preHandler, so an over-limit cookie cannot keep working on `get-session`, `revoke-other-sessions` or `change-password`. The provider expiry is pinned to 7 days, the longest life any policy allows. The absolute life is measured from `auth_session.created_at` and the idle limit from `auth_session.updated_at`, so sliding renewal cannot outlive the absolute limit. `updated_at` is touched at most once a minute. A violated limit deletes the session row and answers `SESSION_EXPIRED`. `/api/me` reports the earlier of the provider expiry and the absolute limit. Signing out invalidates the server row, not just the cookie.

Memberships are not readable by `erp_auth`. After verification, `src/identity/resolve.ts` calls the identity function and then opens one tenant transaction per school to read the school summary and the role keys from `membership_roles` joined to `roles`. Suspended memberships and suspended schools never appear, and every result is validated with `MembershipSummary`.

## Assurance, MFA and fresh authentication

The second factor is an authenticator app: TOTP, 6 digits, 30 second period, issuer "School ERP", with single-use backup codes. The plugin's own email and SMS second-factor routes are not configured and not published, because an SMS code is a login factor here, not a second factor.

`auth_session.mfa_verified_at` is the only signal a privileged route trusts. `twoFactorEnabled` on the identity says the person has a second factor, not that this session answered a challenge, so an unstamped session is refused with `MFA_REQUIRED` even when the flag is true. One `after` hook in `src/auth/better-auth.ts` stamps that column, through `stampSessionMfaVerified` in `src/auth/mfa.ts`, on `two-factor/verify-totp` and `two-factor/verify-backup-code`. It stamps the newly created session for a sign-in challenge or a first enrolment, and the existing session for a step-up, which keeps the same session id. A password sign-in without two-factor, and a phone OTP sign-in, leave the stamp null. The same hook clears the stamp on every session of the person when `two-factor/enable` or `two-factor/disable` succeeds (`clearUserMfaVerification`): a replaced or removed authenticator invalidates every earlier proof, and a session stamped by the old device must answer the new one before it enters privileged data again. The enrolling session is stamped afresh when its first code is accepted.

`requireMembership()` re-reads the membership on every request, answers `SCHOOL_ACCESS_UNAVAILABLE` when there is no active membership for the school in the path, and `MFA_REQUIRED` when the membership is privileged and the session is not stamped. Better Auth counts second-factor failures only on the sign-in path, so a session that already exists could otherwise guess codes for ever. `src/auth/mfa.ts` adds our own budget: five failed `verify-totp` or `verify-backup-code` attempts per person (keyed by the verified user id, or by a hashed client address when there is no session yet) inside a rolling 15 minutes answer `RATE_LIMITED`, and a success clears the counter. Because the key is the verified identity and not the cookie header, a decoy cookie or a second stolen cookie for the same account cannot open a fresh budget.

`isFreshMfa` in `src/auth/assurance.ts` is the shared five-minute freshness check; it currently guards `two-factor/disable`, which returns `FRESH_AUTHENTICATION_REQUIRED` before the provider sees the request, and it is the check ownership transfer and role escalation must reuse; see [authorization and access scope](./AUTHORIZATION.md).

Enrolment (`two-factor/enable`) requires the current password and returns the `otpauth://` URI and backup codes once. `skipVerificationOnEnable` is false, so the second factor activates only after a code is accepted. Trusted devices are off: the API strips `trustDevice` from the verify bodies and removes any `*trust_device` cookie from every `/api/auth/*` request.

Password reset tokens live 15 minutes, are consumed on use, and reset revokes every other session of that identity. `change-password` requires the current password and the API forces `revokeOtherSessions: true`, so the caller cannot opt out.

## Who cannot sign in

There is no public signup. `emailAndPassword.disableSignUp` is true and the phone plugin has no `signUpOnVerification`, so no request creates an identity; identities are provisioned server-side in `src/identity/provision.ts` for the future invitation flow.

Student identities can never hold a session. A `databaseHooks.session.create.before` hook refuses to create a session for any identity with a student membership, so every login method fails. If a session row exists anyway, `resolveSession` deletes every session for that identity and answers `FEATURE_DISABLED`.

Phone-only adults get a generated `<uuid>@phone-only.invalid` address to satisfy the provider's unique email column. It is never marked verified, there is no credential account, and `sendResetPassword` refuses `.invalid` addresses, so email sign-in and password reset give that identifier no way in. They also cannot enrol in two-factor today, because enable requires a password, so a phone-only person with a privileged membership stays denied school context. A passwordless enrolment path is a later decision.

## Lockout and disable

Ten failed password sign-ins lock an identity for fifteen minutes. The counter is durable, per identity, and lives on `auth_user`: `failed_sign_ins` and `locked_until`, added by migration `0010_observability.sql`. The rate limits below are per address, so a spray spread over many addresses has no ceiling without this; the lock is per account and gives it one. `src/auth/lockout.ts` holds the SQL on the auth pool and the two constants. The lock is set in the same `UPDATE` that increments the counter, and only when no lock is already live, so further attempts cannot slide the window further out. A successful password sign-in clears both columns.

A locked identity, and a disabled one, is answered exactly like a wrong password. The `before` hook in `src/auth/better-auth.ts` looks the identity up by the identifier on `/sign-in/email` and `/phone-number/verify` and returns the provider's own body: `UNAUTHORIZED` with `INVALID_EMAIL_OR_PASSWORD` for the first, `BAD_REQUEST` with `INVALID_OTP` for the second. A caller cannot tell a lock from a wrong credential, so a lock is not an oracle for which addresses exist. The `after` hook on `/sign-in/email` does the counting.

Disabling is an operator action, not a school one: an identity can span schools and no school owns it. `auth_user.disabled_at` is set by a script that uses the auth login directly:

```sh
pnpm --filter @erp/api ops:identity -- --email person@example.com --disable
```

`--enable` clears it and `--unlock` only clears a lockout and the counter. The script reads `AUTH_DATABASE_URL`, prints one line such as `disabled 1 identity, ended 2 sessions`, and never echoes an address or a secret, so record the identity by `auth_user.id`. Disabling deletes every `auth_session` row of that identity in the same statement run. `resolveSession` also reads `disabled_at` on the auth pool before anything else and, when it is set, deletes the identity's sessions and answers `AUTHENTICATION_REQUIRED`, so a session already in flight when the script ran ends on its next request.

## Rate limits

Better Auth rate limiting runs with `storage: "database"` on the `auth_rate_limit` table from migration `0004_auth_service.sql`, so several instances share one counter. Better Auth prunes that table on its longest configured window (a minute), so anything that must last longer lives in `auth_throttle` from migration `0005_auth_throttle.sql`: the OTP cooldown and daily budgets and the step-up attempt counters, each row carrying its own expiry. The client address comes from the internal `x-erp-client-ip` header, which the API overwrites on every request with the address Fastify resolved under the configured trust-proxy setting.

Phone OTP policy lives in `src/auth/phone-otp.ts`: 6 digit code, 5 minute expiry, 3 attempts, 60 second resend cooldown, 5 sends per number per day, 20 sends per client address per day. The cooldown and both daily budgets are rows in `auth_throttle`, locked in a fixed order inside one transaction, so nothing depends on process memory. `POST /api/auth/phone-number/send-otp` normalises the number (a 10 digit Indian mobile becomes `+91…`; anything that is not that form is answered generically and produces no code), as does `POST /api/auth/phone-number/verify`, so the two steps always agree on one E.164 form, checks eligibility inside the provider hook (existing identity, verified phone, no student membership) and always answers `200 {"status":"sent"}`. A rate-limit violation is the only other answer: `RATE_LIMITED` with `retryAfterSeconds` and a `Retry-After` header, which describes the caller rather than the number. The verify step consumes the verification row inside a transaction, so two identical correct submissions produce exactly one session.

## Logging

Request logging carries no bodies. Cookies, `Authorization` and `Set-Cookie` are redacted and removed, along with password, token, code and OTP fields. Failures log a request id and our own error code only.

## What the tests prove

`pnpm test:api` runs `node:test` through tsx against the real PostgreSQL database and real HTTP endpoints; there is no mocked database or provider. `tests/harness.ts` starts the app on a reserved local port so `APP_ORIGIN` matches the listening origin, seeds the `@erp/db` fixtures and gives each test an isolated cookie jar. The files run one at a time because they share the database and the rate-limit table.

They cover: startup configuration and the refusal of `provider` delivery; blocked signup; the allowlist and the blocked routes; session verification, idle and absolute limits, and immediate revocation; membership and role resolution per school; student denial at sign-in and at verification; phone OTP send eligibility, cooldown, attempt lockout and concurrent verification; two-factor enrolment, challenge, step-up, backup-code single use, the refused trust device and the unstamped-session denial; password reset token reuse, expiry and session revocation, and change-password revoking other sessions. `tests/lockout.test.ts` covers the lockout and disable path: ten wrong passwords lock the identity and the eleventh with the right password answers identically, a back-dated `locked_until` lets it in and resets the counter, a disabled identity's live session is refused and its session rows are gone, and a locked phone identity's correct OTP is refused like a wrong one.

Not covered, and left for later tasks: a shared-device sign-in control in the UI (the server honours `sharedDevice`; the login screen that offers it is Task 6), real provider delivery and its failure handling, email verification when a contact address changes, WhatsApp delivery, cross-origin CSRF and `API_TRUST_PROXY=true` behind a real proxy, OTP expiry by clock, the provider's own account lockout, and every authorization decision beyond membership and assurance.

Design references: [Better Auth sessions](https://better-auth.com/docs/concepts/session-management), [phone plugin](https://better-auth.com/docs/plugins/phone-number), [MFA plugin](https://better-auth.com/docs/plugins/2fa), [contracts handover](./CONTRACTS.md), [database setup](./DATABASE.md).
