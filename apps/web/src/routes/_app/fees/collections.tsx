import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Receipt, Search } from 'lucide-react'
import { useMemo } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import type { FeePaymentMode, FeeReceiptKind } from '@erp/contracts'
import { FeeExportMenu, type FeeFileFormat } from '@/components/fees/export-menu'
import { monthStartIso, todayIso } from '@/components/fees/fee-form'
import {
  Money, PAYMENT_MODES, PAYMENT_MODE_LABEL, RECEIPT_KINDS, RECEIPT_KIND_LABEL, ReceiptStateTag,
} from '@/components/fees/labels'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { useExportDownload } from '@/components/shared/export-download'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import type { FeeReceiptSummaryRecord } from '@/lib/api/fees'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { formatDate, formatPaise } from '@/lib/utils'

const searchSchema = z.object({
  q: z.string().max(100).optional().catch(undefined),
  academicYearId: z.string().optional(),
  kind: z.enum(['payment', 'refund', 'cancellation', 'credit_adjustment', 'debit_adjustment']).optional(),
  mode: z.enum(['cash', 'cheque', 'upi', 'bank_transfer', 'demand_draft']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.number().int().min(1).default(1),
})
type CollectionsSearch = z.infer<typeof searchSchema>

export const Route = createFileRoute('/_app/fees/collections')({ component: Page, validateSearch: searchSchema })

const PAGE_SIZE = 25

function Page() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { schoolId, hasPermission } = useSchoolContext()
  const { years, currentYearId } = useAcademicYear()
  const exportFile = useExportDownload({ className: 'px-4 pb-2' })

  const setSearch = (patch: Partial<CollectionsSearch>) =>
    void navigate({ search: (old) => ({ ...old, page: 1, ...patch }), replace: true })

  // The register always covers a window. Until somebody picks one, it is this month so far.
  const from = search.from ?? monthStartIso()
  const to = search.to ?? todayIso()
  const academicYearId = search.academicYearId ?? currentYearId ?? undefined

  const params = {
    page: search.page,
    pageSize: PAGE_SIZE,
    academicYearId,
    from,
    to,
    kind: search.kind,
    mode: search.mode,
    q: search.q,
  }

  const ledger = useQuery({
    queryKey: qk.feeReceipts(schoolId, params),
    queryFn: () => api.fees.receipts(schoolId, params),
  })

  const startExport = useMutation({
    mutationFn: (format: FeeFileFormat) => api.fees.exportCollections(schoolId, { from, to, mode: search.mode, format }),
    onSuccess: (job) => {
      exportFile.start(job)
      toast.success('Export started')
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const rows = ledger.data?.items ?? []
  const totals = ledger.data?.totals

  const columns = useMemo<ColumnDef<FeeReceiptSummaryRecord, unknown>[]>(() => [
    {
      id: 'number',
      header: 'Number',
      size: 190,
      cell: ({ row }) => <EntityCell avatar={<Receipt />} name={<span className="font-mono text-[12.5px]">{row.original.receiptNumber}</span>} />,
    },
    { id: 'date', header: 'Date', size: 130, cell: ({ row }) => <span className="tabular-nums">{formatDate(row.original.receivedOn)}</span> },
    { id: 'student', header: 'Pupil', size: 220, cell: ({ row }) => <span className="truncate">{row.original.student.name}</span> },
    { id: 'kind', header: 'Kind', size: 150, cell: ({ row }) => RECEIPT_KIND_LABEL[row.original.kind] },
    { id: 'mode', header: 'Mode', size: 130, cell: ({ row }) => row.original.mode ? PAYMENT_MODE_LABEL[row.original.mode] : <span className="text-muted-foreground/60">—</span> },
    { id: 'amount', header: 'Amount', size: 140, cell: ({ row }) => <Money paise={row.original.amountPaise} /> },
    { id: 'state', header: 'State', size: 140, cell: ({ row }) => <ReceiptStateTag state={row.original.state} /> },
  ], [])

  const header = (
    <PageHeader
      crumbs={[{ label: 'Fees', to: '/fees', icon: <Receipt /> }, { label: 'Collections' }]}
      actions={hasPermission('fees.export') ? <FeeExportMenu isPending={startExport.isPending} onPick={(format) => startExport.mutate(format)} /> : undefined}
    />
  )

  if (ledger.isError) {
    return (
      <>
        {header}
        <EmptyState icon={<Receipt />} title="Collections are not available" description={describeError(ledger.error)} />
      </>
    )
  }

  return (
    <>
      {header}
      <Toolbar
        search={
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search.q ?? ''}
              onChange={(event) => setSearch({ q: event.target.value.slice(0, 100) || undefined })}
              maxLength={100}
              placeholder="Search receipt number or pupil"
              aria-label="Search receipts"
              className="w-full pl-8 md:w-60"
            />
          </div>
        }
        right={
          <span className="flex items-center gap-2">
            <Input type="date" aria-label="From date" value={from} onChange={(event) => setSearch({ from: event.target.value })} className="h-8 w-[9.5rem]" />
            <span className="text-[13px] text-muted-foreground">to</span>
            <Input type="date" aria-label="To date" value={to} onChange={(event) => setSearch({ to: event.target.value })} className="h-8 w-[9.5rem]" />
          </span>
        }
      >
        {years.length > 0 && (
          <FilterChip
            label="Year"
            value={academicYearId}
            options={years.map((year) => ({ value: year.id, label: year.name }))}
            onChange={(value) => setSearch({ academicYearId: value })}
            clearable={false}
            allLabel="Current year"
          />
        )}
        <FilterChip
          label="Kind"
          value={search.kind}
          options={RECEIPT_KINDS.map((kind) => ({ value: kind, label: RECEIPT_KIND_LABEL[kind] }))}
          onChange={(value) => setSearch({ kind: value as FeeReceiptKind | undefined })}
          allLabel="All kinds"
        />
        <FilterChip
          label="Mode"
          value={search.mode}
          options={PAYMENT_MODES.map((mode) => ({ value: mode, label: PAYMENT_MODE_LABEL[mode] }))}
          onChange={(value) => setSearch({ mode: value as FeePaymentMode | undefined })}
          allLabel="All modes"
        />
      </Toolbar>
      {exportFile.status}
      <DataTable
        columns={columns}
        data={rows}
        isLoading={ledger.isLoading}
        getRowId={(row) => row.id}
        rowLink={(row) => `/fees/receipts/${row.id}`}
        mobileRow={(row) => ({
          title: row.receiptNumber,
          subtitle: `${row.student.name} · ${RECEIPT_KIND_LABEL[row.kind]}`,
          meta: formatDate(row.receivedOn),
          trailing: <Money paise={row.amountPaise} />,
        })}
        emptyState={<EmptyState icon={<Receipt />} title="Nothing in this window" description="Try other dates, or a different kind." />}
        footer={
          <>
            <span>{totals ? formatPaise(totals.collectedPaise) : '—'} collected</span>
            <span>{totals ? formatPaise(totals.refundedPaise) : '—'} refunded</span>
            <span>{totals ? formatPaise(totals.netPaise) : '—'} net</span>
          </>
        }
        pagination={{ page: search.page, pageSize: PAGE_SIZE, total: ledger.data?.total ?? 0, onPageChange: (page) => void navigate({ search: (old) => ({ ...old, page }) }) }}
      />
    </>
  )
}
