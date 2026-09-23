/** The exams blocks on the home screens. Each is drawn only when the dashboard sent its field. */
import { Link } from '@tanstack/react-router'
import type { DashboardExams, DashboardMarksToEnter, DashboardReportCard } from '@erp/contracts'
import { NotebookPen } from 'lucide-react'
import { DashboardCard } from '@/components/dashboard/blocks/card'
import { SimpleList } from '@/components/dashboard/blocks/list'
import { formatDate } from '@/lib/utils'
import { CARD_LABELS, EnteredBar, examLabel } from './labels'

/** A teacher's marks sheets with empty cells, soonest deadline first. */
export function MarksToEnterCard({ items }: { items: DashboardMarksToEnter[] }) {
  return (
    <DashboardCard
      title="Marks to enter"
      description="Your marks sheets with empty cells"
      tone="orange"
      icon={<NotebookPen />}
      empty={items.length === 0 ? { icon: <NotebookPen />, title: 'All marks are in', description: 'No marks sheet of yours is waiting.' } : undefined}
    >
      {items.length > 0 ? (
        <SimpleList
          items={items.map((item) => ({
            key: item.paperId,
            to: `/exams/papers/${item.paperId}`,
            primary: `${item.subject.name} · ${item.grade.name} - ${item.section.name}`,
            secondary: `${examLabel(item.exam.kind)} · until ${formatDate(item.exam.recheckDeadline)}`,
            right: <EnteredBar entered={item.entered} expected={item.expected} />,
          }))}
        />
      ) : undefined}
    </DashboardCard>
  )
}

/** The office's exams for the year: what is outstanding, ready and published. */
export function ExamsCard({ exams }: { exams: DashboardExams }) {
  return (
    <DashboardCard
      title="Exams"
      description="This year's exams"
      tone="orange"
      icon={<NotebookPen />}
      empty={exams.items.length === 0 ? { icon: <NotebookPen />, title: 'No exams set up yet' } : undefined}
    >
      {exams.items.length > 0 ? (
        <SimpleList
          items={exams.items.map((exam) => ({
            key: exam.examId,
            to: `/exams/${exam.examId}`,
            primary: examLabel(exam.kind),
            secondary: exam.locked
              ? `${exam.sectionsReadyToPublish} ${exam.sectionsReadyToPublish === 1 ? 'section' : 'sections'} ready to publish`
              : `${exam.papersOutstanding} ${exam.papersOutstanding === 1 ? 'paper' : 'papers'} still to fill · until ${formatDate(exam.recheckDeadline)}`,
            right: `${exam.sectionsPublished} of ${exam.sectionsTotal} published`,
          }))}
        />
      ) : undefined}
    </DashboardCard>
  )
}

/** The link to a child's newest report card, on the parent's child card. */
export function ReportCardLink({ card }: { card: DashboardReportCard }) {
  return (
    <Link to="/exams/report-cards/$versionId" params={{ versionId: card.versionId }} className="link-dotted">
      {CARD_LABELS[card.card]} · {card.academicYear.name} · {formatDate(card.publishedAt)}
    </Link>
  )
}
