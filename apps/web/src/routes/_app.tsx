import { createFileRoute } from '@tanstack/react-router'
import { AppShell } from '@/components/layout/app-shell'

/** Pathless layout route: everything under it renders inside the app shell */
export const Route = createFileRoute('/_app')({ component: AppShell })
