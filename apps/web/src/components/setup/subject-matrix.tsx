import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { Grade, Subject } from '@erp/shared'
import { api } from '@/api/client'
import { EmptyState } from '@/components/shared/page'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { qk } from '@/lib/query'

/** Grades (rows) x subjects (columns) checkbox matrix for one academic year. */
export function SubjectMatrix({ academicYearId, grades, subjects, canEdit, isLoading }: {
  academicYearId: string
  grades: Grade[]
  subjects: Subject[]
  canEdit: boolean
  isLoading?: boolean
}) {
  const qc = useQueryClient()
  const { data: links = [], isLoading: linksLoading } = useQuery({
    queryKey: qk.gradeSubjects({ academicYearId }),
    queryFn: () => api.subjects.gradeSubjects({ academicYearId }),
    enabled: !!academicYearId,
  })

  const byGrade = useMemo(() => {
    const out = new Map<string, Set<string>>()
    for (const l of links) {
      if (!out.has(l.gradeId)) out.set(l.gradeId, new Set())
      out.get(l.gradeId)!.add(l.subjectId)
    }
    return out
  }, [links])

  const setSubjects = useMutation({
    mutationFn: (p: { gradeId: string; subjectIds: string[] }) => api.subjects.setGradeSubjects({ academicYearId, ...p }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['gradeSubjects'] }); toast.success('Subjects updated') },
    onError: (e: Error) => toast.error(e.message),
  })

  function toggle(gradeId: string, subjectId: string, on: boolean) {
    const next = new Set(byGrade.get(gradeId) ?? [])
    if (on) next.add(subjectId)
    else next.delete(subjectId)
    setSubjects.mutate({ gradeId, subjectIds: [...next] })
  }

  if (isLoading || linksLoading) return <div className="grid gap-2 p-5">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-9 rounded-lg" />)}</div>
  if (!grades.length || !subjects.length) return <EmptyState title="Nothing to map yet" description="Add classes and subjects first." />

  return (
    <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
      <table className="border-separate border-spacing-0 text-[13.5px]">
        <thead className="sticky top-0 z-20">
          <tr>
            <th className="sticky left-0 z-30 h-11 w-44 border-r border-b bg-card px-3 text-left font-medium text-muted-foreground">Class</th>
            {subjects.map((s) => (
              <th key={s.id} title={s.name} className="h-11 w-16 border-b border-l bg-card px-2 text-center font-mono text-[12px] font-medium text-muted-foreground">{s.code}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grades.map((g) => {
            const set = byGrade.get(g.id) ?? new Set<string>()
            return (
              <tr key={g.id} className="hover:bg-accent/40">
                <td className="sticky left-0 z-10 h-10 w-44 border-r border-b bg-card px-3 font-medium">
                  {g.name}
                  <span className="ml-2 text-[12px] font-normal text-muted-foreground tabular-nums">{set.size}</span>
                </td>
                {subjects.map((s) => (
                  <td key={s.id} className="h-10 w-16 border-b border-l text-center">
                    <Checkbox
                      checked={set.has(s.id)}
                      disabled={!canEdit || setSubjects.isPending}
                      onCheckedChange={(v) => toggle(g.id, s.id, !!v)}
                      aria-label={`${g.name} ${s.code}`}
                    />
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
