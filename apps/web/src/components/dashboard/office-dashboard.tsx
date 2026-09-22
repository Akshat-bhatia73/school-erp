import { Link } from '@tanstack/react-router'
import {
  Activity,
  AlertTriangle,
  BellRing,
  Cake,
  CalendarDays,
  CalendarHeart,
  CalendarX,
  Check,
  CheckCircle2,
  FileSignature,
  GraduationCap,
  KeyRound,
  LayoutGrid,
  ListChecks,
  MailWarning,
  PartyPopper,
  PhoneOff,
  Ratio,
  School,
  ScrollText,
  ShieldAlert,
  TrendingUp,
  UserCog,
  UserMinus,
  UserPlus,
  UserX,
  Users,
  Wallet,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { DashboardAttentionKey, DashboardBirthday, OfficeDashboard as OfficeDashboardData } from '@erp/contracts'
import { AttentionList, type AttentionListItem } from '@/components/dashboard/blocks/attention-list'
import { MonthBarChart } from '@/components/dashboard/blocks/bar-chart'
import { BentoGrid, Cell, DashboardCard, ToneBadge, type Tone } from '@/components/dashboard/blocks/card'
import { ClassStrengthList } from '@/components/dashboard/blocks/class-strength'
import { HeroCard, type HeroChip } from '@/components/dashboard/blocks/hero'
import { CalendarTile, SimpleList, type SimpleListItem } from '@/components/dashboard/blocks/list'
import { StatRow, StatTile } from '@/components/dashboard/blocks/stat'
import { calendarParts, longDayDate, plural, weekdayName } from '@/components/dashboard/format'
import { FeeStatTiles } from '@/components/fees/dashboard-cards'
import { UserAvatar } from '@/components/shared/avatar'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { useSchoolContext } from '@/lib/session'
import { formatDate, timeAgo } from '@/lib/utils'

/** The whole office view: today, what needs a person, the school in numbers and what is coming up. */
export function OfficeDashboard({ data, isLoading, error }: { data?: OfficeDashboardData; isLoading: boolean; error: unknown }) {
  const { hasPermission } = useSchoolContext()
  const canOpenSubstitutions = hasPermission('timetable.read')
  const showSetup = Boolean(data?.setup && data.setup.steps.some((step) => !step.done))

  return (
    <BentoGrid dense>
      {data && (
        <Cell col={8} rows={2}>
          <HeroCard
            day={data.day}
            headline={weekdayName(data.day.date)}
            sentence={todaySentence(data)}
            chips={todayChips(data)}
            actions={
              <>
                {hasPermission('students.create') && (
                  <Button asChild size="sm" variant="outline">
                    <Link to="/students/new"><UserPlus className="size-4" />Admit student</Link>
                  </Button>
                )}
                {hasPermission('staff.create') && (
                  <Button asChild size="sm" variant="outline">
                    <Link to="/staff/new"><UserPlus className="size-4" />Add staff</Link>
                  </Button>
                )}
                {data.day.kind === 'school_day' && data.today && canOpenSubstitutions && (
                  <Button asChild size="sm">
                    <Link to="/timetable/substitutions" search={{ date: data.day.date }}>Open substitutions</Link>
                  </Button>
                )}
              </>
            }
          />
        </Cell>
      )}

      {data?.glance && (
        <Cell col={4} rows={3}>
          <DashboardCard title="School at a glance" tone="blue" icon={<Users />} bodyClassName="pt-1">
            <GlanceTiles data={data} />
          </DashboardCard>
        </Cell>
      )}

      {data?.fees && (
        <Cell col={8} rows={2}>
          <DashboardCard title="Fees" description="Money in today and this month, and what is still owed" tone="green" icon={<Wallet />} bodyClassName="pt-1">
            <FeeStatTiles fees={data.fees} size="sm" />
          </DashboardCard>
        </Cell>
      )}

      <Cell col={4} rows={5}>
        <DashboardCard
          title="Needs attention"
          description="Small gaps somebody can close today"
          tone="orange"
          icon={<BellRing />}
          isLoading={isLoading && !data}
          error={!data ? error : undefined}
        >
          {data && <AttentionList items={attentionItems(data)} allClearText="Nothing is waiting on you." />}
        </DashboardCard>
      </Cell>

      {data?.classStrength && (
        <Cell col={4} rows={6}>
          <DashboardCard
            title="Class strength"
            description="How many students sit in each section"
            tone="teal"
            icon={<School />}
            action={<CardLink to="/setup/classes">Open classes</CardLink>}
            footer={data.classStrength.length > 0 ? classStrengthFooter(data.classStrength) : undefined}
            empty={{ icon: <LayoutGrid />, title: 'No classes yet', description: 'Add classes and sections in setup.' }}
          >
            {data.classStrength.length > 0 ? <ClassStrengthList rows={data.classStrength} /> : undefined}
          </DashboardCard>
        </Cell>
      )}

      {data && (
        <Cell col={4} rows={7}>
          <ComingUp data={data} />
        </Cell>
      )}

      {data?.admissionsByMonth && (
        <Cell col={4} rows={3}>
          <DashboardCard
            title="Admissions this year"
            description="April to March"
            tone="indigo"
            icon={<TrendingUp />}
            padded={false}
            bodyClassName="px-3 pb-3"
            footer={plural(admittedSoFar(data), 'student admitted so far this year', 'students admitted so far this year')}
            empty={{ icon: <GraduationCap />, title: 'No admissions yet', description: 'Students you admit will show up here.' }}
          >
            {data.admissionsByMonth.some((month) => month.count > 0)
              ? <MonthBarChart data={data.admissionsByMonth} highlightMonth={data.day.date.slice(0, 7)} height={160} />
              : undefined}
          </DashboardCard>
        </Cell>
      )}

      {data?.recentActivity && (
        <Cell col={4} rows={2}>
          <RecentActivityCard data={data} />
        </Cell>
      )}

      {data?.setup && showSetup && (
        <Cell col={12} rows={1}>
          <SetupCard steps={data.setup.steps} />
        </Cell>
      )}
    </BentoGrid>
  )
}

/** Students, and the movements around them, as big numbers. */
function GlanceTiles({ data }: { data: OfficeDashboardData }) {
  const glance = data.glance
  if (!glance) return null
  const students = (
    <StatTile
      key="students"
      size="sm"
      label="Students"
      value={glance.students.total}
      tone="blue"
      icon={<GraduationCap />}
      {...(glance.mix ? { hint: `${glance.mix.boys} boys · ${glance.mix.girls} girls` } : {})}
    />
  )
  const rest: ReactNode[] = []
  if (glance.admittedThisMonth !== undefined) {
    rest.push(<StatTile key="new" size="sm" label="New this month" value={glance.admittedThisMonth} tone="green" icon={<UserPlus />} />)
  }
  if (glance.leftThisMonth !== undefined) {
    rest.push(<StatTile key="left" size="sm" label="Left this month" value={glance.leftThisMonth} tone="orange" icon={<UserMinus />} />)
  }
  if (data.studentsPerTeacher !== undefined) {
    rest.push(<StatTile key="ratio" size="sm" label="Students per teacher" value={data.studentsPerTeacher.toFixed(1)} tone="purple" icon={<Ratio />} />)
  }
  if (rest.length === 0) return <StatRow cols={2}><div className="col-span-2 min-w-0">{students}</div></StatRow>
  return <StatRow cols={2}>{students}{rest}</StatRow>
}

/** 'N students in M sections' under the class strength bars. */
function classStrengthFooter(rows: NonNullable<OfficeDashboardData['classStrength']>): string {
  const students = rows.reduce((sum, row) => sum + row.sections.reduce((inner, section) => inner + section.count, 0), 0)
  const sections = rows.reduce((sum, row) => sum + row.sections.length, 0)
  return `${plural(students, 'student', 'students')} in ${plural(sections, 'section', 'sections')}`
}

/** Everything admitted up to and including this month. */
function admittedSoFar(data: OfficeDashboardData): number {
  const thisMonth = data.day.date.slice(0, 7)
  return (data.admissionsByMonth ?? [])
    .filter((month) => month.month <= thisMonth)
    .reduce((sum, month) => sum + month.count, 0)
}

/** The chips under the sentence in the hero. */
function todayChips(data: OfficeDashboardData): HeroChip[] {
  const chips: HeroChip[] = []
  const holiday = data.holidays[0]
  if (holiday) {
    const when = calendarParts(holiday.startDate)
    chips.push({ label: `Next holiday: ${holiday.name}, ${when.day} ${when.month}`, tone: 'orange', icon: <CalendarHeart /> })
  }
  const birthdaysToday = data.birthdays?.today ?? []
  if (birthdaysToday.length > 0) {
    chips.push({ label: plural(birthdaysToday.length, 'birthday today', 'birthdays today'), tone: 'pink', icon: <Cake /> })
  }
  // The rest only make sense on a school day; otherwise the sentence already names the next one.
  if (data.day.kind !== 'school_day' || !data.today) return chips
  const school: HeroChip[] = []
  if (data.today.teachersAway > 0) {
    school.push({ label: plural(data.today.teachersAway, 'teacher away', 'teachers away'), tone: 'orange', icon: <UserX /> })
  }
  if (data.today.periodsWithoutCover > 0) {
    school.push({ label: plural(data.today.periodsWithoutCover, 'period without cover', 'periods without cover'), tone: 'red', icon: <AlertTriangle /> })
  }
  if (school.length === 0) school.push({ label: 'All periods covered', tone: 'green', icon: <CheckCircle2 /> })
  return [...chips, ...school]
}

/** Holidays in the next 30 days, then the birthdays today and this week. */
function ComingUp({ data }: { data: OfficeDashboardData }) {
  const holidays: SimpleListItem[] = data.holidays.map((holiday) => ({
    key: holiday.id,
    leading: <CalendarTile date={holiday.startDate} tone="orange" />,
    primary: holiday.name,
    secondary: dateRange(holiday.startDate, holiday.endDate),
    right: <Tag color="grey">{holiday.type}</Tag>,
  }))
  const birthdaysToday = data.birthdays?.today ?? []
  const birthdaysWeek = data.birthdays?.thisWeek ?? []
  const nothing = holidays.length === 0 && birthdaysToday.length === 0 && birthdaysWeek.length === 0

  return (
    <DashboardCard
      title="Coming up"
      description="The next 30 days"
      tone="pink"
      icon={<PartyPopper />}
      action={<CardLink to="/setup/holidays">All holidays</CardLink>}
      empty={{ icon: <CalendarDays />, title: 'Nothing coming up', description: 'No holidays or birthdays in the next 30 days.' }}
    >
      {nothing ? undefined : (
        <div className="flex flex-col gap-3">
          {holidays.length > 0 && (
            <div>
              <Heading>Holidays</Heading>
              <SimpleList items={holidays} />
            </div>
          )}
          {birthdaysToday.length > 0 && (
            <div>
              <Heading>Birthdays today</Heading>
              <SimpleList items={birthdaysToday.map((birthday) => birthdayItem(birthday, true))} />
            </div>
          )}
          {birthdaysWeek.length > 0 && (
            <div>
              <Heading>Birthdays this week</Heading>
              <SimpleList items={birthdaysWeek.slice(0, 6).map((birthday) => birthdayItem(birthday, false))} />
              {birthdaysWeek.length > 6 && (
                <p className="pt-2 text-[12.5px] text-muted-foreground">and {birthdaysWeek.length - 6} more this week</p>
              )}
            </div>
          )}
        </div>
      )}
    </DashboardCard>
  )
}

/** A small heading above a group of rows inside a card. */
function Heading({ children }: { children: ReactNode }) {
  return <p className="mb-1 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{children}</p>
}

/** '2 Oct' or '2 Oct to 5 Oct' in Indian style. */
function dateRange(startDate: string, endDate: string): string {
  return startDate === endDate ? formatDate(startDate) : `${formatDate(startDate)} to ${formatDate(endDate)}`
}

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

function birthdayItem(birthday: DashboardBirthday, today: boolean): SimpleListItem {
  return {
    key: `${birthday.kind}-${birthday.id}`,
    leading: <UserAvatar name={birthday.name} size="sm" />,
    primary: birthday.name,
    secondary: birthday.className ?? (birthday.kind === 'staff' ? 'Staff' : undefined),
    right: today ? <Cake className="size-4 text-tag-pink" /> : shortDay(birthday.date),
  }
}

/** '2026-09-24' -> 'Tue' */
function shortDay(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return iso
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return SHORT_DAYS[date.getDay()] ?? iso
}

/** The last few audit rows, with the security ones called out below them. */
function RecentActivityCard({ data }: { data: OfficeDashboardData }) {
  const { hasPermission } = useSchoolContext()
  const items = data.recentActivity ?? []
  const security = data.securityEvents ?? []

  return (
    <DashboardCard
      title="Recent activity"
      description="What changed in this school lately"
      tone="purple"
      icon={<Activity />}
      action={hasPermission('audit.read') ? <CardLink to="/settings/audit-log">Audit log</CardLink> : undefined}
      empty={{ icon: <ScrollText />, title: 'Nothing yet', description: 'Changes people make will show up here.' }}
    >
      {items.length === 0 && security.length === 0 ? undefined : (
        <div className="flex flex-col gap-3">
          {items.length > 0 && (
            <SimpleList
              items={items.map((event) => ({
                key: event.id,
                leading: <UserAvatar name={event.actorDisplayName} size="sm" />,
                primary: event.summary,
                secondary: `${event.actorDisplayName} · ${timeAgo(event.at)}`,
              }))}
            />
          )}
          {security.length > 0 && (
            <div>
              <Heading>Security</Heading>
              <SimpleList
                items={security.map((event) => ({
                  key: event.id,
                  leading: <ToneBadge tone="red"><ShieldAlert /></ToneBadge>,
                  primary: event.summary,
                  secondary: `${event.actorDisplayName} · ${timeAgo(event.at)}`,
                }))}
              />
            </div>
          )}
        </div>
      )}
    </DashboardCard>
  )
}

/** How far the school has got with setup, and the steps still open. */
function SetupCard({ steps }: { steps: NonNullable<OfficeDashboardData['setup']>['steps'] }) {
  const done = steps.filter((step) => step.done).length
  const percent = Math.round((done / Math.max(1, steps.length)) * 100)
  return (
    <DashboardCard
      title="Finish setting up"
      description={`${done} of ${steps.length} done`}
      tone="green"
      icon={<ListChecks />}
      bodyClassName="pt-1"
    >
      <div className="flex flex-col gap-2.5">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-tag-green" style={{ width: `${percent}%` }} />
        </div>
        <div className="flex flex-wrap gap-2">
          {steps.map((step) => (
            step.done
              ? (
                  <Tag key={step.key} color="green">
                    <Check className="size-3.5 shrink-0" />
                    {SETUP_STEPS[step.key].label}
                  </Tag>
                )
              : (
                  <Link key={step.key} to={SETUP_STEPS[step.key].to} className="rounded-full hover:opacity-80">
                    <Tag color="grey">{SETUP_STEPS[step.key].label}</Tag>
                  </Link>
                )
          ))}
        </div>
      </div>
    </DashboardCard>
  )
}

function CardLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="text-[12.5px] text-muted-foreground link-dotted hover:text-foreground">
      {children}
    </Link>
  )
}

const SETUP_STEPS: Record<'school' | 'years' | 'grades' | 'sections' | 'subjects', { label: string; to: string }> = {
  school: { label: 'Fill in the school profile', to: '/setup/school' },
  years: { label: 'Add an academic year', to: '/setup/academic-years' },
  grades: { label: 'Add classes', to: '/setup/classes' },
  sections: { label: 'Add sections', to: '/setup/classes' },
  subjects: { label: 'Add subjects', to: '/setup/subjects' },
}

const ATTENTION: Record<DashboardAttentionKey, { one: string; many: string; to: string; hint: string; tone: Tone; icon: ReactNode }> = {
  periods_without_cover: { one: 'period has no cover today', many: 'periods have no cover today', to: '/timetable/substitutions', hint: 'Open substitutions', tone: 'red', icon: <AlertTriangle /> },
  students_absent_three_days: { one: 'pupil absent three school days running', many: 'pupils absent three school days running', to: '/attendance', hint: 'Open attendance', tone: 'orange', icon: <CalendarX /> },
  invitations_expiring: { one: 'invitation expiring soon', many: 'invitations expiring soon', to: '/settings/users', hint: 'Open users and logins', tone: 'blue', icon: <MailWarning /> },
  students_without_guardian_phone: { one: 'student without a guardian phone', many: 'students without a guardian phone', to: '/students', hint: 'Open the student list', tone: 'orange', icon: <PhoneOff /> },
  students_without_consent: { one: 'student without consent', many: 'students without consent', to: '/students', hint: 'Open the student list', tone: 'purple', icon: <FileSignature /> },
  sections_without_class_teacher: { one: 'section without a class teacher', many: 'sections without a class teacher', to: '/setup/classes', hint: 'Open classes and sections', tone: 'teal', icon: <UserCog /> },
  empty_timetable_slots: { one: 'empty timetable slot', many: 'empty timetable slots', to: '/timetable', hint: 'Open the timetable', tone: 'indigo', icon: <CalendarX /> },
  staff_without_login: { one: 'staff member without a login', many: 'staff without a login', to: '/settings/users', hint: 'Open users and logins', tone: 'pink', icon: <KeyRound /> },
}

function attentionItems(data: OfficeDashboardData): AttentionListItem[] {
  return data.attention.map((item) => {
    const shape = ATTENTION[item.key]
    return {
      key: item.key,
      count: item.count,
      label: `${item.count} ${item.count === 1 ? shape.one : shape.many}`,
      hint: shape.hint,
      tone: shape.tone,
      icon: shape.icon,
      to: shape.to,
      search: item.key === 'periods_without_cover' ? { date: data.day.date } : undefined,
    }
  })
}

/** 'every period has cover.' / '3 periods have no cover yet.' */
function coverPhrase(count: number): string {
  if (count === 0) return 'every period has cover.'
  return `${plural(count, 'period has', 'periods have')} no cover yet.`
}

/** The one sentence under the date at the top of the screen. */
function todaySentence(data: OfficeDashboardData): string {
  if (data.day.kind !== 'school_day') {
    const reason = data.day.holidayName ? `No school today (${data.day.holidayName}).` : 'No school today.'
    const next = data.day.nextSchoolDay ? ` The next school day is ${longDayDate(data.day.nextSchoolDay.date)}.` : ''
    return `${reason}${next}`
  }
  if (!data.today) return 'School day.'
  const away = data.today.teachersAway === 0
    ? 'No teacher is away.'
    : `${plural(data.today.teachersAway, 'teacher is', 'teachers are')} away, ${coverPhrase(data.today.periodsWithoutCover)}`
  return `School day. ${away}`
}
