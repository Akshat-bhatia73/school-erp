import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/settings/audit-log')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Audit log' }]} />
      <EmptyState icon={<Construction />} title="Audit log" description="This screen is being built." />
    </>
  )
}
