import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/setup/subjects')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Subjects' }]} />
      <EmptyState icon={<Construction />} title="Subjects" description="This screen is being built." />
    </>
  )
}
