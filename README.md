# School ERP

A modern school ERP for small Indian schools, with an AI assistant for staff. Product plan: [SCHOOL_ERP_PLAN.md](./SCHOOL_ERP_PLAN.md).

**Status:** the web app runs on the real backend. Everyone signs in; what each person sees is decided by the server, per school. There is no mock store and no role switcher.

## Run locally

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm typecheck
pnpm build
```

Requires Node 24.15+ (24.x) and pnpm 10 for the full workspace, including native TypeScript contract tests.

## Suites

Every database suite needs its own disposable database. Never point one at `erp`.

```bash
docker compose -f compose.db.yml up -d --wait
TEST_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp_test pnpm db:test:prepare

pnpm typecheck                 # every package
pnpm --filter @erp/web lint
pnpm test:contracts            # schemas, role defaults, operation coverage
pnpm test:db                   # tenant isolation and row-level security
pnpm test:authz                # permission decisions
pnpm test:api                  # protected routes
pnpm test:web                  # screens
pnpm test:security             # adversarial cases
pnpm test:browser              # session transitions in Chromium

pnpm build && ALLOW_PLACEHOLDER_API_ORIGIN=true pnpm check:assets
pnpm audit:deps
```

The API suite moves fixture access versions, so run `pnpm test:db` and `pnpm test:authz` on a freshly prepared database, before `pnpm test:api` or after re-preparing it.

`.github/workflows/ci.yml` runs all of it on every pull request and on `main`, against a `postgres:18.6` service with the same roles as `packages/db/docker-init`.

## API

`apps/api` is the backend the web app calls: authentication and sessions, access management, and the protected school APIs (Fastify + Better Auth + PostgreSQL).

```bash
docker compose -f compose.db.yml up -d --wait
MIGRATION_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp pnpm db:migrate
cp apps/api/.env.example apps/api/.env
pnpm dev:api      # http://127.0.0.1:3001

# The tests use their own disposable database, never the development one.
TEST_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp_test pnpm db:test:prepare
pnpm test:api
```

The `erp` database is for `pnpm dev:api`, `pnpm db:fixtures` and `pnpm --filter @erp/api dev:logins` only. Every test suite reads `TEST_DATABASE_URL` and must point at a disposable database such as `erp_test`; the API harness refuses to run against `erp`. Set `ERP_TEST_DB` to run one module's file against a private migrated copy.

Environment variables, credential boundaries, endpoints, session limits, MFA rules and rate limits are documented in [authentication and sessions](docs/auth/AUTHENTICATION.md). What a signed-in member may then read or write is decided by `packages/authz` and documented in [authorization and access scope](docs/auth/AUTHORIZATION.md). Members, invitations, role changes and ownership transfer are documented in [access management](docs/auth/ACCESS_MANAGEMENT.md). The school APIs a signed-in member then calls — setup, students, staff, timetable, dashboard, search, audit and document download — are documented in [protected school APIs](docs/auth/PROTECTED_APIS.md).

## Deploy

The site is a static build on Vercel; the API is a container built from `apps/api/Dockerfile`. `vercel.json` rewrites `/api/*` to the API before the single-page catch-all, so the session cookie stays same-origin. Replace `REPLACE-WITH-YOUR-DOMAIN` in that file with the real API host. The runbook, environment variables and release checklist are in [release](docs/auth/RELEASE.md).

## Layout

- `apps/web` — React 19 + Vite + TanStack Router/Query + Tailwind v4 + shadcn/ui
- `apps/api` — authentication and session service, access management and the protected school APIs; see [authentication and sessions](docs/auth/AUTHENTICATION.md), [access management](docs/auth/ACCESS_MANAGEMENT.md) and [protected school APIs](docs/auth/PROTECTED_APIS.md)
- `packages/db` — PostgreSQL schema, tenant isolation and database tests; see [database setup](docs/auth/DATABASE.md)
- `packages/authz` — permission policy service: decisions, relationship scope, list predicates and the access version protocol; see [authorization and access scope](docs/auth/AUTHORIZATION.md)
- `packages/contracts` — auth/RBAC permission catalogue, fixed roles, strict API schemas and server interfaces
- `packages/shared` — data models (Zod schemas and TypeScript types), shared by web, the future backend and the mobile app
- `apps/web/src/lib/api` — the HTTP client for the protected APIs, one file per backend module
- `tests/security`, `tests/browser` — adversarial API tests and Playwright session tests

Conventions for contributors and coding agents are in [CLAUDE.md](./CLAUDE.md).
