/**
 * The teacher dashboard: what is happening right now, the rest of today, the whole week,
 * their own class and the holidays ahead. Everything on the screen comes from one dashboard
 * read, except the bell schedules, which the real timetable grid needs to draw the week.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, Cake, CalendarClock, CalendarDays, CalendarRange, Clock, Coffee, PartyPopper, School, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import type { DashboardHoliday, DashboardTimelineSlot, TeacherDashboard as TeacherDashboardData } from '@erp/contracts'
import { BentoGrid, Cell, DashboardCard } from '@/components/dashboard/blocks/card'
import { HeroCard, HeroPill } from '@/components/dashboard/blocks/hero'
import type { HeroChip } from '@/components/dashboard/blocks/hero'
import { DayTimeline } from '@/components/dashboard/blocks/timeline'
import { CalendarTile, SimpleList } from '@/components/dashboard/blocks/list'
import { StatRow, StatTile } from '@/components/dashboard/blocks/stat'
import { timeLabel, weekdayName } from '@/components/dashboard/format'
import { dayName } from '@/components/dashboard/day'
import { EmptyState, SectionLabel } from '@/components/shared/page'
import { Tag, colorFor } from '@/components/shared/tag'
import { MarksToEnterCard } from '@/components/exams/dashboard-cards'
import { DAY_LABELS } from '@/components/timetable/day-selector'
import { TimetableGrid, mergeBellSchedules } from '@/components/timetable/timetable-grid'
import type { BellScheduleRecord, TimetableCellRecord } from '@/lib/api/timetable'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { formatDate } from '@/lib/utils'

/** 'HH:MM' as minutes after midnight, or null when the time makes no sense. */
function minutesOf(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** The browser clock in minutes, refreshed every minute so "Now" keeps moving. */
function useClockMinutes(): number {
  const read = () => {
    const now = new Date()
    return now.getHours() * 60 + now.getMinutes()
  }
  const [minutes, setMinutes] = useState(read)
  useEffect(() => {
    const timer = setInterval(() => setMinutes(read()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return minutes
}

function lessonWhere(slot: DashboardTimelineSlot): string {
  const lesson = slot.lesson
  if (!lesson) return ''
  return lesson.roomNumber ? `${lesson.section.name}, Room ${lesson.roomNumber}` : lesson.section.name
}

/** One or two plain sentences about where the teacher is in the day. */
function nowAndNext(day: TeacherDashboardData['day'], timeline: DashboardTimelineSlot[], isToday: boolean, minutes: number): string[] {
  const lessons = timeline.filter((slot) => slot.lesson)

  if (day.kind !== 'school_day') {
    const lines = [day.kind === 'sunday' ? 'No school today.' : `No school today. ${day.holidayName ?? 'Holiday'}.`]
    const first = lessons[0]
    if (day.nextSchoolDay && first?.lesson) {
      lines.push(`${dayName(day.nextSchoolDay.dayOfWeek)} starts with ${first.lesson.section.name} at ${timeLabel(first.startTime)}.`)
    }
    return lines
  }

  if (!isToday || timeline.length === 0) {
    const first = lessons[0]
    if (!first?.lesson) return ['Nothing is on your timetable for today.']
    return [`School starts with ${first.lesson.section.name} at ${timeLabel(first.startTime)}.`]
  }

  const nextLesson = lessons.find((slot) => (minutesOf(slot.startTime) ?? 0) > minutes)
  const nextLine = nextLesson?.lesson
    ? `Next: ${nextLesson.lesson.section.name} at ${timeLabel(nextLesson.startTime)}.`
    : null

  const current = timeline.find((slot) => {
    const start = minutesOf(slot.startTime)
    const end = minutesOf(slot.endTime)
    return start !== null && end !== null && start <= minutes && minutes < end
  })

  if (current?.lesson) {
    const line = `Now: ${current.lesson.subject.name}, ${lessonWhere(current)}, until ${timeLabel(current.endTime)}.`
    return nextLine ? [line, nextLine] : [line, 'That is your last class today.']
  }

  const firstStart = minutesOf(timeline[0]!.startTime)
  if (firstStart !== null && minutes < firstStart) {
    const first = lessons[0]
    if (!first?.lesson) return ['Nothing is on your timetable for today.']
    return [`School starts with ${first.lesson.section.name} at ${timeLabel(first.startTime)}.`]
  }

  if (!nextLesson) return ['Done for today.']
  return [`Free until ${timeLabel(nextLesson.startTime)}.`, nextLine!]
}

function holidayDates(holiday: DashboardHoliday): string {
  return holiday.startDate === holiday.endDate
    ? formatDate(holiday.startDate)
    : `${formatDate(holiday.startDate)} to ${formatDate(holiday.endDate)}`
}

/** What the week adds up to: periods taught, classes, subjects and free periods. */
function weekTotals(data: TeacherDashboardData) {
  const sections = new Map<string, string>()
  const subjects = new Map<string, string>()
  const days = new Set<number>()
  for (const cell of data.week) {
    sections.set(cell.section.id, cell.section.name)
    subjects.set(cell.subject.id, cell.subject.name)
    days.add(cell.dayOfWeek)
  }
  const teaching = data.periods.filter((period) => period.type === 'period').length
  const free = teaching > 0 && days.size > 0 ? Math.max(0, teaching * days.size - data.week.length) : 0
  return { sections, subjects, days, lessons: data.week.length, free }
}

/** Up to four lessons of the shown day as pills, then '+N more'. */
function lessonPills(timeline: DashboardTimelineSlot[]): ReactNode {
  const lessons = timeline.filter((slot) => slot.lesson)
  if (lessons.length === 0) return undefined
  const shown = lessons.slice(0, 4)
  return (
    <>
      {shown.map((slot) => {
        const lesson = slot.lesson!
        const cover = Boolean(lesson.cover)
        return (
          <HeroPill
            key={slot.periodIndex}
            tag={<Tag color={cover ? 'orange' : colorFor(lesson.section.id)}>{lesson.section.name}</Tag>}
          >
            {[cover ? 'Cover' : null, timeLabel(slot.startTime), lesson.subject.name].filter(Boolean).join(' · ')}
          </HeroPill>
        )
      })}
      {lessons.length > shown.length && (
        <HeroPill tone="plain" tag={`+${lessons.length - shown.length}`}>more</HeroPill>
      )}
    </>
  )
}

/**
 * A bell schedule for the grid when the year has none the teacher can read: the dashboard's
 * own periods, on the days their week actually uses (never fewer than Monday to Friday).
 */
function syntheticBell(data: TeacherDashboardData): BellScheduleRecord | undefined {
  if (data.periods.length === 0) return undefined
  const days = new Set<number>([1, 2, 3, 4, 5])
  for (const cell of data.week) days.add(cell.dayOfWeek)
  return {
    id: 'dashboard-week',
    schoolId: '',
    academicYearId: data.academicYearId ?? '',
    name: 'My week',
    gradeIds: [],
    periods: data.periods,
    workingDays: [...days].sort((a, b) => a - b),
    version: 1,
  }
}

/** The teacher's week as the timetable grid reads it: no teacher column, this teacher is it. */
function weekCells(data: TeacherDashboardData): TimetableCellRecord[] {
  return data.week.map((cell) => ({
    section: cell.section,
    subject: cell.subject,
    teacher: null,
    dayOfWeek: cell.dayOfWeek,
    periodIndex: cell.periodIndex,
    ...(cell.roomNumber ? { roomNumber: cell.roomNumber } : {}),
  }))
}

/** One row per working day: how much of it is free. */
function freeByDay(data: TeacherDashboardData, workingDays: number[]) {
  const teaching = data.periods.filter((period) => period.type === 'period').length
  const taught: Record<number, number> = {}
  for (const cell of data.week) taught[cell.dayOfWeek] = (taught[cell.dayOfWeek] ?? 0) + 1
  return workingDays.map((day) => {
    const used = taught[day] ?? 0
    const total = Math.max(teaching, used)
    return { day, total, free: Math.max(0, total - used) }
  })
}

export function TeacherDashboard({ data, isLoading, error }: { data?: TeacherDashboardData; isLoading: boolean; error: unknown }) {
  const { schoolId, hasPermission } = useSchoolContext()
  const minutes = useClockMinutes()
  const academicYearId = data?.academicYearId ?? null

  const bellParams = { academicYearId: academicYearId ?? '' }
  const bellQuery = useQuery({
    queryKey: qk.bellSchedules(schoolId, bellParams),
    queryFn: () => api.timetable.bellSchedules(schoolId, bellParams),
    enabled: academicYearId !== null,
  })
  const schedules = useMemo(() => bellQuery.data ?? [], [bellQuery.data])
  const cells = useMemo(() => (data ? weekCells(data) : []), [data])
  const bell = useMemo(
    () => (data ? mergeBellSchedules(schedules, cells) ?? syntheticBell(data) : undefined),
    [schedules, cells, data],
  )

  if (!data) {
    if (error) {
      return <EmptyState icon={<CalendarClock />} title="We could not open your dashboard" description={describeError(error)} />
    }
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }

  if (!data.staffLinked) {
    return (
      <EmptyState
        icon={<School />}
        title="Your login is not linked to a staff record yet"
        description="Ask the school office to link it."
      />
    )
  }

  const isSchoolDay = data.day.kind === 'school_day'
  const isToday = data.timelineDate !== null && data.timelineDate === data.day.date
  const lines = nowAndNext(data.day, data.timeline, isToday, minutes)
  const current = isToday
    ? data.timeline.find((slot) => {
        const start = minutesOf(slot.startTime)
        const end = minutesOf(slot.endTime)
        return start !== null && end !== null && start <= minutes && minutes < end
      })
    : undefined

  const timelineTitle = isSchoolDay
    ? 'Today'
    : data.day.nextSchoolDay
      ? dayName(data.day.nextSchoolDay.dayOfWeek)
      : 'Next school day'

  const canOpenStudents = hasPermission('students.read_basic')
  const canOpenTimetable = hasPermission('timetable.read')
  const totals = weekTotals(data)

  const lessonsToday = data.timeline.filter((slot) => slot.lesson).length
  const freeToday = data.timeline.filter((slot) => slot.type === 'period' && !slot.lesson).length
  const coverToday = data.timeline.filter((slot) => slot.lesson?.cover).length

  // The chips describe the day the timeline is showing: today, or the next school day.
  const chips: HeroChip[] = []
  if (data.timeline.length > 0) {
    const prefix = isToday || !data.timelineDate ? '' : `${weekdayName(data.timelineDate)}: `
    chips.push({ label: `${prefix}${lessonsToday} ${lessonsToday === 1 ? 'period' : 'periods'}`, tone: 'blue', icon: <Clock /> })
    chips.push({ label: `${freeToday} free`, tone: 'green', icon: <Coffee /> })
    if (coverToday > 0) chips.push({ label: `${coverToday} cover`, tone: 'orange', icon: <Users /> })
  }
  if (current?.lesson?.cover) chips.push({ label: 'Cover duty', tone: 'orange', icon: <Users /> })

  const sectionList = [...totals.sections.entries()]
  const subjectList = [...totals.subjects.entries()]
  const workingDays = bell ? [...bell.workingDays].sort((a, b) => a - b) : []
  const freeRows = freeByDay(data, workingDays)
  const weekLoading = data.periods.length > 0 && academicYearId !== null && bellQuery.isLoading
  // No periods at all means no timetable yet, whatever the bell schedules say.
  const weekBell = data.periods.length === 0 ? undefined : bell

  const myClassCard = data.myClass ? (
    <DashboardCard
      title="My class"
      tone="purple"
      icon={<Users />}
      action={
        canOpenStudents ? (
          <Link to="/students" search={{ sectionId: data.myClass.section.id }} className="text-[13px] text-muted-foreground hover:text-foreground">
            Open class list
          </Link>
        ) : undefined
      }
      error={error}
    >
      <div className="flex flex-col gap-3">
        <StatRow>
          <StatTile size="sm" label={data.myClass.section.name} value={data.myClass.strength} hint="students" tone="purple" icon={<Users />} />
        </StatRow>
        {data.myClass.attendanceToday && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] text-muted-foreground">
              {data.myClass.attendanceToday.marked
                ? `Attendance marked · ${data.myClass.attendanceToday.absent ?? 0} absent`
                : 'Attendance not marked yet'}
            </p>
            <Link
              to="/attendance/sections/$sectionId"
              params={{ sectionId: data.myClass.section.id }}
              search={{ date: data.myClass.attendanceToday.date }}
              className="text-[13px] text-muted-foreground hover:text-foreground"
            >
              {data.myClass.attendanceToday.marked ? 'Open register' : 'Mark attendance'}
            </Link>
          </div>
        )}
        {data.myClass.birthdaysThisWeek === undefined ? undefined : data.myClass.birthdaysThisWeek.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No birthdays in your class this week.</p>
        ) : (
          <SimpleList
            items={data.myClass.birthdaysThisWeek.map((birthday) => ({
              key: birthday.id,
              leading: (
                <span className="inline-flex size-8 items-center justify-center rounded-lg bg-tag-pink/12 text-tag-pink dark:bg-tag-pink/18">
                  <Cake className="size-4" />
                </span>
              ),
              primary: birthday.name,
              secondary: formatDate(birthday.date),
            }))}
          />
        )}
      </div>
    </DashboardCard>
  ) : null

  return (
    <BentoGrid dense>
      <Cell col={myClassCard ? 8 : 12} rows={2}>
        <HeroCard
          day={data.day}
          headline={lines[0]}
          sentence={lines[1] ?? ''}
          details={lessonPills(data.timeline)}
          chips={chips}
        />
      </Cell>

      {myClassCard && (
        <Cell col={4} rows={2}>
          {myClassCard}
        </Cell>
      )}

      {data.marksToEnter && (
        <Cell col={12} rows={3}>
          <MarksToEnterCard items={data.marksToEnter} />
        </Cell>
      )}

      <Cell col={12} rows={6}>
        <DashboardCard
          title="My week"
          tone="teal"
          icon={<CalendarDays />}
          padded={false}
          scrollable={false}
          isLoading={weekLoading}
          error={error}
          empty={!weekBell ? { icon: <CalendarDays />, title: 'No week to show', description: 'Your timetable has not been set up yet.' } : undefined}
        >
          {weekBell ? <TimetableGrid bell={weekBell} cells={cells} mode="staff" highlightFree className="h-full" /> : undefined}
        </DashboardCard>
      </Cell>

      <Cell col={4} rows={7}>
        <DashboardCard
          title={timelineTitle}
          description={data.timelineDate ? formatDate(data.timelineDate) : undefined}
          tone="blue"
          icon={<Clock />}
          isLoading={isLoading && data.timeline.length === 0}
          error={error}
          empty={data.timeline.length === 0 ? { icon: <CalendarClock />, title: 'No periods to show', description: 'There is no bell schedule or timetable for this day yet.' } : undefined}
        >
          {data.timeline.length > 0 ? (
            <DayTimeline slots={data.timeline} nowIndex={current?.periodIndex} mode="staff" />
          ) : undefined}
        </DashboardCard>
      </Cell>

      <Cell col={4} rows={3}>
        <DashboardCard title="This week" tone="indigo" icon={<CalendarRange />} error={error}>
          <StatRow cols={2}>
            <StatTile size="sm" label="Periods" value={totals.lessons} tone="indigo" icon={<Clock />} />
            <StatTile size="sm" label="Classes" value={totals.sections.size} tone="blue" icon={<Users />} />
            <StatTile size="sm" label="Subjects" value={totals.subjects.size} tone="purple" icon={<BookOpen />} />
            {data.periods.length > 0 && <StatTile size="sm" label="Free periods" value={totals.free} tone="green" icon={<Coffee />} />}
          </StatRow>
        </DashboardCard>
      </Cell>

      <Cell col={4} rows={4}>
        <DashboardCard
          title="Free this week"
          description="Periods with nothing on your timetable"
          tone="green"
          icon={<Coffee />}
          error={error}
          empty={freeRows.length === 0 ? { icon: <Coffee />, title: 'No week to show yet' } : undefined}
        >
          {freeRows.length > 0 ? (
            <div className="flex flex-col divide-y">
              {freeRows.map((row) => (
                <div key={row.day} className="flex min-h-11 items-center gap-3 py-1.5">
                  <span className="w-10 shrink-0 text-[13px] font-medium">{DAY_LABELS[row.day]}</span>
                  <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-tag-green"
                      style={{ width: `${row.total > 0 ? Math.round((row.free / row.total) * 100) : 0}%` }}
                    />
                  </span>
                  <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{row.free} free of {row.total}</span>
                </div>
              ))}
            </div>
          ) : undefined}
        </DashboardCard>
      </Cell>

      <Cell col={4} rows={4}>
        <DashboardCard
          title="What you teach"
          description="The sections and subjects on your timetable this week"
          tone="green"
          icon={<BookOpen />}
          error={error}
          empty={
            sectionList.length === 0 && subjectList.length === 0
              ? { icon: <BookOpen />, title: 'No classes on your timetable yet' }
              : undefined
          }
        >
          {sectionList.length > 0 || subjectList.length > 0 ? (
            <div className="flex flex-col gap-3">
              {sectionList.length > 0 && (
                <div className="flex flex-col gap-2">
                  <SectionLabel>Classes</SectionLabel>
                  <div className="flex flex-wrap gap-2">
                    {sectionList.map(([id, name]) =>
                      canOpenTimetable ? (
                        <Link key={id} to="/timetable" search={{ sectionId: id }}>
                          <Tag color={colorFor(id)}>{name}</Tag>
                        </Link>
                      ) : (
                        <Tag key={id} color={colorFor(id)}>{name}</Tag>
                      ),
                    )}
                  </div>
                </div>
              )}
              {subjectList.length > 0 && (
                <div className="flex flex-col gap-2">
                  <SectionLabel>Subjects</SectionLabel>
                  <div className="flex flex-wrap gap-2">
                    {subjectList.map(([id, name]) => (
                      <Tag key={id} color={colorFor(id)}>{name}</Tag>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : undefined}
        </DashboardCard>
      </Cell>

      <Cell col={4} rows={3}>
        <DashboardCard
          title="Coming up"
          description="Holidays in the next 30 days"
          tone="pink"
          icon={<PartyPopper />}
          error={error}
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
