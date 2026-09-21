import { Link } from '@tanstack/react-router'
import { CheckCircle2, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { TONE, tagColorForTone, type Tone } from '@/components/dashboard/blocks/card'
import { Tag } from '@/components/shared/tag'
import { Skeleton } from '@/components/ui/skeleton'
import { describeError } from '@/lib/api-errors'
import { cn } from '@/lib/utils'

export interface AttentionListItem {
  key: string
  count: number
  label: string
  /** One line saying where the row goes, e.g. "Open substitutions". */
  hint?: string
  icon?: ReactNode
  tone?: Tone
  to: string
  search?: Record<string, unknown>
}

/** Things that need a person. Rows with a zero count are not shown at all. */
export function AttentionList({ items, isLoading, error, allClearText = 'Nothing needs fixing today.' }: {
  items: AttentionListItem[]
  isLoading?: boolean
  error?: unknown
  allClearText?: string
}) {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-11 w-full rounded-lg" />)}
      </div>
    )
  }
  if (error) return <p className="text-[13.5px] text-muted-foreground">{describeError(error)}</p>

  const shown = items.filter((item) => item.count > 0)
  if (shown.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <span className={cn('inline-flex size-7 items-center justify-center rounded-md [&>svg]:size-4', TONE.green.badge)}>
          <CheckCircle2 />
        </span>
        <p className="mt-2 text-[13.5px] font-medium">All clear</p>
        <p className="mt-1 text-[12.5px] text-muted-foreground">{allClearText}</p>
      </div>
    )
  }
  return (
    <div className="flex flex-col divide-y">
      {shown.map((item) => {
        const tone = item.tone ?? 'orange'
        return (
          <Link
            key={item.key}
            to={item.to}
            search={item.search as never}
            className="flex min-h-11 items-center gap-3 rounded-md px-1 py-2 hover:bg-accent/60"
          >
            <span className={cn('inline-flex size-7 shrink-0 items-center justify-center rounded-md [&>svg]:size-4', TONE[tone].badge)}>
              {item.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block line-clamp-2 text-[13.5px] font-medium leading-snug">{item.label}</span>
              {item.hint && <span className="block truncate text-[12px] text-muted-foreground">{item.hint}</span>}
            </span>
            <Tag color={tagColorForTone(tone)}>{item.count}</Tag>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </Link>
        )
      })}
    </div>
  )
}
