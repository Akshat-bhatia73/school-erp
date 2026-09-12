import { createFileRoute } from '@tanstack/react-router'
import { LayoutDashboard } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/dashboard')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Dashboard', icon: <LayoutDashboard /> }]} />
      <EmptyState icon={<LayoutDashboard />} title="Dashboard" description="To be built." />
    </>
  )
}
