# School ERP — repo guide

Monorepo (pnpm). Phase 1 web app with dummy data. No backend yet: `apps/web/src/api/client.ts` is an in-memory mock with the same shape the real API will have.

## Layout
- `packages/contracts/src/*` — new auth/RBAC and HTTP boundary contracts. Use `@erp/contracts` for new backend/frontend integration; `@erp/shared/contracts` is an explicit compatibility bridge. Server-only interfaces are at `@erp/contracts/server`. Do not use the legacy mock `UserInput` or role resolver for backend authorization. See `docs/auth/CONTRACTS.md` and `PERMISSION_MATRIX.md`.
- `packages/shared/src/*` — data models (Zod schemas + TS types). Source of truth. Extend here if a screen needs a field that is missing.
- `apps/web/src/api/seed.ts` — deterministic dummy data for two Indian schools (SVM, LFPS).
- `apps/web/src/api/client.ts` — mock API: `api.students.list(...)`, `api.staff.get(id)`, etc. All async. Mutations write audit rows.
- `apps/web/src/lib/query.ts` — `queryClient` and `qk` query keys. Always use `qk.*` keys and invalidate them after mutations.
- `apps/web/src/lib/session.tsx` — `useSession()` gives `{ school, user, roles, can(module, action), scope(module) }`. Auth is skipped; a "viewing as" switcher picks the user.
- `apps/web/src/components/ui/*` — shadcn primitives (button, input, select, dialog, sheet, dropdown-menu, tabs, table, tooltip, checkbox, switch, textarea, command, popover, skeleton, badge, alert, alert-dialog, progress, radio-group, scroll-area, separator, avatar, label, sonner).
- `apps/web/src/components/shared/*` — app-level building blocks. USE THESE, do not reinvent:
  - `page.tsx`: `PageHeader` (breadcrumb + actions), `Toolbar` (filter row), `PageTabs`, `Panel`, `Facts` (label/value grid), `EmptyState`, `SectionLabel`
  - `data-table.tsx`: `DataTable` (TanStack Table wrapper: checkbox column, sortable headers, skeleton loading, footer summary, pagination) and `EntityCell` (icon + dotted-underline name)
  - `filter-chip.tsx`: `FilterChip` (label + value dropdown chip), `ToolbarButton` (dashed-border button)
  - `tag.tsx`: `Tag` (outline pill, `color` prop), `colorFor(key)` stable colour, `StatusDot`
  - `avatar.tsx`: `UserAvatar`
- `apps/web/src/routes/**` — TanStack Router file routes. `_app/` is the shell layout. Route tree is generated; do not edit `routeTree.gen.ts`.

## Conventions
- TypeScript strict. `pnpm --filter @erp/web typecheck` must pass. Unused imports/vars are errors.
- Tailwind v4 with the tokens in `styles.css`. Use semantic classes: `bg-card`, `text-muted-foreground`, `border`, `bg-accent`. Never hardcode hex colours.
- Design: dense, calm, hairline borders, 12px radius, 13.5px base text. Match the reference: breadcrumb header, filter chips row, data table with checkbox column and column dividers, outline pill tags, footer summary bar. Light theme first; dark must not break (only semantic tokens).
- Every list screen: `PageHeader` → `Toolbar` with `FilterChip`s + search `Input` → `DataTable` with `footer` ("N students in view") → row click navigates to detail.
- Every detail screen: `PageHeader` with breadcrumb back to list; header block with avatar/name/tags; `PageTabs` or `Panel`s with `Facts`.
- Forms: `Sheet` (side panel) for quick add/edit, full page for long forms (admit student). Validate with the Zod schemas from `@erp/shared`. Show errors inline. `toast.success(...)` from `sonner` on save. Invalidate queries.
- Data fetching: `useQuery({ queryKey: qk.x(...), queryFn: () => api.x.list(...) })`. `useMutation` + `queryClient.invalidateQueries`.
- Permissions: hide/disable actions with `useSession().can('students', 'edit')`. Salary fields only when `can('staff','edit')` and role is owner/accountant.
- Indian formats: `formatINR`, `formatDate` from `lib/utils.ts`. Phone is 10 digits. Academic year is April–March.
- Dates: keep ISO strings in state, format only for display.
- Copy: plain English, no jargon. "Fee dues" not "receivables". Buttons say what they do: "Admit student", "Save changes".
- Icons: lucide-react only.
- Routes must keep the same file paths and `createFileRoute` ids already present; add new routes only under your module's folder.
