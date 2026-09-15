# School ERP

A modern school ERP for small Indian schools, with an AI assistant for staff. Product plan: [SCHOOL_ERP_PLAN.md](./SCHOOL_ERP_PLAN.md).

**Status:** Phase 1 web app with dummy data. No backend or login yet. Use the "Viewing as" switcher at the bottom of the sidebar to see the app as different roles, and the school switcher at the top to change school.

## Run locally

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm typecheck
pnpm build
```

Requires Node 24.15+ (24.x) and pnpm 10 for the full workspace, including native TypeScript contract tests.

Auth/RBAC Task 0 is defined in [the contract handover](docs/auth/CONTRACTS.md). Run `pnpm test:contracts` to check schemas, role defaults, and operation coverage. These contracts do not yet protect the mock application.

## API

`apps/api` is the authentication and session service (Fastify + Better Auth + PostgreSQL). It is not wired to the web app yet.

```bash
docker compose -f compose.db.yml up -d --wait
MIGRATION_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp pnpm db:migrate
cp apps/api/.env.example apps/api/.env
pnpm dev:api      # http://127.0.0.1:3001
pnpm test:api
```

Environment variables, credential boundaries, endpoints, session limits, MFA rules and rate limits are documented in [authentication and sessions](docs/auth/AUTHENTICATION.md).

## Deploy on Vercel

Import the GitHub repo in Vercel. `vercel.json` at the repo root already sets the install and build commands and the SPA rewrite, so leave **Root Directory** as the repo root and **Framework Preset** as Other. Nothing else to configure; there are no environment variables yet.

## Layout

- `apps/web` — React 19 + Vite + TanStack Router/Query + Tailwind v4 + shadcn/ui
- `apps/api` — authentication and session service; see [authentication and sessions](docs/auth/AUTHENTICATION.md)
- `packages/db` — PostgreSQL schema, tenant isolation and database tests; see [database setup](docs/auth/DATABASE.md)
- `packages/contracts` — auth/RBAC permission catalogue, fixed roles, strict API schemas and server interfaces
- `packages/shared` — data models (Zod schemas and TypeScript types), shared by web, the future backend and the mobile app
- `apps/web/src/api` — in-memory mock API and seeded dummy data for two schools. Same function shapes the real backend will expose.

Conventions for contributors and coding agents are in [CLAUDE.md](./CLAUDE.md).
