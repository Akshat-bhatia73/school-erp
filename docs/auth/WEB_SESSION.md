# Login and application session UI

Task 6 puts the web app on the real API. The browser no longer picks who it is: `apps/web` signs in against [the Fastify service](./AUTHENTICATION.md), derives the whole session from `GET /api/me` and `GET /api/schools/:schoolId/context`, and renders nothing school-shaped until both have answered. It is defined in [the implementation plan](../AUTH_RBAC_IMPLEMENTATION_PLAN.md) (sections 4, 5 and 10, and the Task 6 checklist).

It does not change any permission decision. The server decides; the web app only asks, and hides what it was told it cannot have. The feature screens still read the in-memory mock API — Task 7 moves them onto the protected APIs and `allowedActions`.

Source files: [src/lib/http.ts](../../apps/web/src/lib/http.ts), [src/lib/auth-client.ts](../../apps/web/src/lib/auth-client.ts), [src/lib/api-errors.ts](../../apps/web/src/lib/api-errors.ts), [src/lib/return-to.ts](../../apps/web/src/lib/return-to.ts), [src/lib/session.tsx](../../apps/web/src/lib/session.tsx), [src/lib/query.ts](../../apps/web/src/lib/query.ts), [src/components/auth](../../apps/web/src/components/auth), and the public routes under [src/routes](../../apps/web/src/routes).

## Run locally

Start the database and the API first; see [database setup](./DATABASE.md) and [authentication](./AUTHENTICATION.md). Then create the development identities and start the web app.

```sh
docker compose -f compose.db.yml up -d --wait
MIGRATION_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp pnpm db:migrate
FIXTURE_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp pnpm db:fixtures

cp apps/api/.env.example apps/api/.env      # then set DEV_SANDBOX_OUTBOX=true
pnpm dev:api                                # http://127.0.0.1:3001
pnpm --filter @erp/api dev:logins           # the sign-in accounts below
pnpm --filter @erp/web dev                  # http://localhost:5173
```

The web app must be opened at `http://localhost:5173` and nowhere else: that origin is `APP_ORIGIN`, and the API refuses any other. `/api` is proxied to `127.0.0.1:3001` by [vite.config.ts](../../apps/web/vite.config.ts) with `changeOrigin: false`, so the API sees the browser's own `Origin` and `Host`. The API is therefore same-origin: the session is an HttpOnly `SameSite=Lax` cookie, there is no bearer token, and there is no CSRF token because same-origin is the protection.

### Development sign-ins

`pnpm --filter @erp/api dev:logins` creates or refreshes these against the fixture schools. It refuses to run when `NODE_ENV=production` or `DELIVERY_MODE` is not `sandbox`, and it is idempotent. The password for every email account is `fixture-password-1`. Fixture A is `10000000-0000-4000-8000-000000000001`, Fixture B is `20000000-0000-4000-8000-000000000001`.

| Name | School | Roles | Sign-in | Identifier | What to expect |
|---|---|---|---|---|---|
| Owner A | Fixture A | owner | email + password | `fixture-owner-a@example.test` | Signs in; the school context answers `MFA_REQUIRED` until a second factor is completed |
| Owner B | Fixture B | owner | email + password | `fixture-owner-b@example.test` | Same; use it to prove Fixture A answers `SCHOOL_ACCESS_UNAVAILABLE` |
| Fixture Adult | Fixture A | teacher, parent | email + password | `fixture-adult@example.test` | Reaches the school straight away; one factor is enough |
| Suspended | Fixture A | teacher (suspended) | email + password | `fixture-suspended@example.test` | Signs in; `/api/me` lists no membership |
| Student | Fixture A | student | email + password | `fixture-student@example.test` | Always refused: student sign-in is specified and disabled |
| Parent A2 | Fixture A | parent | phone code | `9876543210` | `send-otp` always answers `{"status":"sent"}`; read the code from the outbox |
| Parent B | Fixture B | parent | phone code | `9876543211` | A second school, for switching |

### Reading codes and tokens

Delivery mode is `sandbox`: nothing is sent anywhere. With `DEV_SANDBOX_OUTBOX=true` in `apps/api/.env`, `GET /api/dev/outbox` lists the last 50 sandbox messages, newest first, as `{channel, to, purpose, secret, createdAt}`. `purpose` is `otp`, `password_reset`, `verification` or `invitation`, and `secret` is the six-digit code or the raw token.

```sh
curl -s http://127.0.0.1:3001/api/dev/outbox | jq '.messages[0]'
```

The route only exists when `DEV_SANDBOX_OUTBOX=true`, `NODE_ENV` is not `production` and `DELIVERY_MODE=sandbox`; otherwise it is never registered and a request gets the ordinary 404 envelope. Startup fails outright if the flag is set with `NODE_ENV=production`. The outbox is process memory, so it empties whenever the API restarts — read a code straight after sending it. `apps/api/.env.example` ships the flag as `false` with a warning that it exposes one-time codes.

The web app owns the reset link shape: `/reset-password?token=<secret of the password_reset message>`.

## The session model

[`lib/session.tsx`](../../apps/web/src/lib/session.tsx) holds one provider at the root. It answers two questions from two server calls and nothing else.

- `GET /api/me` says who is signed in and which schools they belong to. It produces `status`, `user`, `session` and `memberships`.
- `GET /api/schools/:schoolId/context` says what they may do in the school this tab is looking at. It produces `context`, `school`, `roleKeys`, `capabilities` and `accessVersion`. The school is always a path parameter; there is no server-side "active school".

`status` is `loading`, `anonymous`, `unavailable`, `blocked` or `authenticated`. `blocked` is a signed-in identity the app will not open for anyone — today only a student, whose session the server deletes while answering `FEATURE_DISABLED`. It is deliberately not `unavailable`: there is nothing to retry, so the person is told their way of signing in is off rather than that the server is down.

`context` is `idle`, `loading`, `ready`, `mfa_required` or `unavailable`.

The active school is a per-tab preference in `sessionStorage` (`erp.activeSchoolId`), honoured only when it matches an active adult membership. It cannot widen access: the server reads the school from the URL on every request. Identity is never in `localStorage`; the old `erp.userId` and `erp.schoolId` keys are deleted on boot, and setting them by hand does nothing. The only surviving `localStorage` keys in the app are `erp.sidebar` and `erp.theme`.

The context is re-read every 30 seconds while the tab is visible, and on focus. A changed `accessVersion` means somebody altered this person's access, so the cache is dropped and the screens reload against the new rules.

### Cache isolation

[`lib/http.ts`](../../apps/web/src/lib/http.ts) keeps a generation counter. Every request carries the abort signal of the generation it started in. Signing in, signing out and switching school bump the generation: in-flight requests of the old context are aborted, and any response that still arrives is turned into `STALE_RESPONSE` and thrown away. At the same moment the provider clears the old `QueryClient` and installs a new one, so a late answer cannot repopulate a cache that was emptied for another school.

Signing out does all three things at once: it revokes the cookie, bumps the generation and replaces the cache, and posts `signed-out` on the `erp-session` BroadcastChannel so every other tab clears itself. A successful sign-in posts `signed-in` the same way, so a tab sitting on an anonymous screen picks up the new session without a reload. A `401` from any request anywhere calls the same listener, which re-derives the session from the server.

### Errors

Every failure is the `@erp/contracts` `ApiError` envelope. [`lib/api-errors.ts`](../../apps/web/src/lib/api-errors.ts) turns a code into one plain English sentence; nothing renders a raw code, a request id or provider text. Sign-in failures are deliberately vague and never say whether an account exists — "We could not sign you in with those details.", "If that email has an account, we have sent a reset link." A throttle is stated as seconds while it is short and as whole minutes once it passes 90, because the second-factor window is fifteen minutes and a ticking counter that long helps nobody.

## Route map

Public routes render inside `AuthLayout`: a centred card on `md` and up, full-bleed on a phone, every control at least 44px tall, `inputMode="numeric"` and `autoComplete="one-time-code"` on code fields, a `<Label htmlFor>` on every input, and errors announced with `role="alert"`.

| Route | Who sees it | States |
|---|---|---|
| `/login` | Signed out. A signed-in person with a ready context goes to `/dashboard` | Tabs for School office, Teacher, Parent, Student. Email and password, or a 10-digit mobile for a phone code. Shared-device checkbox, show/hide password, forgot-password link. Idle, submitting, generic refusal, server unreachable, throttled with a countdown. Student is a dashed block that never issues a request. A `twoFactorRedirect` goes to `/mfa/verify`, carrying the shared-device choice |
| `/verify-otp` | Signed out, after a phone code was sent | Masked destination, one six-digit field that submits itself on the sixth digit, 60-second resend countdown, "Change number". A `phone` search param is only accepted as `+91` followed by a valid 10-digit mobile; anything else falls back to `/login?audience=parent` |
| `/forgot-password` | Signed out | Email field, then the same generic panel on success and on any non-throttle failure |
| `/reset-password` | Signed out, with `?token` | Missing token, new password and confirm, expired-or-used link with a way to ask for a new one, success saying every other device was signed out |
| `/mfa/verify` | Anyone owing a second step | Loading, refused code ("That code did not work."), backup-code mode, throttled, and a redirect to `/login` only when a session that existed has actually gone. A typed address with a ready context goes to `/dashboard`; a link from account security carries `returnTo` and opens |
| `/mfa/setup` | A privileged role without an authenticator | Password, then the QR and the secret, then the first code, and only then the backup codes with "Continue" held back until they are acknowledged. Same typed-address rule as `/mfa/verify` |
| `/select-school` | Signed in, more than one school | Skeleton, the list of active adult memberships with their roles, "Current" on the selected one, "No school yet" when there are none. Never redirects a signed-in person away |
| `/accept-invite` | Anyone with an invitation link | Missing or malformed token, signed out (with a sign-in link that returns here), the identity the invitation will be accepted as, accepted, and the permanent refusals that hide the button. The token is never rendered or logged |
| `/account/security` | Signed in; no school needed | Account facts, password change, two-step verification on or off with backup codes and turn-off, the device list with per-device and "everywhere else" sign-out, and sign-out for this device |
| `/access-unavailable` | Anyone | One screen for `no_membership`, `suspended`, `school`, `student`, `disabled`, `forbidden` and `not_found`. Also the router's not-found screen |

`AppGate` guards everything under `_app`. It renders a neutral skeleton — no shell, no navigation, no data — until `status` is `authenticated` and `context` is `ready`. Anonymous goes to `/login` with a sanitised `returnTo`; `blocked` goes to `/access-unavailable?reason=student`; no membership, a school that will not open, or a second step still owed each go to their own screen. Protected content never flashes before the context loads.

`returnTo` is sanitised by [`lib/return-to.ts`](../../apps/web/src/lib/return-to.ts): same-origin relative paths only, query string preserved, credential screens refused so signing in cannot loop. `/accept-invite` is deliberately allowed, because it is a destination rather than a sign-in step, so an invitee who has to sign in first lands back on their invitation.

## The legacy mock bridge

The feature screens still read the in-memory mock API in [`api/client.ts`](../../apps/web/src/api/client.ts) and still ask `can(module, action)` with the `@erp/shared` role model, which is a different vocabulary from the server's permission keys. Until Task 7, `lib/session.tsx` keeps both worlds alive, and says so at the top of the file: it resolves the mock roles whose key matches the server's `roleKeys` (the server's `principal` maps onto the mock `owner`), computes `can` and `scope` from them, and pushes the signed-in person into the mock client through `setApiContext`.

None of that is an authorization decision. The server decides, and the mock data is local dummy data. Task 7 deletes `can`, `scope`, `roles`, `mockSchoolId` and `setApiContext`, and the bridge block with them.

Also gone in Task 6 and not coming back: the "viewing as" user switcher, the sidebar school-switcher dropdown and the "auth is off" notice. Switching school is now "Switch school" in the account menu and the command menu, both pointing at `/select-school`. `settings/users` still lists mock users and says plainly that invitations and logins are server-managed in a later build; Task 7 replaces it.

## Deployment

[apps/web/vercel.json](../../apps/web/vercel.json) keeps the SPA rewrite `/(.*) -> /index.html` so a deep link such as `/reset-password?token=...` loads the app. A deployment must route `/api` to the backend **before** that rewrite, on the same origin as the app, or every API call will be answered with `index.html`. The cookie is same-site, so a separate API origin would not work without re-opening cross-site cookies, which this design deliberately avoids.

## Tests

`pnpm --filter @erp/web test -- --run` runs 88 tests in 13 files under vitest with jsdom and Testing Library. `lib/auth-client` is mocked everywhere; no test touches the network. `vitest` globals are off, so test files import `describe`, `it` and `expect` from `vitest`. The shared `src/test/setup.ts` stubs `matchMedia` and `ResizeObserver`, which jsdom lacks and the Radix primitives need.

What they prove: the envelope parsing, `Retry-After` precedence and `STALE_RESPONSE` on a mid-flight generation bump in `http`; `returnTo` sanitising, including that an invitation link survives; the session provider going anonymous on 401, `blocked` on `FEATURE_DISABLED`, unavailable on a network failure, auto-selecting a single membership, `mfa_required` context, ignoring and deleting the old `localStorage` identity keys, and clearing on a `signed-out` broadcast; the gate rendering no shell while either the session or the context is loading; the login screens' generic refusals, throttle countdown, `returnTo` with a query string and the shared-device flag surviving a `twoFactorRedirect`; the OTP screen's auto-submit and resend; the reset screen treating a refused token as an expired link; the QR encoder against vectors from the reference `qrcode` package; the MFA verify panel saying a code was wrong rather than bouncing to sign-in, and only redirecting when the session really has gone; the enrolment step order with backup codes withheld until a code is accepted; account security's device list, revoke-by-id, password validation, turn-off freshness branch and backup-code regeneration; and the school chooser, invitation panel and access screens.

The API side is covered by `pnpm test:api` (250 tests), including the dev outbox route being absent by default and listing a sent OTP when the flag is on.

## Known gaps

- No browser run. Nothing was served on `5173` during this work, so the Vite `/api` proxy, the QR code in a real authenticator app and the invitation success path are verified by curl and unit tests only, not by hand.
- `/api/me` only ever returns active adult memberships, so the school chooser cannot show a suspended one. A suspended member gets `no_membership`, whose copy now covers "not invited yet, suspended or removed" rather than naming the cause.
- A real invitation token could not be minted (it needs an MFA-enrolled owner), so only the failure codes of `POST /api/invitations/accept` were exercised against the live API.
- `two-factor/disable` from a session that never completed a second factor is refused as `AUTHENTICATION_REQUIRED`, not `FRESH_AUTHENTICATION_REQUIRED`. The turn-off dialog treats both the same way and offers the authenticator.
- The provider sign-in body still carries the fixture parents' non-provider email. The UI takes display identity from `/api/me`, never from the provider body.
- `dev:logins` does not enrol a second factor, so exercising the MFA screens still means walking the enrolment flow.
- The device list uses a local query key `['account','sessions']` rather than one in `lib/query.ts`.
- Phone sign-in is offered on the Teacher and Parent tabs because the server gives no per-identity signal about which method an identity may use; `LOGIN_METHODS` is not enforced in the browser.
