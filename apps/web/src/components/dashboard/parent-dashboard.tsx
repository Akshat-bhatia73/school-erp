import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock } from 'lucide-react'
import { toast } from 'sonner'
import { CONSENT_PURPOSES, type ConsentPurpose } from '@erp/contracts'
import { dayName, todayDayOfWeek } from './day'
import { EmptyState, Panel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import type { Dashboard } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { PURPOSE_LABEL } from '@/lib/consent'
import { allows } from '@/lib/permissions'
import { fullName } from '@/lib/utils'

export type ParentChild = Extract<Dashboard, { audience: 'parent' }>['children'][number]

const STATUS_LABEL: Record<string, string> = { active: 'Active', left: 'Left', alumni: 'Alumni', suspended: 'Suspended' }

function ChildTimetable({ sectionId, academicYearId }: { sectionId: string; academicYearId: string }) {
  const { schoolId } = useSchoolContext()
  const today = todayDayOfWeek()
  const { data, isLoading, error } = useQuery({
    queryKey: qk.timetableSection(schoolId, sectionId, { academicYearId }),
    queryFn: () => api.timetable.forSection(schoolId, sectionId, { academicYearId }),
  })

  if (today === null) return <p className="text-[13px] text-muted-foreground">No classes today.</p>
  if (isLoading) return <div className="flex flex-col gap-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}</div>
  if (error) return <p className="text-[13px] text-muted-foreground">{describeError(error)}</p>

  const cells = (data?.cells ?? []).filter((cell) => cell.dayOfWeek === today).sort((a, b) => a.periodIndex - b.periodIndex)
  if (cells.length === 0) {
    return <EmptyState icon={<CalendarClock />} title="No classes today" description={`Nothing on the timetable for ${dayName(today)}.`} className="py-8" />
  }
  return (
    <ul className="flex flex-col divide-y">
      {cells.map((cell) => (
        <li key={`${cell.periodIndex}-${cell.subject.id}`} className="flex items-center gap-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[13.5px]">{cell.subject.name}</span>
          <span className="shrink-0 text-[12.5px] text-muted-foreground">{cell.teacher?.name ?? 'Teacher not set'}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * What this family has agreed to for one child. A parent answering here is recording it through
 * the portal, which is how the server stores it whatever the screen sends.
 */
function ChildConsents({ studentId }: { studentId: string }) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: qk.studentConsents(schoolId, studentId),
    queryFn: () => api.students.consents(schoolId, studentId),
  })
  // A parent holds students.read_guardian_contact for their own children, so the child's own
  // record names the guardians even before anybody has answered a single question.
  const detail = useQuery({
    queryKey: qk.student(schoolId, studentId),
    queryFn: () => api.students.get(schoolId, studentId),
  })

  const record = useMutation({
    mutationFn: (body: Parameters<typeof api.students.recordConsent>[2]) => api.students.recordConsent(schoolId, studentId, body),
    // The list comes back whole, so the words come from what was sent, not from a single saved row.
    onSuccess: (_list, sent) => {
      void queryClient.invalidateQueries({ queryKey: qk.studentConsents(schoolId, studentId) })
      toast.success(sent.status === 'given' ? 'Consent recorded' : 'Consent withdrawn')
    },
    onError: (mutationError) => toast.error(describeError(mutationError)),
  })

  if (isLoading) return <div className="flex flex-col gap-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}</div>
  if (error || !data) return <p className="text-[13px] text-muted-foreground">{describeError(error)}</p>

  // Only a guardian the server already named can be answered for; it never invents a link.
  const people = new Map<string, string>()
  for (const contact of detail.data?.guardianContacts ?? []) people.set(contact.id, contact.displayName)
  for (const row of data.items) if (!people.has(row.guardianId)) people.set(row.guardianId, row.guardianDisplayName)
  if (people.size === 0) {
    return <p className="text-[13px] text-muted-foreground">Nothing recorded yet. The school office will ask you about this.</p>
  }
  const canManage = allows(data.allowedActions, 'students.manage_consents')
  // With one guardian the name adds nothing; with two it says who is being answered for.
  const showNames = people.size > 1

  return (
    <ul className="flex flex-col divide-y">
      {[...people].flatMap(([guardianId, guardianName]) => CONSENT_PURPOSES.map((purpose: ConsentPurpose) => {
        const current = data.items.find((row) => row.guardianId === guardianId && row.purpose === purpose)
        const given = current?.status === 'given'
        return (
          <li key={`${guardianId}-${purpose}`} className="flex items-center gap-3 py-2">
            <span className="min-w-0 flex-1 truncate text-[13.5px]">{PURPOSE_LABEL[purpose]}</span>
            {showNames && <span className="shrink-0 text-[12.5px] text-muted-foreground">{guardianName}</span>}
            <Tag color={current ? (given ? 'green' : 'grey') : 'grey'}>{current ? (given ? 'Given' : 'Withdrawn') : 'Not asked'}</Tag>
            {canManage && (
              <Button
                size="sm"
                variant="outline"
                disabled={record.isPending}
                onClick={() => record.mutate({ guardianId, purpose, status: given ? 'withdrawn' : 'given', method: 'portal' })}
              >
                {given ? 'Withdraw' : 'Give'}
              </Button>
            )}
          </li>
        )
      }))}
    </ul>
  )
}

function ChildCard({ child }: { child: ParentChild }) {
  const { hasPermission } = useSchoolContext()
  const enrollment = child.enrollment
  return (
    <Panel
      title={fullName(child)}
      description={enrollment ? `${enrollment.grade.name} ${enrollment.section.name} · ${child.admissionNumber}` : child.admissionNumber}
      actions={<Tag color={child.status === 'active' ? 'green' : 'grey'}>{STATUS_LABEL[child.status] ?? child.status}</Tag>}
    >
      {enrollment ? (
        <>
          <p className="mb-1 text-[12px] font-medium tracking-wide text-muted-foreground">Today</p>
          <ChildTimetable sectionId={enrollment.section.id} academicYearId={enrollment.academicYear.id} />
        </>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          {hasPermission('students.read_enrollments') ? 'Not in a class this year.' : 'Class not shown.'}
        </p>
      )}
      {hasPermission('students.read_consents') && (
        <>
          <p className="mt-4 mb-1 text-[12px] font-medium tracking-wide text-muted-foreground">Consent</p>
          <ChildConsents studentId={child.id} />
        </>
      )}
    </Panel>
  )
}

/** The parent home: one card per child and what that child is studying today. */
export function ParentDashboard({ students }: { students?: ParentChild[] }) {
  const list = students ?? []
  if (list.length === 0) {
    return <EmptyState icon={<CalendarClock />} title="No children linked yet" description="Ask the school office to link your children to your account." />
  }
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {list.map((child) => <ChildCard key={child.id} child={child} />)}
    </div>
  )
}
