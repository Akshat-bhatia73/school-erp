import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/setup/academic-years')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Academic years' }]} />
      <EmptyState icon={<Construction />} title="Academic years" description="This screen is being built." />
    </>
  )
}
