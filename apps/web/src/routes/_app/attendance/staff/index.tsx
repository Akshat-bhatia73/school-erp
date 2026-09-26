/**
 * The staff register for one day. The office marks it; nobody marks their own row, so the
 * caller's own line shows what a colleague recorded and never a picker.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { ClipboardCheck } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { DayRegister, type DayRegisterLine, type DayRegisterPerson } from '@/components/attendance/day-register'
import { STALE_MARKS_MESSAGE } from '@/components/attendance/labels'
import { DateChip, todayIso } from '@/components/attendance/month-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { describeError, isApiError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

const searchSchema = z.object({ date: z.string().optional().catch(undefined) })

export const Route = createFileRoute('/_app/attendance/staff/')({ component: Page, validateSearch: searchSchema })

function Page() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const date = search.date ?? todayIso()

  const dayQuery = useQuery({
    queryKey: qk.staffAttendanceDay(schoolId, date),
    queryFn: () => api.attendance.staffDay(schoolId, date),
  })

  const done = (message: string) => {
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'attendance'] })
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'dashboard'] })
    toast.success(message)
  }

  // Somebody saved after this screen read the register: fetch their marks and say so.
  const failed = (failure: unknown) => {
    if (isApiError(failure, 'VERSION_CONFLICT')) {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'attendance'] })
      toast.error(STALE_MARKS_MESSAGE)
      return
    }
    toast.error(describeError(failure))
  }

  const save = useMutation({
    mutationFn: (lines: DayRegisterLine[]) =>
      api.attendance.markStaff(schoolId, date, { marks: lines.map((line) => ({ staffId: line.id, mark: line.mark, expectedRevision: line.expectedRevision })) }),
    onSuccess: () => done('Attendance saved'),
    onError: failed,
  })

  const correct = useMutation({
    mutationFn: ({ lines, reason }: { lines: DayRegisterLine[]; reason: string }) =>
      api.attendance.correctStaff(schoolId, date, { marks: lines.map((line) => ({ staffId: line.id, mark: line.mark, expectedRevision: line.expectedRevision })), reason }),
    onSuccess: () => done('Corrections saved'),
    onError: failed,
  })

  const data = dayQuery.data
  const header = (
    <PageHeader
      crumbs={[{ label: 'Attendance', to: '/attendance', icon: <ClipboardCheck /> }, { label: 'Staff register' }]}
      actions={<Button asChild size="sm" variant="outline"><Link to="/attendance/staff/month">Month view</Link></Button>}
    />
  )

  if (dayQuery.isError) {
    return (
      <>
        {header}
        <EmptyState icon={<ClipboardCheck />} title="The staff register is not available" description={describeError(dayQuery.error)} />
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

  // The caller's own row is never sent, so it is not editable and says who does mark it.
  const people: DayRegisterPerson[] = data.rows.map((row) => ({
    id: row.staff.id,
    lead: row.staff.employeeCode,
    name: row.staff.name,
    sub: row.staff.designation,
    mark: row.mark,
    revision: row.entry?.revision,
    editable: !row.self,
    note: row.self ? 'Marked by a colleague' : undefined,
    to: `/attendance/staff/${row.staff.id}`,
  }))

  return (
    <>
      {header}
      <Toolbar>
        <DateChip date={date} max={todayIso()} onChange={(value) => void navigate({ to: '/attendance/staff', search: { date: value }, replace: true })} />
      </Toolbar>
      <DayRegister
        people={people}
        window={data.window}
        canRecord={allows(data.allowedActions, 'staff_attendance.record')}
        canCorrect={allows(data.allowedActions, 'staff_attendance.manage')}
        isSaving={save.isPending || correct.isPending}
        onSave={(lines) => save.mutate(lines)}
        onCorrect={(lines, reason) => correct.mutate({ lines, reason })}
        noun={{ one: 'staff member', many: 'staff' }}
        leadLabel="Code"
        nameLabel="Name"
      />
    </>
  )
}
