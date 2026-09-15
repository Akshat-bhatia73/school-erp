import { createFileRoute } from '@tanstack/react-router'
import { sanitiseReturnTo } from '@/lib/return-to'
import { AuthLayout } from '@/components/auth/auth-layout'
import { SchoolChooser } from '@/components/auth/school/school-chooser'

export const Route = createFileRoute('/select-school')({
  validateSearch: (search: Record<string, unknown>): { returnTo?: string } => ({ returnTo: search.returnTo === undefined ? undefined : sanitiseReturnTo(search.returnTo) }),
  component: Page,
})

function Page() {
  const { returnTo } = Route.useSearch()
  return (
    <AuthLayout title="Choose a school" description="Pick the school you want to work in. You can switch again from your account menu.">
      <SchoolChooser returnTo={returnTo} />
    </AuthLayout>
  )
}
