import { createFileRoute } from '@tanstack/react-router'
import { ResetPasswordScreen } from '@/components/auth/login/reset-password-screen'
import { RedirectWhenSignedIn } from '@/components/auth/app-gate'

export const Route = createFileRoute('/reset-password')({
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({ token: typeof search.token === 'string' ? search.token : undefined }),
  component: Page,
})

function Page() {
  const { token } = Route.useSearch()
  return (
    <RedirectWhenSignedIn>
      <ResetPasswordScreen token={token} />
    </RedirectWhenSignedIn>
  )
}
