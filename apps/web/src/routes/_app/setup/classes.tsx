import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/setup/classes')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Classes & sections' }]} />
      <EmptyState icon={<Construction />} title="Classes & sections" description="This screen is being built." />
    </>
  )
}
