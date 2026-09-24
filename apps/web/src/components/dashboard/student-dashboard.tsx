/**
 * A pupil's own home: their class and class teacher, today's lessons, this month's attendance, the
 * newest published report card and the holidays ahead. The same card a parent sees for one child,
 * without fees, consents or anything the office keeps. Each block is absent when the server left it
 * out, and the screen says nothing about it then.
 */
import { Link } from '@tanstack/react-router'
import { CalendarDays, PartyPopper } from 'lucide-react'
import type { DashboardHoliday, StudentDashboard as StudentDashboardData } from '@erp/contracts'
import { BentoGrid, Cell, DashboardCard } from '@/components/dashboard/blocks/card'
import { DayTimeline } from '@/components/dashboard/blocks/timeline'
import { CalendarTile, SimpleList } from '@/components/dashboard/blocks/list'
import { ReportCardLink } from '@/components/exams/dashboard-cards'
import { Facts, SectionLabel } from '@/components/shared/page'
import { Tag, colorFor } from '@/components/shared/tag'
import { UserAvatar } from '@/components/shared/avatar'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDate, fullName } from '@/lib/utils'

type Me = StudentDashboardData['me']

function classLabel(enrollment: NonNullable<Me['enrollment']>): string {
  return `${enrollment.grade.name} ${enrollment.section.name}`
}

function holidayDates(holiday: DashboardHoliday): string {
  return holiday.startDate === holiday.endDate
    ? formatDate(holiday.startDate)
    : `${formatDate(holiday.startDate)} to ${formatDate(holiday.endDate)}`
}

/** This month so far, with a way to see the days behind it. */
function MyAttendance({ studentId, attendance }: { studentId: string; attendance: NonNullable<Me['attendance']> }) {
  const line = attendance.percentage === null
    ? 'No school days yet'
    : `${attendance.percentage.toFixed(1)}% this month · ${attendance.absent} absent`
  return <Link to="/attendance/students/$studentId" params={{ studentId }} className="link-dotted">{line}</Link>
}

function MeCard({ me, day }: { me: Me; day: StudentDashboardData['day'] }) {
  const { student, enrollment } = me
  const name = fullName(student)
  const lessons = me.todayLessons ?? []
  return (
    <DashboardCard
      title={
        <span className="flex min-w-0 items-start gap-3">
          <UserAvatar name={name} size="xl" className="size-12" />
          <span className="flex min-w-0 flex-col gap-2">
            <span className="truncate text-[17px] font-semibold leading-tight">{name}</span>
            <span className="flex flex-wrap items-center gap-2">
              {enrollment && <Tag color={colorFor(enrollment.grade.name)}>{classLabel(enrollment)}</Tag>}
              {enrollment?.rollNumber !== undefined && <Tag color="grey">Roll {enrollment.rollNumber}</Tag>}
            </span>
            <span className="truncate font-mono text-[13px] font-normal text-muted-foreground">{student.admissionNumber}</span>
          </span>
        </span>
      }
    >
      <div className="flex flex-col">
        <Facts
          items={[
            { label: 'Class', value: enrollment ? classLabel(enrollment) : 'Not in a class this year' },
            { label: 'Class teacher', value: me.classTeacher?.name ?? 'Not set yet' },
            ...(me.attendance
              ? [{ label: 'My attendance', value: <MyAttendance studentId={student.id} attendance={me.attendance} /> }]
              : []),
            ...(me.latestReportCard
              ? [{ label: 'My report card', value: <ReportCardLink card={me.latestReportCard} /> }]
              : []),
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
      </div>
    </DashboardCard>
  )
}

export function StudentDashboard({ data, isLoading, error }: { data?: StudentDashboardData; isLoading: boolean; error: unknown }) {
  if (error && !data) return <DashboardCard title="Home" error={error} />
  if ((isLoading && !data) || !data) {
    return (
      <BentoGrid dense>
        <Cell col={8} rows={6}><Skeleton className="h-full min-h-[320px] w-full rounded-xl" /></Cell>
        <Cell col={4} rows={6}><Skeleton className="h-full min-h-[320px] w-full rounded-xl" /></Cell>
      </BentoGrid>
    )
  }
  return (
    <BentoGrid dense>
      <Cell col={8} rows={6}>
        <MeCard me={data.me} day={data.day} />
      </Cell>
      <Cell col={4} rows={6}>
        <DashboardCard
          title="Coming up"
          description="Holidays in the next 30 days"
          tone="pink"
          icon={<PartyPopper />}
          empty={data.holidays.length === 0 ? { icon: <CalendarDays />, title: 'No holidays in the next 30 days' } : undefined}
        >
          {data.holidays.length > 0 ? (
            <SimpleList
              items={data.holidays.map((holiday) => ({
                key: holiday.id,
                leading: <CalendarTile date={holiday.startDate} tone="orange" />,
                primary: holiday.name,
                secondary: holidayDates(holiday),
              }))}
            />
          ) : undefined}
        </DashboardCard>
      </Cell>
    </BentoGrid>
  )
}
