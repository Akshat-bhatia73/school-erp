import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, GraduationCap, Users } from 'lucide-react'
import { toast } from 'sonner'
import { CONSENT_PURPOSES, type ConsentPurpose, type ParentDashboard as ParentDashboardData } from '@erp/contracts'
import { BentoGrid, Cell, DashboardCard } from './blocks/card'
import { DayTimeline } from './blocks/timeline'
import { EmptyState, Facts, SectionLabel } from '@/components/shared/page'
import { Tag, colorFor } from '@/components/shared/tag'
import { UserAvatar } from '@/components/shared/avatar'
import { StudentStatusTag } from '@/components/students/student-columns'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { PURPOSE_LABEL } from '@/lib/consent'
import { allows } from '@/lib/permissions'
import { formatDate, fullName } from '@/lib/utils'
import { ExportRecordButton } from '@/components/students/export-record-button'

type ParentChild = ParentDashboardData['children'][number]

/** What the school is still waiting for, named the way the consent screen names it. */
function waitingLabel(purpose: ConsentPurpose): string {
  return `Consent for ${PURPOSE_LABEL[purpose].toLowerCase()}`
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
      void queryClient.invalidateQueries({ queryKey: qk.dashboard(schoolId) })
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
          <li key={`${guardianId}-${purpose}`} className="flex min-h-11 items-center gap-3 py-2">
            <span className="min-w-0 flex-1 truncate text-[13.5px]">{PURPOSE_LABEL[purpose]}</span>
            {showNames && <span className="shrink-0 text-[12.5px] text-muted-foreground">{guardianName}</span>}
            <Tag color={given ? 'green' : 'grey'}>{current ? (given ? 'Given' : 'Withdrawn') : 'Not asked'}</Tag>
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

/** A holiday in one line: a single day, or the first and last day of a break. */
function holidayLine(holiday: NonNullable<ParentChild['nextHoliday']>): string {
  return holiday.startDate === holiday.endDate
    ? `${holiday.name}, ${formatDate(holiday.startDate)}`
    : `${holiday.name}, ${formatDate(holiday.startDate)} to ${formatDate(holiday.endDate)}`
}

/** The class name the way the student list writes it. */
function classLabel(enrollment: NonNullable<ParentChild['enrollment']>): string {
  return `${enrollment.grade.name} ${enrollment.section.name}`
}

function ChildCard({ child, day }: { child: ParentChild; day: ParentDashboardData['day'] }) {
  const { schoolId, hasPermission } = useSchoolContext()
  const student = child.student
  const enrollment = child.enrollment
  // Consent is opened on request. Reading a child's record is an audited event, so the home page
  // must not write one per child on every visit just to have the block ready.
  const [consentOpen, setConsentOpen] = useState(false)
  const name = fullName(student)
  const lessons = child.todayLessons ?? []

  return (
    <DashboardCard
      title={
        <span className="flex min-w-0 items-start gap-3">
          <UserAvatar
            name={name}
            src={student.hasPhoto ? api.students.photoUrl(schoolId, student.id, student.photoUpdatedAt) : undefined}
            size="xl"
            className="size-12"
          />
          <span className="flex min-w-0 flex-col gap-2">
            <span className="truncate text-[17px] font-semibold leading-tight">{name}</span>
            <span className="flex flex-wrap items-center gap-2">
              {enrollment && <Tag color={colorFor(enrollment.grade.name)}>{classLabel(enrollment)}</Tag>}
              {enrollment?.rollNumber !== undefined && <Tag color="grey">Roll {enrollment.rollNumber}</Tag>}
              <StudentStatusTag status={student.status} />
            </span>
            <span className="truncate font-mono text-[13px] font-normal text-muted-foreground">{student.admissionNumber}</span>
          </span>
        </span>
      }
      footer={
        <div className="flex flex-wrap items-center gap-2">
          {hasPermission('students.read_consents') && !consentOpen && (
            <Button size="sm" variant="outline" onClick={() => setConsentOpen(true)}>Manage consent</Button>
          )}
          <ExportRecordButton
            studentId={student.id}
            admissionNumber={student.admissionNumber}
            label="Download my child's record"
          />
        </div>
      }
    >
      <div className="flex flex-col">
        <Facts
          items={[
            { label: 'Class', value: enrollment ? classLabel(enrollment) : 'Not in a class this year' },
            { label: 'Class teacher', value: child.classTeacher?.name ?? 'Not set yet' },
            { label: 'Next holiday', value: child.nextHoliday ? holidayLine(child.nextHoliday) : 'No holiday in the next 30 days.' },
          ]}
        />

        <SectionLabel className="px-0">Today</SectionLabel>
        {day.kind !== 'school_day' ? (
          <p className="text-[13.5px] text-muted-foreground">
            {day.kind === 'holiday'
              ? `No school today. ${day.holidayName ?? 'It is a holiday'}.`
              : 'No school today. It is a Sunday.'}
          </p>
        ) : lessons.length === 0 ? (
          <p className="text-[13.5px] text-muted-foreground">Nothing on the timetable today.</p>
        ) : (
          <DayTimeline slots={lessons} mode="section" />
        )}

        <SectionLabel className="px-0">The school is waiting on you</SectionLabel>
        {child.waitingOn.length === 0 ? (
          <p className="flex items-center gap-2 text-[13.5px] text-muted-foreground">
            <CircleCheck className="size-4 text-tag-green" /> All done.
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {child.waitingOn.map((item) => (
              <li key={item.purpose} className="flex min-h-11 items-center gap-3 py-2">
                <span className="min-w-0 flex-1 text-[13.5px] font-medium">{waitingLabel(item.purpose)}</span>
                <Tag color="orange">Waiting</Tag>
              </li>
            ))}
          </ul>
        )}
        {consentOpen && hasPermission('students.read_consents') && (
          <div className="mt-2"><ChildConsents studentId={student.id} /></div>
        )}
      </div>
    </DashboardCard>
  )
}

/** The class block beside a single child: what the school has recorded for this year. */
function ClassCard({ enrollment }: { enrollment: NonNullable<ParentChild['enrollment']> }) {
  return (
    <DashboardCard title="Class" description="What the school has on the roll this year." tone="blue" icon={<GraduationCap />}>
      <div className="flex flex-col gap-3">
        <Tag color={colorFor(enrollment.grade.name)}>{classLabel(enrollment)}</Tag>
        <Facts
          columns={1}
          items={[
            { label: 'Academic year', value: enrollment.academicYear.name },
            { label: 'Section', value: enrollment.section.name },
            { label: 'Roll number', value: enrollment.rollNumber !== undefined ? String(enrollment.rollNumber) : 'Not given yet' },
          ]}
        />
      </div>
    </DashboardCard>
  )
}

/** The parent home: one card per child, with today's classes and anything still to answer. */
export function ParentDashboard({ data, isLoading, error }: { data?: ParentDashboardData; isLoading: boolean; error: unknown }) {
  if (error && !data) {
    return <DashboardCard title="My children" error={error} />
  }
  if (isLoading && !data) {
    return (
      <BentoGrid dense>
        {Array.from({ length: 2 }).map((_, i) => (
          <Cell key={i} col={6} rows={6}><Skeleton className="h-full min-h-[320px] w-full rounded-xl" /></Cell>
        ))}
      </BentoGrid>
    )
  }
  if (!data || data.children.length === 0) {
    return (
      <EmptyState
        icon={<Users />}
        title="No child is linked to your login yet"
        description="Ask the school office to link your children to your account."
      />
    )
  }
  // One child fills the row with its class beside it; siblings sit side by side.
  const only = data.children.length === 1 ? data.children[0] : undefined
  const classAside = only?.enrollment
  const span = only ? (classAside ? 8 : 12) : 6
  return (
    <BentoGrid dense>
      {data.children.map((child) => (
        <Cell key={child.student.id} col={span} rows={6}>
          <ChildCard child={child} day={data.day} />
        </Cell>
      ))}
      {classAside && (
        <Cell col={4} rows={6}><ClassCard enrollment={classAside} /></Cell>
      )}
    </BentoGrid>
  )
}
