import { ChevronDown } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

/**
 * Mobile stand-in for an in-page picker column (the teacher list, the class list).
 * A full-width bar shows what is selected and opens the same list in a bottom sheet,
 * so a 288px column does not eat a 390px screen.
 */
export function MobilePicker({ label, value, title, children, className }: {
  label: string
  /** Current selection, shown on the bar */
  value?: ReactNode
  /** Sheet heading */
  title?: string
  /** The picker list. Receives `close` so a choice dismisses the sheet. */
  children: (close: () => void) => ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={cn('md:hidden', className)}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-12 w-full items-center justify-between gap-2 border-b bg-card px-3 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:-outline-offset-2"
      >
        <span className="min-w-0">
          <span className="block text-[11.5px] text-muted-foreground">{label}</span>
          <span className="block truncate text-[13.5px] font-medium">{value ?? 'Choose'}</span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[80dvh] gap-0 p-0">
          <SheetTitle className="shrink-0 border-b px-4 py-3 text-[14px] font-semibold">{title ?? label}</SheetTitle>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{children(() => setOpen(false))}</div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
