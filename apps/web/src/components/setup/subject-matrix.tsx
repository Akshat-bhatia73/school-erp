import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/shared/page'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import type { GradeRecord, SubjectRecord } from '@/lib/api/setup'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

/** Grades (rows) x subjects (columns) checkbox matrix for one academic year. */
export function SubjectMatrix({ academicYearId, grades, subjects, canEdit, isLoading }: {
  academicYearId: string
  grades: GradeRecord[]
  subjects: SubjectRecord[]
  canEdit: boolean
  isLoading?: boolean
}) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const params = { academicYearId }
  const { data: links = [], isLoading: linksLoading } = useQuery({
    queryKey: qk.gradeSubjects(schoolId, params),
    queryFn: () => api.setup.gradeSubjects(schoolId, params),
    enabled: !!academicYearId,
  })

  const byGrade = useMemo(() => {
    const out = new Map<string, Set<string>>()
    for (const link of links) {
      if (!out.has(link.gradeId)) out.set(link.gradeId, new Set())
      out.get(link.gradeId)!.add(link.subject.id)
    }
    return out
  }, [links])

  const setSubjects = useMutation({
    // The body replaces the whole set for this class and year, so every kept subject is sent again.
    mutationFn: (input: { gradeId: string; subjectIds: string[] }) =>
      api.setup.setGradeSubjects(schoolId, input.gradeId, { academicYearId, subjectIds: input.subjectIds }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'subjects'] })
      toast.success('Saved changes')
    },
    onError: (failure) => toast.error(describeError(failure)),
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
            {subjects.map((subject) => (
              <th key={subject.id} title={subject.name} className="h-11 w-16 border-b border-l bg-card px-2 text-center font-mono text-[12px] font-medium text-muted-foreground">{subject.code}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grades.map((grade) => {
            const chosen = byGrade.get(grade.id) ?? new Set<string>()
            return (
              <tr key={grade.id} className="hover:bg-accent/40">
                <td className="sticky left-0 z-10 h-10 w-44 border-r border-b bg-card px-3 font-medium">
                  {grade.name}
                  <span className="ml-2 text-[12px] font-normal text-muted-foreground tabular-nums">{chosen.size}</span>
                </td>
                {subjects.map((subject) => (
                  <td key={subject.id} className="h-10 w-16 border-b border-l text-center">
                    {canEdit ? (
                      <Checkbox
                        checked={chosen.has(subject.id)}
                        disabled={setSubjects.isPending}
                        onCheckedChange={(v) => toggle(grade.id, subject.id, !!v)}
                        aria-label={`${grade.name} ${subject.code}`}
                      />
                    ) : chosen.has(subject.id) ? (
                      <Check aria-label={`${grade.name} studies ${subject.code}`} className="mx-auto size-3.5 text-muted-foreground" />
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
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
