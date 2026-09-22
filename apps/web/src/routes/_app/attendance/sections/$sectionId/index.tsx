/**
 * One class on one day: the roster and its marks.
 *
 * Marking is one write of the whole roster; a correction sends only the rows that changed and
 * the reason the office typed. Which of the two applies is the server's `window`, never a guess
 * made here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ClipboardCheck } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { DayRegister, type DayRegisterLine, type DayRegisterPerson } from '@/components/attendance/day-register'
import { DateChip, todayIso } from '@/components/attendance/month-chip'
import { EmptyState, PageHeader, PageTabs, Toolbar } from '@/components/shared/page'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

const searchSchema = z.object({ date: z.string().optional().catch(undefined) })

export const Route = createFileRoute('/_app/attendance/sections/$sectionId/')({ component: Page, validateSearch: searchSchema })

function Page() {
  const { sectionId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const date = search.date ?? todayIso()

  const dayQuery = useQuery({
    queryKey: qk.attendanceDay(schoolId, sectionId, date),
    queryFn: () => api.attendance.day(schoolId, sectionId, date),
  })

  const done = (message: string) => {
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'attendance'] })
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'dashboard'] })
    toast.success(message)
  }

  const save = useMutation({
    mutationFn: (lines: DayRegisterLine[]) =>
      api.attendance.mark(schoolId, sectionId, date, { marks: lines.map((line) => ({ studentId: line.id, mark: line.mark })) }),
    onSuccess: () => done('Attendance saved'),
    onError: (failure) => toast.error(describeError(failure)),
  })

  const correct = useMutation({
    mutationFn: ({ lines, reason }: { lines: DayRegisterLine[]; reason: string }) =>
      api.attendance.correct(schoolId, sectionId, date, { marks: lines.map((line) => ({ studentId: line.id, mark: line.mark })), reason }),
    onSuccess: () => done('Corrections saved'),
    onError: (failure) => toast.error(describeError(failure)),
  })

  const data = dayQuery.data
  const title = data ? `${data.grade.name} - ${data.section.name}` : 'Register'
  const header = (
    <PageHeader crumbs={[{ label: 'Attendance', to: '/attendance', icon: <ClipboardCheck /> }, { label: title }]} />
  )

  if (dayQuery.isError) {
    return (
      <>
        {header}
        <EmptyState icon={<ClipboardCheck />} title="This register is not available" description={describeError(dayQuery.error)} />
      </>
    )
  }

  if (!data) {
    return (
      <>
        {header}
        <div className="space-y-3 p-3 md:p-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-64 w-full" /></div>
      </>
    )
  }

  const people: DayRegisterPerson[] = data.rows.map((row) => ({
    id: row.student.id,
    lead: row.student.rollNumber !== undefined ? String(row.student.rollNumber) : '—',
    name: row.student.name,
    sub: row.student.admissionNumber,
    mark: row.mark,
    editable: true,
  }))

  return (
    <>
      {header}
      <PageTabs
        tabs={[
          { label: 'Day', to: `/attendance/sections/${sectionId}` },
          { label: 'Month', to: `/attendance/sections/${sectionId}/month` },
        ]}
      />
      <Toolbar>
        <DateChip date={date} max={todayIso()} onChange={(value) => void navigate({ to: '/attendance/sections/$sectionId', params: { sectionId }, search: { date: value }, replace: true })} />
      </Toolbar>
      <DayRegister
        people={people}
        window={data.window}
        canRecord={allows(data.allowedActions, 'attendance.record')}
        canCorrect={allows(data.allowedActions, 'attendance.manage')}
        isSaving={save.isPending || correct.isPending}
        onSave={(lines) => save.mutate(lines)}
        onCorrect={(lines, reason) => correct.mutate({ lines, reason })}
        noun={{ one: 'pupil', many: 'pupils' }}
        leadLabel="Roll"
        nameLabel="Pupil"
      />
    </>
  )
}
