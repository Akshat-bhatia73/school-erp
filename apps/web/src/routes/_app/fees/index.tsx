import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { IndianRupee, Search } from 'lucide-react'
import { useMemo } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { FeeExportMenu, type FeeFileFormat } from '@/components/fees/export-menu'
import { BalanceCell, Money } from '@/components/fees/labels'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { useExportDownload } from '@/components/shared/export-download'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { colorFor, Tag } from '@/components/shared/tag'
import { useSectionOptions } from '@/components/students/use-section-options'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import type { FeeDuesRowRecord } from '@/lib/api/fees'
import { describeError } from '@/lib/api-errors'
import { audienceFor } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { formatPaise } from '@/lib/utils'

const searchSchema = z.object({
  q: z.string().max(100).optional().catch(undefined),
  academicYearId: z.string().optional(),
  gradeId: z.string().optional(),
  sectionId: z.string().optional(),
  show: z.enum(['all', 'due']).default('all'),
  page: z.number().int().min(1).default(1),
})
type DuesSearch = z.infer<typeof searchSchema>

export const Route = createFileRoute('/_app/fees/')({ component: Page, validateSearch: searchSchema })

const PAGE_SIZE = 25

/** "6 - A" the way the roster writes it, from whatever the row carries. */
function classLabel(row: FeeDuesRowRecord): string | undefined {
  const { grade, section } = row.student
  if (!grade) return undefined
  return section ? `${grade.name} - ${section.name}` : grade.name
}

function Page() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { schoolId, roleKeys, hasPermission } = useSchoolContext()
  const { years, currentYearId } = useAcademicYear()
  const isParent = audienceFor(roleKeys) === 'parent'
  const exportFile = useExportDownload({ className: 'px-4 pb-2' })

  const setSearch = (patch: Partial<DuesSearch>) =>
    void navigate({ search: (old) => ({ ...old, page: 1, ...patch }), replace: true })

  const academicYearId = search.academicYearId ?? currentYearId ?? undefined
  const { options: sectionOptions } = useSectionOptions(isParent ? null : academicYearId)
  const { data: grades = [] } = useQuery({
    queryKey: qk.grades(schoolId),
    queryFn: () => api.setup.grades(schoolId),
    enabled: !isParent && hasPermission('grades.read'),
  })
  // The section chip only offers sections of the class already picked.
  const sections = search.gradeId ? sectionOptions.filter((option) => option.gradeId === search.gradeId) : sectionOptions

  const params = {
    page: search.page,
    pageSize: PAGE_SIZE,
    academicYearId,
    gradeId: search.gradeId,
    sectionId: search.sectionId,
    show: search.show,
    q: search.q,
  }

  const duesQuery = useQuery({
    queryKey: qk.feeDues(schoolId, params),
    queryFn: () => api.fees.dues(schoolId, params),
  })

  const startExport = useMutation({
    mutationFn: (format: FeeFileFormat) =>
      api.fees.exportDues(schoolId, {
        academicYearId: academicYearId as string,
        gradeId: search.gradeId,
        sectionId: search.sectionId,
        show: search.show,
        format,
      }),
    onSuccess: (job) => {
      exportFile.start(job)
      toast.success('Export started')
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const rows = duesQuery.data?.items ?? []
  const totals = duesQuery.data?.totals

  const columns = useMemo<ColumnDef<FeeDuesRowRecord, unknown>[]>(() => [
    {
      id: 'student',
      header: 'Pupil',
      size: 260,
      cell: ({ row }) => <EntityCell name={row.original.student.name} sub={row.original.student.admissionNumber} />,
    },
    {
      id: 'class',
      header: 'Class',
      size: 120,
      cell: ({ row }) => {
        const label = classLabel(row.original)
        if (!label) return <span className="text-muted-foreground/60">—</span>
        return <Tag color={colorFor(row.original.student.grade!.name)}>{label}</Tag>
      },
    },
    { id: 'charged', header: 'Fee for the year', size: 140, cell: ({ row }) => <Money paise={row.original.chargedYearPaise} /> },
    { id: 'due', header: 'Due so far', size: 130, cell: ({ row }) => <Money paise={row.original.dueToDatePaise} /> },
    { id: 'paid', header: 'Paid', size: 130, cell: ({ row }) => <Money paise={row.original.paidPaise} /> },
    { id: 'balance', header: 'Balance', size: 150, cell: ({ row }) => <BalanceCell paise={row.original.balancePaise} /> },
  ], [])

  const header = (
    <PageHeader
      crumbs={[{ label: isParent ? 'Fees' : 'Fee dues', icon: <IndianRupee /> }]}
      actions={
        <>
          {hasPermission('fees.export') && academicYearId && (
            <FeeExportMenu isPending={startExport.isPending} onPick={(format) => startExport.mutate(format)} />
          )}
          {!isParent && (
            <Button size="sm" variant="outline" onClick={() => void navigate({ to: '/fees/collections' })}>Collections</Button>
          )}
          {hasPermission('fees.manage') && (
            <Button size="sm" variant="outline" onClick={() => void navigate({ to: '/fees/setup' })}>Fee setup</Button>
          )}
        </>
      }
    />
  )

  if (duesQuery.isError) {
    return (
      <>
        {header}
        <EmptyState icon={<IndianRupee />} title="Fees are not available" description={describeError(duesQuery.error)} />
      </>
    )
  }

  return (
    <>
      {header}
      <Toolbar
        search={isParent ? undefined : (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search.q ?? ''}
              onChange={(event) => setSearch({ q: event.target.value.slice(0, 100) || undefined })}
              maxLength={100}
              placeholder="Search name or admission number"
              aria-label="Search pupils"
              className="w-full pl-8 md:w-56"
            />
          </div>
        )}
      >
        {years.length > 0 && (
          <FilterChip
            label="Year"
            value={academicYearId}
            options={years.map((year) => ({ value: year.id, label: year.name }))}
            onChange={(value) => setSearch({ academicYearId: value, sectionId: undefined })}
            clearable={false}
            allLabel="Current year"
          />
        )}
        {!isParent && grades.length > 0 && (
          <FilterChip
            label="Class"
            value={search.gradeId}
            options={grades.map((grade) => ({ value: grade.id, label: grade.name }))}
            onChange={(value) => setSearch({ gradeId: value, sectionId: undefined })}
            allLabel="Any"
          />
        )}
        {!isParent && sections.length > 0 && (
          <FilterChip
            label="Section"
            value={search.sectionId}
            options={sections.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(value) => setSearch({ sectionId: value })}
            allLabel="Any"
          />
        )}
        <FilterChip
          label="Show"
          value={search.show}
          options={[{ value: 'all' as const, label: 'Everyone' }, { value: 'due' as const, label: 'With dues' }]}
          onChange={(value) => setSearch({ show: value ?? 'all' })}
          clearable={false}
        />
      </Toolbar>
      {exportFile.status}
      <DataTable
        columns={columns}
        data={rows}
        isLoading={duesQuery.isLoading}
        getRowId={(row) => row.student.id}
        rowLink={(row) => `/fees/students/${row.student.id}`}
        mobileRow={(row) => ({
          title: row.student.name,
          subtitle: `${row.student.admissionNumber}${classLabel(row) ? ` · ${classLabel(row)}` : ''}`,
          trailing: <BalanceCell paise={row.balancePaise} />,
        })}
        emptyState={<EmptyState icon={<IndianRupee />} title="Nobody to show" description="Try a different class or year." />}
        footer={
          <>
            <span>{rows.length} pupils in view</span>
            {totals && <span>{formatPaise(totals.outstandingPaise)} outstanding</span>}
            {totals && <span>{totals.studentsWithDues} with dues</span>}
          </>
        }
        pagination={{ page: search.page, pageSize: PAGE_SIZE, total: duesQuery.data?.total ?? 0, onPageChange: (page) => void navigate({ search: (old) => ({ ...old, page }) }) }}
      />
    </>
  )
}
