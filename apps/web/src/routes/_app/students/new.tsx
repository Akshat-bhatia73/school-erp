import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/students/new')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Admit student' }]} />
      <EmptyState icon={<Construction />} title="Admit student" description="This screen is being built." />
    </>
  )
}
