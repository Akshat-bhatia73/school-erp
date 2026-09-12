import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/setup/school')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'School profile' }]} />
      <EmptyState icon={<Construction />} title="School profile" description="This screen is being built." />
    </>
  )
}
