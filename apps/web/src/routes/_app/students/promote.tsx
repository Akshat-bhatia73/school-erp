import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/students/promote')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Promote students' }]} />
      <EmptyState icon={<Construction />} title="Promote students" description="This screen is being built." />
    </>
  )
}
