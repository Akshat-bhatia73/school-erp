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

Requires Node 20+ and pnpm 10.

## Deploy on Vercel

Import the GitHub repo in Vercel. `vercel.json` at the repo root already sets the install and build commands and the SPA rewrite, so leave **Root Directory** as the repo root and **Framework Preset** as Other. Nothing else to configure; there are no environment variables yet.

## Layout

- `apps/web` — React 19 + Vite + TanStack Router/Query + Tailwind v4 + shadcn/ui
- `packages/shared` — data models (Zod schemas and TypeScript types), shared by web, the future backend and the mobile app
- `apps/web/src/api` — in-memory mock API and seeded dummy data for two schools. Same function shapes the real backend will expose.

Conventions for contributors and coding agents are in [CLAUDE.md](./CLAUDE.md).
