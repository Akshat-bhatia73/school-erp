import { createFileRoute } from '@tanstack/react-router'
import { DEFAULT_RETURN_TO, sanitiseReturnTo } from '@/lib/return-to'
import { AuthLayout } from '@/components/auth/auth-layout'
import { RedirectWhenSignedIn } from '@/components/auth/app-gate'
import { MfaSetupPanel } from '@/components/auth/mfa/setup-panel'

export const Route = createFileRoute('/mfa/setup')({
  validateSearch: (search: Record<string, unknown>): { returnTo?: string } => ({ returnTo: search.returnTo === undefined ? undefined : sanitiseReturnTo(search.returnTo) }),
  component: Page,
})

function Page() {
  const { returnTo } = Route.useSearch()
  const panel = (
    <AuthLayout title="Set up your second step" description="Your role needs an authenticator app as well as a password.">
      <MfaSetupPanel returnTo={returnTo ?? DEFAULT_RETURN_TO} />
    </AuthLayout>
  )
  // Same rule as the verify step: a typed address goes back to the app, a link from account
  // security opens enrolment so a signed-in person can add an authenticator.
  return returnTo ? panel : <RedirectWhenSignedIn>{panel}</RedirectWhenSignedIn>
}
