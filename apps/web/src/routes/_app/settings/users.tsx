import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/settings/users')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Users & logins' }]} />
      <EmptyState icon={<Construction />} title="Users & logins" description="This screen is being built." />
    </>
  )
}
