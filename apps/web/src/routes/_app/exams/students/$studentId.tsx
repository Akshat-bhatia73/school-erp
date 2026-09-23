/**
 * One pupil's results for a year, then their report cards. Staff see live marks; a family sees
 * each exam as it was published, and grades alone when the school shows grades.
 */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { EXAM_PATTERN } from '@erp/contracts'
import { ChevronDown, ChevronRight, FileText, NotebookPen } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'
import { CARD_LABELS, componentLabel, examLabel, markText, percentText } from '@/components/exams/labels'
import { UserAvatar } from '@/components/shared/avatar'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Panel } from '@/components/shared/page'
import { colorFor, Tag } from '@/components/shared/tag'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import type { ExamResults } from '@/lib/api/exams'
import type { StudentReportCards } from '@/lib/api/report-cards'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { formatDate } from '@/lib/utils'

const searchSchema = z.object({ academicYearId: z.string().optional().catch(undefined) })

export const Route = createFileRoute('/_app/exams/students/$studentId')({ component: Page, validateSearch: searchSchema })

/**
 * The years to offer: the school's list for an office role, else the years this child was
 * enrolled in (a parent holds no year list). The current year comes first.
 */
function useYears(studentId: string) {
  const { schoolId, hasPermission } = useSchoolContext()
  const { years, currentYearId } = useAcademicYear()
  const enrolments = useQuery({
    queryKey: qk.studentEnrollments(schoolId, studentId),
    queryFn: () => api.students.enrollments(schoolId, studentId),
    enabled: years.length === 0 && hasPermission('students.read_enrollments'),
  })
  const seen = new Map<string, string>()
  for (const year of years) seen.set(year.id, year.name)
  for (const row of enrolments.data ?? []) seen.set(row.academicYear.id, row.academicYear.name)
  const options = [...seen].map(([value, label]) => ({ value, label }))
  options.sort((a, b) => (a.value === currentYearId ? -1 : b.value === currentYearId ? 1 : b.label.localeCompare(a.label)))
  // Without a current year from the server, the newest enrolment stands in for it.
  return { options, fallback: currentYearId ?? options[0]?.value ?? null, settled: years.length > 0 || !enrolments.isLoading }
}

function ExamPanel({ exam, marks }: { exam: ExamResults['exams'][number]; marks: boolean }) {
  const components = EXAM_PATTERN[exam.exam.kind].components
  const th = 'border-b px-2 py-1.5 text-left text-[12px] font-medium text-muted-foreground'
  const td = 'border-b px-2 py-1.5 text-[13.5px] tabular-nums'
  return (
    <Panel title={examLabel(exam.exam.kind)} description={exam.publishedAt ? `Published ${formatDate(exam.publishedAt)}` : 'Not published yet'}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={th}>Subject</th>
              {marks && components.map((component) => <th key={component} className={`${th} text-right`}>{componentLabel(component)}</th>)}
              {marks && <th className={`${th} text-right`}>Total</th>}
              <th className={`${th} text-right`}>Grade</th>
            </tr>
          </thead>
          <tbody>
            {exam.subjects.map((subject) => (
              <tr key={subject.subject.id}>
                <td className={`${td} font-medium`}>{subject.subject.name}</td>
                {marks && components.map((component) => (
                  <td key={component} className={`${td} text-right`}>{markText(subject.components.find((c) => c.component === component)?.value)}</td>
                ))}
                {marks && <td className={`${td} text-right`}>{percentText(subject.percentage)}</td>}
                <td className={`${td} text-right font-medium`}>{subject.grade ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function Cards({ data }: { data: StudentReportCards }) {
  const [showEarlier, setShowEarlier] = useState(false)
  // The newest version of each card leads; earlier versions of the same card fold away.
  const latest = data.cards.filter((card) => card.latest)
  const earlier = data.cards.filter((card) => !card.latest)
  const row = (card: StudentReportCards['cards'][number]) => (
    <li key={card.id}>
      <Link to="/exams/report-cards/$versionId" params={{ versionId: card.id }} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent">
        <FileText className="size-4 text-muted-foreground" />
        <span className="flex-1 text-[13.5px]">{CARD_LABELS[card.card]} report card</span>
        <span className="text-[12.5px] text-muted-foreground">Version {card.versionNumber} · {formatDate(card.publishedAt)}</span>
      </Link>
    </li>
  )
  return (
    <Panel title="Report cards">
      {data.cards.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No report card has been published for this year yet.</p>
      ) : (
        <>
          <ul>{latest.map(row)}</ul>
          {earlier.length > 0 && (
            <>
              <button type="button" onClick={() => setShowEarlier(!showEarlier)} className="mt-1 flex items-center gap-1 px-2 text-[12.5px] text-muted-foreground hover:text-foreground">
                {showEarlier ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                {earlier.length} earlier {earlier.length === 1 ? 'version' : 'versions'}
              </button>
              {showEarlier && <ul className="mt-1">{earlier.map(row)}</ul>}
            </>
          )}
        </>
      )}
    </Panel>
  )
}

function Page() {
  const { studentId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const { schoolId, hasPermission } = useSchoolContext()
  const years = useYears(studentId)
  const yearId = search.academicYearId ?? years.fallback
  const params = { academicYearId: yearId ?? '' }

  const resultsQuery = useQuery({
    queryKey: qk.examResults(schoolId, studentId, params),
    queryFn: () => api.exams.results(schoolId, studentId, params),
    enabled: yearId !== null && hasPermission('exams.read'),
  })
  const cardsQuery = useQuery({
    queryKey: qk.studentReportCards(schoolId, studentId, params),
    queryFn: () => api.reportCards.forStudent(schoolId, studentId, params),
    enabled: yearId !== null && hasPermission('report_cards.read'),
  })

  const data = resultsQuery.data
  const name = data?.student.name ?? cardsQuery.data?.student.name
  const header = <PageHeader crumbs={[{ label: 'Exams', to: '/exams', icon: <NotebookPen /> }, { label: name ?? 'Loading…' }]} />

  if (yearId === null && years.settled) {
    return <>{header}<EmptyState icon={<NotebookPen />} title="Nothing to show yet" description="Results appear here once the school publishes them." /></>
  }
  if (resultsQuery.isError) {
    return <>{header}<EmptyState icon={<NotebookPen />} title="Results are not available" description={describeError(resultsQuery.error)} /></>
  }
  if (!data && resultsQuery.isLoading) {
    return <>{header}<div className="space-y-3 p-3 md:p-4"><Skeleton className="h-20 w-full" /><Skeleton className="h-48 w-full" /></div></>
  }

  const classLabel = data?.grade ? (data.section ? `${data.grade.name} - ${data.section.name}` : data.grade.name) : undefined
  const marks = data?.displayMode !== 'grades'
  const yearName = data?.academicYear.name ?? cardsQuery.data?.academicYear.name
  const shown = data?.exams.filter((exam) => exam.subjects.length > 0) ?? []

  return (
    <>
      {header}
      <div className="flex items-start gap-3 border-b p-3 md:gap-4 md:p-5">
        <UserAvatar name={name ?? ''} size="xl" className="size-12 md:size-16" />
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold md:text-xl">{name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {classLabel && <Tag color={colorFor(classLabel)}>{classLabel}</Tag>}
            {years.options.length > 1 && yearId ? (
              <FilterChip
                label="Year"
                value={yearId}
                options={years.options}
                onChange={(value) => void navigate({ to: '/exams/students/$studentId', params: { studentId }, search: { academicYearId: value }, replace: true })}
                clearable={false}
                allLabel={yearName}
              />
            ) : yearName ? <Tag color="blue">{yearName}</Tag> : null}
          </div>
          {data && <p className="mt-2 text-[13px] text-muted-foreground"><span className="font-mono">{data.student.admissionNumber}</span></p>}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 scrollbar-thin md:p-4">
        {data && (shown.length === 0 ? (
          <Panel><p className="text-[13px] text-muted-foreground">Results appear here once the school publishes them.</p></Panel>
        ) : (
          shown.map((exam) => <ExamPanel key={exam.exam.id} exam={exam} marks={marks} />)
        ))}
        {cardsQuery.isError ? (
          <Panel title="Report cards"><p className="text-[13px] text-muted-foreground">{describeError(cardsQuery.error)}</p></Panel>
        ) : cardsQuery.data ? <Cards data={cardsQuery.data} /> : null}
      </div>
    </>
  )
}
