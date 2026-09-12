import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/students/import')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Import students' }]} />
      <EmptyState icon={<Construction />} title="Import students" description="This screen is being built." />
    </>
  )
}
