import { Compass, LayoutGrid, ScrollText, Users, UserMinus, UserPlus, Wallet } from 'lucide-react'
import type { ReactNode } from 'react'
import type { AccountantDashboard as AccountantDashboardData } from '@erp/contracts'
import { BentoGrid, Cell, DashboardCard, ToneBadge } from './blocks/card'
import { HeroCard } from './blocks/hero'
import { ClassStrengthList } from './blocks/class-strength'
import { SimpleList } from './blocks/list'
import { FeeStatTiles } from '@/components/fees/dashboard-cards'
import { StatRow, StatTile } from './blocks/stat'
import { longDayDate, weekdayName } from './format'
import { Skeleton } from '@/components/ui/skeleton'
import { useSchoolContext } from '@/lib/session'

/** One plain sentence about the day, the same wording the other dashboards use. */
function daySentence(day: AccountantDashboardData['day']): string {
  if (day.kind === 'school_day') return 'School is open today.'
  const reason = day.kind === 'holiday' ? (day.holidayName ? `${day.holidayName}.` : 'It is a holiday.') : 'It is a Sunday.'
  const next = day.nextSchoolDay ? ` School reopens on ${longDayDate(day.nextSchoolDay.date)}.` : ''
  return `No school today. ${reason}${next}`
}

interface Shortcut {
  to: string
  label: string
  hint: string
  icon: ReactNode
}

/** The accountant home: the money the school has taken and is owed, and how big it is. */
export function AccountantDashboard({ data, isLoading, error }: { data?: AccountantDashboardData; isLoading: boolean; error: unknown }) {
  const { hasPermission } = useSchoolContext()
  const links: Array<Shortcut | null> = [
    hasPermission('staff.read_directory')
      ? { to: '/staff', label: 'Staff directory', hint: 'Everyone who works at the school', icon: <Users /> }
      : null,
    hasPermission('audit.read')
      ? { to: '/settings/audit-log', label: 'Audit log', hint: 'Every change, with who made it', icon: <ScrollText /> }
      : null,
  ]
  const shortcuts = links.filter((link): link is Shortcut => link !== null)

  if (error && !data) return <DashboardCard title="Your dashboard" error={error} />
  if (!data) {
    return (
      <BentoGrid dense>
        <Cell col={8} rows={2}><Skeleton className="h-full min-h-[180px] w-full rounded-xl" /></Cell>
        <Cell col={4} rows={2}><Skeleton className="h-full min-h-[180px] w-full rounded-xl" /></Cell>
        <Cell col={6} rows={2}><Skeleton className="h-full min-h-[180px] w-full rounded-xl" /></Cell>
        <Cell col={6} rows={2}><Skeleton className="h-full min-h-[180px] w-full rounded-xl" /></Cell>
      </BentoGrid>
    )
  }

  const glance = data.glance

  return (
    <BentoGrid dense>
      <Cell col={8} rows={2}>
        <HeroCard
          day={data.day}
          headline={weekdayName(data.day.date)}
          sentence={daySentence(data.day)}
        />
      </Cell>

      {glance && (
        <Cell col={4} rows={2}>
          <DashboardCard title="Students" description="How big the school is right now." tone="blue" icon={<Users />}>
            <StatRow cols={glance.admittedThisMonth === undefined && glance.leftThisMonth === undefined ? 1 : 2}>
              <StatTile
                label="On the roll"
                value={glance.students.total}
                tone="blue"
                icon={<Users />}
                {...(glance.mix ? { hint: `${glance.mix.boys} boys, ${glance.mix.girls} girls` } : {})}
              />
              {glance.admittedThisMonth !== undefined && (
                <StatTile label="New this month" value={glance.admittedThisMonth} tone="green" icon={<UserPlus />} />
              )}
              {glance.leftThisMonth !== undefined && (
                <StatTile label="Left this month" value={glance.leftThisMonth} tone="orange" icon={<UserMinus />} />
              )}
            </StatRow>
          </DashboardCard>
        </Cell>
      )}

      {data.fees && (
        <Cell col={shortcuts.length > 0 ? 6 : 12} rows={3}>
          <DashboardCard title="Fees" description="Money in today and this month, and what is still owed." tone="green" icon={<Wallet />}>
            <FeeStatTiles fees={data.fees} />
          </DashboardCard>
        </Cell>
      )}

      {shortcuts.length > 0 && (
        <Cell col={6} rows={3}>
          <DashboardCard title="Shortcuts" tone="purple" icon={<Compass />}>
            <SimpleList
              items={shortcuts.map((link) => ({
                key: link.to,
                to: link.to,
                leading: <ToneBadge tone="purple">{link.icon}</ToneBadge>,
                primary: link.label,
                secondary: link.hint,
              }))}
            />
          </DashboardCard>
        </Cell>
      )}

      {data.classStrength && (
        <Cell col={12} rows={4}>
          <DashboardCard
            title="Class strength"
            description="How many students are in each class right now."
            tone="teal"
            icon={<LayoutGrid />}
            isLoading={isLoading && !data.classStrength}
            empty={
              data.classStrength.length === 0
                ? { icon: <LayoutGrid />, title: 'No classes yet', description: 'Class strength appears once the classes are set up.' }
                : undefined
            }
          >
            {data.classStrength.length > 0 ? <ClassStrengthList rows={data.classStrength} /> : undefined}
          </DashboardCard>
        </Cell>
      )}
    </BentoGrid>
  )
}
