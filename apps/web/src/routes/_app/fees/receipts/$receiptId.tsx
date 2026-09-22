import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { FileDown, Receipt } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  Money, PAYMENT_MODE_LABEL, RECEIPT_KIND_LABEL, ReceiptStateTag,
} from '@/components/fees/labels'
import { CancelReceiptDialog, RefundSheet } from '@/components/fees/receipt-actions'
import { EmptyState, Facts, PageHeader, Panel } from '@/components/shared/page'
import { useExportDownload } from '@/components/shared/export-download'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { formatDate, formatPaise } from '@/lib/utils'

export const Route = createFileRoute('/_app/fees/receipts/$receiptId')({ component: Page })

function Page() {
  const { receiptId } = Route.useParams()
  const { schoolId } = useSchoolContext()
  const exportFile = useExportDownload()
  const [refundOpen, setRefundOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)

  const receiptQuery = useQuery({
    queryKey: qk.feeReceipt(schoolId, receiptId),
    queryFn: () => api.fees.receipt(schoolId, receiptId),
  })

  const startExport = useMutation({
    mutationFn: () => api.fees.exportReceipt(schoolId, receiptId),
    onSuccess: (job) => exportFile.start(job),
    onError: (error) => toast.error(describeError(error)),
  })

  if (receiptQuery.isError) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Collections', to: '/fees/collections', icon: <Receipt /> }, { label: 'Not available' }]} />
        <EmptyState icon={<Receipt />} title="This receipt is not available" description={describeError(receiptQuery.error)} />
      </>
    )
  }

  const receipt = receiptQuery.data
  if (!receipt) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Collections', to: '/fees/collections', icon: <Receipt /> }, { label: 'Loading…' }]} />
        <div className="p-3 md:p-5"><Skeleton className="h-24 w-full rounded-xl" /></div>
      </>
    )
  }

  const canManage = allows(receipt.allowedActions, 'fees.manage')
  const refundable = receipt.refundablePaise ?? 0
  const canRefund = canManage && receipt.kind === 'payment' && refundable > 0
  const canCancel = canManage && receipt.kind === 'payment' && receipt.state === 'standing'

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Collections', to: '/fees/collections', icon: <Receipt /> }, { label: receipt.receiptNumber }]}
        actions={
          <>
            <Button size="sm" variant="outline" disabled={startExport.isPending} onClick={() => startExport.mutate()}>
              <FileDown />{startExport.isPending ? 'Preparing…' : 'Download receipt'}
            </Button>
            {canRefund && <Button size="sm" variant="outline" onClick={() => setRefundOpen(true)}>Refund</Button>}
            {canCancel && <Button size="sm" variant="destructive" onClick={() => setCancelOpen(true)}>Cancel receipt</Button>}
          </>
        }
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 scrollbar-thin md:p-4">
        {exportFile.status}
        <Panel title={receipt.receiptNumber} description="A receipt is never edited. A refund or a cancellation is a new entry.">
          <Facts
            columns={3}
            items={[
              { label: 'Kind', value: RECEIPT_KIND_LABEL[receipt.kind] },
              { label: 'Date', value: formatDate(receipt.receivedOn) },
              { label: 'State', value: <ReceiptStateTag state={receipt.state} /> },
              {
                label: 'Pupil',
                value: (
                  <Link to="/fees/students/$studentId" params={{ studentId: receipt.student.id }} className="link-dotted">
                    {receipt.student.name}
                  </Link>
                ),
              },
              { label: 'Admission number', value: <span className="font-mono">{receipt.student.admissionNumber}</span> },
              { label: 'Academic year', value: receipt.academicYear.name },
              { label: 'Mode', value: receipt.mode ? PAYMENT_MODE_LABEL[receipt.mode] : '—' },
              { label: 'Reference', value: receipt.reference ?? '—' },
              { label: 'Paid by', value: receipt.payerName ?? '—' },
            ]}
          />
        </Panel>

        <Panel title="What it covers">
          <ul className="flex flex-col divide-y">
            {receipt.lines.map((line) => (
              <li key={line.head.id} className="flex min-h-10 items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{line.head.name}</span>
                <Money paise={line.amountPaise} />
              </li>
            ))}
            <li className="flex min-h-10 items-center gap-3 py-2 font-semibold">
              <span className="min-w-0 flex-1">Total</span>
              <span className="tabular-nums">{formatPaise(receipt.amountPaise)}</span>
            </li>
          </ul>
          {receipt.refundablePaise !== undefined && (
            <p className="mt-2 text-[12.5px] text-muted-foreground">{formatPaise(receipt.refundablePaise)} of this can still be refunded.</p>
          )}
        </Panel>

        {receipt.reverses && (
          <Panel title="What this reverses">
            <Link to="/fees/receipts/$receiptId" params={{ receiptId: receipt.reverses.id }} className="link-dotted font-mono text-[13px]">
              {receipt.reverses.receiptNumber}
            </Link>
          </Panel>
        )}

        {receipt.reversedBy.length > 0 && (
          <Panel title="What reverses this">
            <ul className="flex flex-col divide-y">
              {receipt.reversedBy.map((entry) => (
                <li key={entry.id} className="flex min-h-10 items-center gap-3 py-2">
                  <Link to="/fees/receipts/$receiptId" params={{ receiptId: entry.id }} className="link-dotted w-40 shrink-0 truncate font-mono text-[12.5px]">
                    {entry.receiptNumber}
                  </Link>
                  <span className="min-w-0 flex-1 truncate text-[13.5px]">{RECEIPT_KIND_LABEL[entry.kind]}</span>
                  <span className="shrink-0 text-[12.5px] text-muted-foreground">{formatDate(entry.receivedOn)}</span>
                  <Money paise={entry.amountPaise} />
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>

      {canRefund && <RefundSheet key={`refund:${receipt.id}:${refundable}`} open={refundOpen} onOpenChange={setRefundOpen} receipt={receipt} />}
      {canCancel && <CancelReceiptDialog open={cancelOpen} onOpenChange={setCancelOpen} receipt={receipt} />}
    </>
  )
}
