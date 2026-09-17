import { createFileRoute } from '@tanstack/react-router'
import { RedirectOnce } from '@/components/auth/app-gate'
import { Skeleton } from '@/components/ui/skeleton'
import { useSession } from '@/lib/session'

/** A component, not a `beforeLoad` redirect, so the decision waits for the session bootstrap. */
export const Route = createFileRoute('/')({ component: Page })

function Page() {
  const { status } = useSession()
  if (status === 'loading') {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background p-8">
        <Skeleton className="h-24 w-full max-w-sm rounded-xl" />
      </div>
    )
  }
  if (status === 'anonymous') return <RedirectOnce to="/login" />
  if (status === 'blocked') return <RedirectOnce to="/access-unavailable" search={{ reason: 'student' }} />
  return <RedirectOnce to="/dashboard" />
}
