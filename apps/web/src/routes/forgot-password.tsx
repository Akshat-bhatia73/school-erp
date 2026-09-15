import { createFileRoute } from '@tanstack/react-router'
import { ForgotPasswordScreen } from '@/components/auth/login/forgot-password-screen'
import { RedirectWhenSignedIn } from '@/components/auth/app-gate'

export const Route = createFileRoute('/forgot-password')({ component: Page })

function Page() {
  return (
    <RedirectWhenSignedIn>
      <ForgotPasswordScreen />
    </RedirectWhenSignedIn>
  )
}
