import { createFileRoute } from '@tanstack/react-router'
import { SecondStepMethod } from '@erp/contracts'
import { DEFAULT_RETURN_TO, sanitiseReturnTo } from '@/lib/return-to'
import { AuthLayout } from '@/components/auth/auth-layout'
import { RedirectWhenSignedIn } from '@/components/auth/app-gate'
import { MfaVerifyPanel } from '@/components/auth/mfa/verify-panel'

export const Route = createFileRoute('/mfa/verify')({
  validateSearch: (search: Record<string, unknown>): { returnTo?: string; sharedDevice?: boolean; method?: SecondStepMethod; to?: string } => ({
    returnTo: search.returnTo === undefined ? undefined : sanitiseReturnTo(search.returnTo),
    // Carried over from the sign-in screen: a password sign-in that asks for a second step has no
    // session yet, so the choice cannot be stored on the server until this step completes.
    sharedDevice: search.sharedDevice === true || search.sharedDevice === 'true' ? true : undefined,
    // Also from the sign-in answer: the step this person chose and the mostly hidden place a code
    // goes. Only words on screen; the server decides which step it accepts.
    method: SecondStepMethod.safeParse(search.method).data,
    to: typeof search.to === 'string' && search.to.length <= 200 ? search.to : undefined,
  }),
  component: Page,
})

function Page() {
  const { returnTo, sharedDevice, method, to } = Route.useSearch()
  const panel = (
    <AuthLayout title="Confirm your second step" description="Enter the 6 digit code for your second step.">
      <MfaVerifyPanel returnTo={returnTo ?? DEFAULT_RETURN_TO} sharedDevice={sharedDevice} method={method} destination={to} />
    </AuthLayout>
  )
  // Somebody already all the way into a school has nothing to do here, so a typed address goes
  // back to the app. A link from account security carries where to return to, and that is a
  // deliberate second step — refreshing it is how a privileged change gets approved.
  return returnTo ? panel : <RedirectWhenSignedIn>{panel}</RedirectWhenSignedIn>
}
