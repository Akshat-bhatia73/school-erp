import { createFileRoute } from '@tanstack/react-router'
import { SecurityScreen } from '@/components/auth/account/security-screen'

export const Route = createFileRoute('/account/security')({ component: Page })

function Page() {
  return <SecurityScreen />
}
