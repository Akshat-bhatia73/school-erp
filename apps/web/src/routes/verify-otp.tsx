import { createFileRoute } from '@tanstack/react-router'
import { DEFAULT_RETURN_TO, sanitiseReturnTo } from '@/lib/return-to'
import { VerifyOtpScreen } from '@/components/auth/login/verify-otp-screen'
import { RedirectWhenSignedIn } from '@/components/auth/app-gate'

export const Route = createFileRoute('/verify-otp')({
  validateSearch: (search: Record<string, unknown>): { phone?: string; returnTo?: string; sharedDevice?: boolean } => ({
    // Only a normalised Indian mobile is accepted: the screen prints it back, so arbitrary text
    // here would be attacker-chosen copy on a public sign-in page.
    phone: typeof search.phone === 'string' && /^\+91[6-9]\d{9}$/.test(search.phone) ? search.phone : undefined,
    returnTo: search.returnTo === undefined ? undefined : sanitiseReturnTo(search.returnTo),
    sharedDevice: search.sharedDevice === true || search.sharedDevice === 'true' ? true : undefined,
  }),
  component: Page,
})

function Page() {
  const { phone, returnTo, sharedDevice } = Route.useSearch()
  return (
    <RedirectWhenSignedIn>
      <VerifyOtpScreen phone={phone} returnTo={returnTo ?? DEFAULT_RETURN_TO} sharedDevice={sharedDevice} />
    </RedirectWhenSignedIn>
  )
}
