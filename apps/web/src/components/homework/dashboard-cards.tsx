/** The homework blocks on the home screens. Each is drawn only when the dashboard sent its field. */
import type { DashboardHomeworkDue, DashboardHomeworkDueItem, DashboardHomeworkToCheckItem } from '@erp/contracts'
import { BookOpenCheck, NotebookText } from 'lucide-react'
import { DashboardCard } from '@/components/dashboard/blocks/card'
import { SimpleList } from '@/components/dashboard/blocks/list'
import { formatDate } from '@/lib/utils'
import { classLabel, PupilStatusTag, subjectLabel } from './labels'

/** One child's "Homework due" lists, with the child's name when the card holds more than one. */
export interface HomeworkDueGroup { key: string; name?: string; due: DashboardHomeworkDue }

function dueRows(group: HomeworkDueGroup, day: 'today' | 'tomorrow', items: DashboardHomeworkDueItem[]) {
  return items.map((item) => ({
    key: `${group.key}-${day}-${item.homeworkId}`,
    to: `/homework/${item.homeworkId}`,
    primary: `${subjectLabel(item.subject)} · ${item.title}`,
    secondary: [group.name, day === 'today' ? 'Due today' : 'Due tomorrow'].filter(Boolean).join(' · '),
    right: <PupilStatusTag status={item.status} />,
  }))
}

/** A family's or a pupil's items due today and tomorrow. */
export function HomeworkDueCard({ groups }: { groups: HomeworkDueGroup[] }) {
  const rows = groups.flatMap((group) => [...dueRows(group, 'today', group.due.today), ...dueRows(group, 'tomorrow', group.due.tomorrow)])
  return (
    <DashboardCard
      title="Homework due"
      description="Today and tomorrow"
      tone="indigo"
      icon={<NotebookText />}
      empty={rows.length === 0 ? { icon: <NotebookText />, title: 'Nothing due today or tomorrow' } : undefined}
    >
      {rows.length > 0 ? <SimpleList items={rows} /> : undefined}
    </DashboardCard>
  )
}

/** A teacher's items past their due date with pupils not checked, oldest first. */
export function HomeworkToCheckCard({ items }: { items: DashboardHomeworkToCheckItem[] }) {
  return (
    <DashboardCard
      title="To check"
      description="Homework past its due date with pupils not checked"
      tone="indigo"
      icon={<BookOpenCheck />}
      empty={items.length === 0 ? { icon: <BookOpenCheck />, title: 'All homework is checked', description: 'No homework of yours is waiting to be checked.' } : undefined}
    >
      {items.length > 0 ? (
        <SimpleList
          items={items.map((item) => ({
            key: item.homeworkId,
            to: `/homework/${item.homeworkId}`,
            primary: `${subjectLabel(item.subject)} · ${classLabel(item.grade, item.section)}`,
            secondary: `${item.title} · due ${formatDate(item.dueOn)}`,
            right: `${item.notChecked} of ${item.pupils} not checked`,
          }))}
        />
      ) : undefined}
    </DashboardCard>
  )
}
