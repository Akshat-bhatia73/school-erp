import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/timetable/substitutions')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Substitutions' }]} />
      <EmptyState icon={<Construction />} title="Substitutions" description="This screen is being built." />
    </>
  )
}
