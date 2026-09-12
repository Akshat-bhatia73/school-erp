import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/students/$studentId')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Student' }]} />
      <EmptyState icon={<Construction />} title="Student" description="This screen is being built." />
    </>
  )
}
