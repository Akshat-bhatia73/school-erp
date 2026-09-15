import { useQuery } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { authConfig } from '@/lib/auth-client'
import { qk } from '@/lib/query'
import { cn } from '@/lib/utils'

/**
 * The frame every public auth screen sits in. Full-bleed on a phone, a calm centred card from
 * the `md` breakpoint up.
 */
export function AuthLayout({ title, description, children, footer, wide }: {
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-start bg-background px-4 py-6 md:justify-center md:py-10">
      <div className={cn('w-full', wide ? 'max-w-lg' : 'max-w-sm')}>
        <div className="mb-5 flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground text-background"><Sparkles className="size-4" /></span>
          <span className="text-[14px] font-semibold">School ERP</span>
        </div>
        <div className="border-0 bg-transparent p-0 md:rounded-xl md:border md:bg-card md:p-6">
          <h1 className="text-[15px] font-semibold">{title}</h1>
          {description && <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>}
          <div className="mt-4">{children}</div>
        </div>
        {footer && <div className="mt-4 pb-[env(safe-area-inset-bottom)] text-[13px] text-muted-foreground">{footer}</div>}
      </div>
    </div>
  )
}

/** Says plainly that nothing is sent in a development build, so nobody waits for an SMS. */
export function SandboxNotice() {
  const { data } = useQuery({ queryKey: qk.authConfig, queryFn: authConfig, staleTime: 5 * 60_000 })
  if (data?.deliveryMode !== 'sandbox') return null
  return (
    <Alert className="mb-4">
      <AlertDescription>
        This is a development build. No message is sent; codes are read from the development outbox.
      </AlertDescription>
    </Alert>
  )
}
