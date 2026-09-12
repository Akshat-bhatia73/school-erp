import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/setup/holidays')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Holidays' }]} />
      <EmptyState icon={<Construction />} title="Holidays" description="This screen is being built." />
    </>
  )
}
