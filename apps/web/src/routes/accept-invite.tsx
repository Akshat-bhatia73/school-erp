import { createFileRoute } from '@tanstack/react-router'
import { AuthLayout } from '@/components/auth/auth-layout'
import { AcceptInvitePanel } from '@/components/auth/school/accept-invite-panel'

export const Route = createFileRoute('/accept-invite')({
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({ token: typeof search.token === 'string' ? search.token : undefined }),
  component: Page,
})

function Page() {
  const { token } = Route.useSearch()
  return (
    <AuthLayout title="Accept your invitation" description="Your school has invited you. Accepting adds this school to your account.">
      <AcceptInvitePanel token={token} />
    </AuthLayout>
  )
}
