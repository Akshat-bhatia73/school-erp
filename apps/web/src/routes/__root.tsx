import { createRootRoute, Outlet } from '@tanstack/react-router'
import { AccessUnavailable } from '@/components/auth/school/access-unavailable'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { SessionProvider } from '@/lib/session'
import { ThemeProvider } from '@/lib/theme'

/** `SessionProvider` owns the QueryClient: one per context generation, so a school or sign-in change takes the cache with it. */
export const Route = createRootRoute({
  // An unknown path gets the same calm screen as every other "you cannot open this" answer,
  // inside the providers so it can offer the right actions for who is signed in.
  notFoundComponent: () => <AccessUnavailable reason="not_found" />,
  component: () => (
    <ThemeProvider>
      <SessionProvider>
        <TooltipProvider delayDuration={300}>
          <Outlet />
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </SessionProvider>
    </ThemeProvider>
  ),
})
