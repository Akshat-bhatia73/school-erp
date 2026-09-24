import { createFileRoute } from '@tanstack/react-router'
import { sanitiseReturnTo } from '@/lib/return-to'
import { ChangePasswordScreen } from '@/components/auth/account/change-password-screen'

export const Route = createFileRoute('/account/change-password')({
  validateSearch: (search: Record<string, unknown>): { returnTo?: string } => ({
    returnTo: search.returnTo === undefined ? undefined : sanitiseReturnTo(search.returnTo),
  }),
  component: Page,
})

function Page() {
  const { returnTo } = Route.useSearch()
  return <ChangePasswordScreen returnTo={returnTo} />
}
