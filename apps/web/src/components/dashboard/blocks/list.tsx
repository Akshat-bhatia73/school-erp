import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { calendarParts } from '@/components/dashboard/format'
import { TONE, type Tone } from '@/components/dashboard/blocks/card'
import { cn } from '@/lib/utils'

export interface SimpleListItem {
  key: string
  /** An avatar, a calendar tile or an icon badge at the left of the row. */
  leading?: ReactNode
  primary: ReactNode
  secondary?: ReactNode
  right?: ReactNode
  to?: string
  search?: Record<string, unknown>
}

/** Hairline rows. A row with `to` is a link. */
export function SimpleList({ items, className }: { items: SimpleListItem[]; className?: string }) {
  return (
    <div className={cn('flex flex-col divide-y', className)}>
      {items.map((item) => {
        const body = (
          <>
            {item.leading && <span className="shrink-0">{item.leading}</span>}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{item.primary}</span>
              {item.secondary && <span className="block truncate text-[12px] text-muted-foreground">{item.secondary}</span>}
            </span>
            {item.right && <span className="shrink-0 text-[12.5px] tabular-nums text-muted-foreground">{item.right}</span>}
          </>
        )
        if (item.to) {
          return (
            <Link key={item.key} to={item.to} search={item.search as never} className="-mx-2 flex min-h-11 items-center gap-3 rounded-md px-2 py-1.5 text-[13.5px] hover:bg-accent/60">
              {body}
            </Link>
          )
        }
        return <div key={item.key} className="flex min-h-11 items-center gap-3 py-1.5 text-[13.5px]">{body}</div>
      })}
    </div>
  )
}

/** A little date block for a holiday or an event row. */
export function CalendarTile({ date, tone, className }: { date: string; tone?: Tone; className?: string }) {
  const { day, month } = calendarParts(date)
  return (
    <span className={cn('inline-flex size-9 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg', tone ? TONE[tone].badge : 'border bg-muted/40', className)}>
      <span className="text-[13px] font-semibold leading-none">{day}</span>
      <span className={cn('text-[9.5px] uppercase leading-none tracking-wide', !tone && 'text-muted-foreground')}>{month}</span>
    </span>
  )
}
