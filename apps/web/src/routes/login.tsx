import { createFileRoute } from '@tanstack/react-router'
import { DEFAULT_RETURN_TO, sanitiseReturnTo } from '@/lib/return-to'
import { LoginScreen } from '@/components/auth/login/login-screen'
import { RedirectWhenSignedIn } from '@/components/auth/app-gate'

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { returnTo?: string; audience?: 'administration' | 'teacher' | 'parent' } => ({
    returnTo: search.returnTo === undefined ? undefined : sanitiseReturnTo(search.returnTo),
    audience: search.audience === 'administration' || search.audience === 'teacher' || search.audience === 'parent' ? search.audience : undefined,
  }),
  component: Page,
})

function Page() {
  const { returnTo, audience } = Route.useSearch()
  return (
    <RedirectWhenSignedIn>
      <LoginScreen returnTo={returnTo ?? DEFAULT_RETURN_TO} audience={audience} />
    </RedirectWhenSignedIn>
  )
}
