import { QueryClientProvider } from '@tanstack/react-query'
import { createRootRoute, Outlet } from '@tanstack/react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { queryClient } from '@/lib/query'
import { SessionProvider } from '@/lib/session'
import { ThemeProvider } from '@/lib/theme'

export const Route = createRootRoute({
  component: () => (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <TooltipProvider delayDuration={300}>
            <Outlet />
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </SessionProvider>
      </QueryClientProvider>
    </ThemeProvider>
  ),
})
