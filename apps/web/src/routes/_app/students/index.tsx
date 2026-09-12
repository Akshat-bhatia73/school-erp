import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/students/')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Students' }]} />
      <EmptyState icon={<Construction />} title="Students" description="This screen is being built." />
    </>
  )
}
