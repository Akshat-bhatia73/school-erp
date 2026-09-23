/** Every stored row of one cell, oldest first, opened from the small marker on a changed mark. */
import { useQuery } from '@tanstack/react-query'
import type { ExamComponent } from '@erp/contracts'
import { History } from 'lucide-react'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { formatDate } from '@/lib/utils'
import { componentLabel, markText } from './labels'
import { REASON_KIND_LABELS } from './reason-dialog'

export function MarkHistory({ paperId, studentId, component }: { paperId: string; studentId: string; component: ExamComponent }) {
  const { schoolId } = useSchoolContext()
  const [open, setOpen] = useState(false)
  const historyQuery = useQuery({
    queryKey: qk.examMarkHistory(schoolId, paperId, studentId, component),
    queryFn: () => api.exams.history(schoolId, paperId, studentId, { component }),
    enabled: open,
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Show the history of this mark" className="inline-flex size-5 shrink-0 items-center justify-center rounded text-tag-orange hover:bg-accent">
          <History className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <p className="mb-2 text-[13px] font-medium">{componentLabel(component)}{historyQuery.data ? ` · ${historyQuery.data.student.name}` : ''}</p>
        {historyQuery.isError ? (
          <p className="text-[12.5px] text-muted-foreground">{describeError(historyQuery.error)}</p>
        ) : !historyQuery.data ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <ol className="space-y-1.5">
            {historyQuery.data.rows.map((row) => (
              <li key={row.id} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                <span className="font-medium tabular-nums">{markText(row.value)}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {row.kind === 'correction' ? 'Correction' : row.revision === 1 ? 'Entered' : 'Changed'}
                  {row.reasonKind ? ` · ${REASON_KIND_LABELS[row.reasonKind]}` : ''}
                  {row.recordedBy ? ` · ${row.recordedBy}` : ''}
                </span>
                <span className="shrink-0 text-muted-foreground">{formatDate(row.recordedAt)}</span>
              </li>
            ))}
          </ol>
        )}
      </PopoverContent>
    </Popover>
  )
}
