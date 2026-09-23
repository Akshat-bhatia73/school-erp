/** Report cards by section: how far each class is, and the way into preparing and publishing. */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { ReportCardKind } from '@erp/contracts'
import { FileText, NotebookPen } from 'lucide-react'
import { useMemo } from 'react'
import { z } from 'zod'
import { CARD_LABELS } from '@/components/exams/labels'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { api } from '@/lib/api'
import type { ReportCardSectionRow } from '@/lib/api/report-cards'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'

const searchSchema = z.object({
  academicYearId: z.string().optional().catch(undefined),
  card: ReportCardKind.optional().catch(undefined),
})

export const Route = createFileRoute('/_app/exams/report-cards/')({ component: Page, validateSearch: searchSchema })

const CARD_OPTIONS = ReportCardKind.options.map((value) => ({ value, label: CARD_LABELS[value] }))

function Page() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { schoolId } = useSchoolContext()
  const { years, currentYearId, isLoading: yearLoading } = useAcademicYear()
  const yearId = search.academicYearId ?? currentYearId
  const card = search.card ?? 'term_1'
  const params = { academicYearId: yearId ?? '', card }
  const sectionsQuery = useQuery({
    queryKey: qk.reportCardSections(schoolId, params),
    queryFn: () => api.reportCards.sections(schoolId, params),
    enabled: yearId !== null,
  })
  const rows = sectionsQuery.data?.items ?? []

  const columns = useMemo<ColumnDef<ReportCardSectionRow, unknown>[]>(() => [
    { id: 'class', header: 'Class', size: 200, cell: ({ row }) => <EntityCell name={`${row.original.grade.name} - ${row.original.section.name}`} sub={`${row.original.pupils} pupils`} /> },
    { id: 'co', header: 'Co-scholastic entered', size: 170, cell: ({ row }) => <span className="tabular-nums">{row.original.coScholasticEntered} of {row.original.pupils}</span> },
    { id: 'published', header: 'Published', size: 120, cell: ({ row }) => <span className="tabular-nums">{row.original.published} of {row.original.pupils}</span> },
    { id: 'changed', header: 'Changed since published', size: 190, cell: ({ row }) => (row.original.changedSincePublished > 0 ? <Tag color="orange">{row.original.changedSincePublished} changed</Tag> : <span className="text-muted-foreground">—</span>) },
    { id: 'exams', header: 'Exams', size: 150, cell: ({ row }) => (row.original.examsReady ? <Tag color="green">Results published</Tag> : <Tag color="grey">Waiting for results</Tag>) },
  ], [])

  return (
    <>
      <PageHeader crumbs={[{ label: 'Exams', to: '/exams', icon: <NotebookPen /> }, { label: 'Report cards' }]} />
      <Toolbar>
        <FilterChip label="Card" value={card} options={CARD_OPTIONS} onChange={(value) => void navigate({ search: { ...search, card: value ?? 'term_1' }, replace: true })} clearable={false} />
        {years.length > 1 && yearId && (
          <FilterChip
            label="Year"
            value={yearId}
            options={years.map((year) => ({ value: year.id, label: year.name }))}
            onChange={(value) => void navigate({ search: { ...search, academicYearId: value }, replace: true })}
            clearable={false}
          />
        )}
      </Toolbar>
      {sectionsQuery.isError ? (
        <EmptyState icon={<FileText />} title="Report cards are not available" description={describeError(sectionsQuery.error)} />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={sectionsQuery.isLoading || yearLoading}
          getRowId={(row) => row.section.id}
          rowLink={(row) => `/exams/report-cards/sections/${row.section.id}?card=${card}`}
          mobileRow={(row) => ({
            title: `${row.grade.name} - ${row.section.name}`,
            subtitle: `${row.published} of ${row.pupils} published`,
            trailing: row.examsReady ? <Tag color="green">Ready</Tag> : undefined,
          })}
          emptyState={<EmptyState icon={<FileText />} title="No classes to show" description="Classes you prepare report cards for appear here." />}
          footer={<span>{rows.length} {rows.length === 1 ? 'section' : 'sections'} in view</span>}
        />
      )}
    </>
  )
}
