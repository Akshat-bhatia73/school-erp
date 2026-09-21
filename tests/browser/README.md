# Browser tests for session transitions and downloads

Seven Playwright tests that drive the real web app against the real API, in
Chromium. They cover the moments where one identity's data could leak into the
next one's screen — sign-out, school switch, suspension, a typed address outside
a teacher's sections, and tampered browser storage — and the one place the app
hands a person a file to keep.

Nothing here decides access. Every assertion is about what the server allowed
and what the browser then showed.

## Run it

```sh
# once: create and migrate the suite's own database
TEST_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp_browser pnpm db:test:prepare

pnpm test:browser
```

`pnpm test:browser` seeds the fixtures, starts both servers, runs the tests and
stops everything again.

Useful variations, run from `tests/browser`:

```sh
npx playwright test tests/suspension.spec.ts     # one file
npx playwright test --headed                     # watch it happen
npx playwright test --trace on                   # a trace for every test
```

## Ports and database

Everything is on its own ports and its own database, so a run never meets the
development pair on 3001/5173 or the development data in `erp`.

| Thing | Value | Set by |
|---|---|---|
| API | `http://127.0.0.1:3101` | `webServer[0]` in `playwright.config.ts` |
| Web app | `http://localhost:5174` | `webServer[1]`, through `WEB_PORT` |
| API proxy target | `http://127.0.0.1:3101` | `API_PROXY_TARGET` |
| Database | `erp_browser` at `127.0.0.1:54329` | `env.ts` |
| Storage for documents | `tests/browser/.documents` | `DOCUMENT_STORAGE_DIR` |

The web app must be opened at `http://localhost:5174` and nowhere else: that is
`APP_ORIGIN`, and the API refuses any other origin. `WEB_PORT` and
`API_PROXY_TARGET` are the only two things this suite changes in
`apps/web/vite.config.ts`, and unset they are the development defaults (5173 and
`http://127.0.0.1:3001`).

The API runs with `DELIVERY_MODE=sandbox` and `DEV_SANDBOX_OUTBOX=true`, so a
one-time code can be read back from `GET /api/dev/outbox` if a test ever needs
one. `NODE_ENV=test`; startup refuses that flag in production.

## What the database holds

`global-setup.ts` migrates nothing — `pnpm db:test:prepare` already did — and
runs `setup/seed.ts` through tsx. The seed lays the shared `@erp/db` fixtures
down first, then adds the people this suite signs in as, all named in
`setup/people.ts`:

| Person | School | Role | What they can see |
|---|---|---|---|
| Teacher Alpha | Fixture A | teacher | Section A, so Alpha Learner only |
| Teacher Beta | Fixture A | teacher | Section B, so Beta Learner only |
| Teacher Gamma | Fixture A | teacher | Section A. Suspended by the owner, then restored |
| Teacher Dual | Fixture A and Fixture B | teacher | Alpha Learner in A, Bravo Learner in B |
| Browser Owner | Fixture A | owner | Everything, after a second factor |

The password is the same for all of them (`setup/people.ts`). It is hashed by
the API's own authentication instance, in a separate process, because there is
no HTTP route that provisions a password and the tests must not invent one.

The seed also clears every authenticator enrolment, session and rate-limit row
for those people, so a run always starts from the same place. The owner enrols
a fresh authenticator inside the test that needs one, and the six digits are
generated in `support/totp.ts` — the same RFC 6238 defaults the provider uses,
over the base32 secret the enrolment published.

## The tests

| File | What it proves |
|---|---|
| `teacher-scope.spec.ts` | A signed-out visit to `/students` lands on sign-in with nothing behind it; a teacher's roster is their own sections; an unrelated pupil's address gives the refusal, and their own pupil still opens |
| `sign-out-in-flight.spec.ts` | A roster held open across a sign-out never paints into the next person's session, and the sign-in page carries no school data |
| `school-switch-in-flight.spec.ts` | The same, across a school switch by a person with two memberships |
| `suspension.spec.ts` | An owner suspends a teacher who is signed in at that moment, in another browser context; the teacher's next navigation lands on the refusal ("No school yet", whose copy names suspension, because `/api/me` lists active memberships only), never on the roster |
| `tampering.spec.ts` | `localStorage`, `sessionStorage` and readable cookies that look like a role or a school override change no role, no school and no control |
| `exports.spec.ts` | An owner picks rows on the roster and "Export to Excel" saves a real `.xlsx`; "Export PDF" on one student's record saves a real `.pdf`. It enrols a second factor for the owner and hands it back afterwards, so the suspension test still starts from nothing |

Two halves of the plan row for production output live elsewhere, on purpose:
the shipped bundle is checked by the release track's `pnpm check:assets`
(`scripts/check-production-assets.mjs`, the single list of forbidden strings),
and the claim that a teacher's network responses omit private fields such as
salary and bank details is covered by the API test suite, not here.

`holdOnce` and `watchForText` in `support/app.ts` are what make the in-flight
tests honest: the first fetches the answer while the old session is still
valid and then defers delivering it until after the transition, the second
installs a MutationObserver that records every DOM state, so a row that flashes
and is swept away still fails.

## Conventions

- Locators are the accessible ones the screens already expose (`getByLabel`,
  `getByRole`, the text a person reads). Nothing here adds a test hook to the
  app.
- One worker, no retries. The suite suspends a membership and switches schools,
  which are school-wide facts; parallel workers would watch each other's writes.
- Every test is under 30 seconds and self-contained: it signs in from scratch in
  a fresh browser context.
- The trace is kept on the first retry (`trace: 'on-first-retry'`), which with
  `retries: 0` means traces only appear when you ask with `--trace on`.
