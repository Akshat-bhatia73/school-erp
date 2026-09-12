import { EmptyState, Panel } from '@/components/shared/page'
import { Skeleton } from '@/components/ui/skeleton'
import { LayoutGrid } from 'lucide-react'
import type { DashboardSummary } from '@erp/shared'

type Students = DashboardSummary['students']

/** Horizontal bar list of strength per grade, with a gender split bar underneath. */
export function StudentsByClass({ students, isLoading }: { students?: Students; isLoading?: boolean }) {
  const rows = students?.byGrade ?? []
  const max = Math.max(1, ...rows.map((r) => r.count))
  const g = students?.byGender
  const total = Math.max(1, (g?.male ?? 0) + (g?.female ?? 0) + (g?.other ?? 0))

  return (
    <Panel title="Students by class" description="Ongoing enrolments in the current academic year">
      {isLoading ? (
        <div className="flex flex-col gap-2.5">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-5 w-full" />)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<LayoutGrid />} title="No classes yet" description="Create classes and sections to see strength per class." className="py-10" />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => (
            <div key={r.gradeId} className="flex items-center gap-3">
              <span className="w-24 shrink-0 truncate text-[13px] text-muted-foreground">{r.gradeName}</span>
              <span className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-tag-blue/70" style={{ width: `${(r.count / max) * 100}%` }} />
              </span>
              <span className="w-10 shrink-0 text-right text-[13px] font-medium tabular-nums">{r.count}</span>
            </div>
          ))}
        </div>
      )}

      {!isLoading && rows.length > 0 && (
      <div className="mt-5 border-t pt-3.5">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium tracking-wide text-muted-foreground">Gender split</span>
          <span className="flex items-center gap-3 text-[12px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-tag-blue/70" />Boys {g?.male ?? 0}</span>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-tag-pink/70" />Girls {g?.female ?? 0}</span>
            {!!g?.other && <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-tag-purple/70" />Other {g.other}</span>}
          </span>
        </div>
        <div className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
          <span className="h-full bg-tag-blue/70" style={{ width: `${((g?.male ?? 0) / total) * 100}%` }} />
          <span className="h-full bg-tag-pink/70" style={{ width: `${((g?.female ?? 0) / total) * 100}%` }} />
          <span className="h-full bg-tag-purple/70" style={{ width: `${((g?.other ?? 0) / total) * 100}%` }} />
        </div>
      </div>
      )}
    </Panel>
  )
}
