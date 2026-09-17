import { createFileRoute } from '@tanstack/react-router'
import { AppGate } from '@/components/auth/app-gate'
import { AppShell } from '@/components/layout/app-shell'

/** Pathless layout route: everything under it is signed-in, school-scoped app. */
export const Route = createFileRoute('/_app')({
  component: () => (
    <AppGate>
      <AppShell />
    </AppGate>
  ),
})
