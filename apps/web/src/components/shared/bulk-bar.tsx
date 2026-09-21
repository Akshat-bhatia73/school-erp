import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'

/**
 * The floating bar every list screen shows while rows are selected: how many are selected, the
 * bulk actions, and a way to clear the selection. `status` is the line under the row, used by an
 * export to say what is happening to the file.
 */
export function BulkBar({ count, onClear, children, status }: {
  count: number
  onClear: () => void
  children?: ReactNode
  status?: ReactNode
}) {
  if (count === 0) return null

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-14 z-20 flex justify-center px-3">
      <div className="pointer-events-auto flex max-w-full flex-col gap-1 rounded-xl border bg-card p-1.5 shadow-lg">
        <div className="flex items-center gap-1">
          <span className="px-2 text-[13px] tabular-nums text-muted-foreground">{count} selected</span>
          {children}
          <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={onClear}><X /></Button>
        </div>
        {status}
      </div>
    </div>
  )
}
