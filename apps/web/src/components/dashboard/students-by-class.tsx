import { LayoutGrid } from 'lucide-react'
import { EmptyState, Panel } from '@/components/shared/page'
import { Skeleton } from '@/components/ui/skeleton'
import { describeError } from '@/lib/api-errors'

export interface ClassStrengthRow { id: string; label: string; count: number }

/** Strength per section for the current year, from the server's authorized counts. */
export function StudentsByClass({ rows, isLoading, error }: { rows?: ClassStrengthRow[]; isLoading?: boolean; error?: unknown }) {
  const list = rows ?? []
  const max = Math.max(1, ...list.map((r) => r.count))

  return (
    <Panel title="Students by class" description="Ongoing enrolments in the current academic year">
      {isLoading ? (
        <div className="flex flex-col gap-2.5">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-5 w-full" />)}
        </div>
      ) : error ? (
        <p className="py-6 text-[13px] text-muted-foreground">{describeError(error)}</p>
      ) : list.length === 0 ? (
        <EmptyState icon={<LayoutGrid />} title="No classes yet" description="Create classes and sections to see strength per class." className="py-10" />
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((r) => (
            <div key={r.id} className="flex items-center gap-3">
              <span className="w-24 shrink-0 truncate text-[13px] text-muted-foreground">{r.label}</span>
              <span className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-tag-blue/70" style={{ width: `${(r.count / max) * 100}%` }} />
              </span>
              <span className="w-10 shrink-0 text-right text-[13px] font-medium tabular-nums">{r.count}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}
