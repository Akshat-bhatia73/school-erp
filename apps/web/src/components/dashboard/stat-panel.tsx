import type { ReactNode } from 'react'
import { Panel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/** One of the four number tiles at the top of the dashboard. */
export function StatPanel({ label, value, sub, tag, isLoading, className }: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tag?: string
  isLoading?: boolean
  className?: string
}) {
  return (
    <Panel className={cn('min-w-0', className)} bodyClassName="pt-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12.5px] text-muted-foreground">{label}</span>
        {tag && <Tag color="grey">{tag}</Tag>}
      </div>
      {isLoading ? (
        <>
          <Skeleton className="mt-2 h-7 w-24" />
          <Skeleton className="mt-2 h-3.5 w-32" />
        </>
      ) : (
        <>
          <div className="mt-1.5 text-2xl font-semibold tabular-nums leading-tight">{value}</div>
          {sub && <div className="mt-1 text-[12.5px] text-muted-foreground">{sub}</div>}
        </>
      )}
    </Panel>
  )
}
