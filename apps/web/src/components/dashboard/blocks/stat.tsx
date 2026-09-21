import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { TONE, type Tone } from '@/components/dashboard/blocks/card'
import { cn } from '@/lib/utils'

export interface StatTileProps {
  label: string
  value: ReactNode
  hint?: string
  tone?: Tone
  icon?: ReactNode
  /** When set the whole tile is a link. */
  to?: string
  /** 'sm' is the tighter tile for a four-up row in a short card. */
  size?: 'md' | 'sm'
  className?: string
}

/** One number, plain card, one tinted badge. */
export function StatTile({ label, value, hint, tone = 'plain', icon, to, size = 'md', className }: StatTileProps) {
  const small = size === 'sm'
  const body = (
    <>
      <div className="flex items-start gap-2">
        {icon && (
          <span className={cn('inline-flex size-6 shrink-0 items-center justify-center rounded-md [&>svg]:size-3.5', TONE[tone].badge)}>
            {icon}
          </span>
        )}
        <span className="min-w-0 flex-1 text-[12px] leading-snug text-muted-foreground">{label}</span>
      </div>
      <p className={cn('mt-1.5 font-semibold leading-none tabular-nums', small ? 'text-[20px]' : 'text-[22px]')}>{value}</p>
      {hint && <p className="mt-1 text-[12px] leading-snug text-muted-foreground">{hint}</p>}
    </>
  )
  const classes = cn('block min-w-0 rounded-lg border bg-card p-3', to && 'hover:bg-accent', className)
  if (to) return <Link to={to} className={classes}>{body}</Link>
  return <div className={classes}>{body}</div>
}

const COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-2 lg:grid-cols-4',
}

/** Tiles two across, or `cols={4}` for four across above lg. */
export function StatRow({ children, cols = 2, className }: { children: ReactNode; cols?: number; className?: string }) {
  return <div className={cn('grid gap-3', COLS[cols] ?? COLS[2], className)}>{children}</div>
}
