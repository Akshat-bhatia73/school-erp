import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { IndianRupee, MoreHorizontal, Percent, Plus, Scale } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { CollectSheet } from '@/components/fees/collect-sheet'
import {
  BalanceCell, CONCESSION_CATEGORY_LABEL, FREQUENCY_LABEL, Money,
  RECEIPT_KIND_LABEL, ReceiptStateTag,
} from '@/components/fees/labels'
import { AdjustmentSheet, ConcessionSheet, OptInSheet, RemoveConcessionDialog } from '@/components/fees/pupil-sheets'
import { UserAvatar } from '@/components/shared/avatar'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, Facts, PageHeader, Panel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import type { FeeConcessionRecord, FeeOptInRecord } from '@/lib/api/fees'
import { describeError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { formatDate, formatPaise } from '@/lib/utils'

const searchSchema = z.object({ academicYearId: z.string().optional() })

export const Route = createFileRoute('/_app/fees/students/$studentId')({ component: Page, validateSearch: searchSchema })

/**
 * The years a statement can be read for. An office role reads the school's own year list; a
 * parent holds no year list and is offered the years their child was enrolled in, so last year's
 * statement stays a chip away after promotion. The current year comes first either way.
 */
function useStatementYears(studentId: string, currentYearId: string | null) {
  const { schoolId, hasPermission } = useSchoolContext()
  const { years } = useAcademicYear()
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
  return options
}

function Page() {
  const { studentId } = Route.useParams()
  const search = Route.useSearch()
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { currentYearId } = useAcademicYear()
  const yearOptions = useStatementYears(studentId, currentYearId)
  const [collectOpen, setCollectOpen] = useState(false)
  const [optInOpen, setOptInOpen] = useState(false)
  const [editingOptIn, setEditingOptIn] = useState<FeeOptInRecord | undefined>()
  const [concessionOpen, setConcessionOpen] = useState(false)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [removingConcession, setRemovingConcession] = useState<FeeConcessionRecord | null>(null)

  const params = { academicYearId: search.academicYearId ?? currentYearId ?? undefined }
  const statementQuery = useQuery({
    queryKey: qk.feeStatement(schoolId, studentId, params),
    queryFn: () => api.fees.statement(schoolId, studentId, params),
  })

  const removeOptIn = useMutation({
    mutationFn: (optIn: FeeOptInRecord) => api.fees.deleteOptIn(schoolId, optIn.id, optIn.version),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'fees'] })
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'dashboard'] })
      toast.success('Optional fee removed')
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  if (statementQuery.isError) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Fee dues', to: '/fees', icon: <IndianRupee /> }, { label: 'Not available' }]} />
        <EmptyState icon={<IndianRupee />} title="This statement is not available" description={describeError(statementQuery.error)} />
      </>
    )
  }

  const statement = statementQuery.data
  if (!statement) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Fee dues', to: '/fees', icon: <IndianRupee /> }, { label: 'Loading…' }]} />
        <div className="flex items-center gap-4 border-b p-3 md:p-5">
          <Skeleton className="size-16 rounded-lg" />
          <div className="grid gap-2"><Skeleton className="h-5 w-48" /><Skeleton className="h-4 w-64" /></div>
        </div>
      </>
    )
  }

  const { student, totals, allowedActions } = statement
  const canCollect = allows(allowedActions, 'fees.collect')
  const canManage = allows(allowedActions, 'fees.manage')
  const academicYearId = statement.academicYear.id
  // Every fee with anything left in the year is offered, and what has fallen due is filled in, so
  // a family can also pay ahead of the next instalment without asking for an adjustment first.
  const collectable = statement.lines
    .filter((line) => line.yearBalancePaise > 0)
    .map((line) => ({ feeHeadId: line.head.id, name: line.head.name, balancePaise: Math.max(line.balancePaise, 0) }))
  const heads = statement.lines.map((line) => ({ id: line.head.id, name: line.head.name }))
  const classLabel = student.grade ? (student.section ? `${student.grade.name} - ${student.section.name}` : student.grade.name) : undefined

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Fee dues', to: '/fees', icon: <IndianRupee /> }, { label: student.name }]}
        actions={
          <>
            {canCollect && <Button size="sm" onClick={() => setCollectOpen(true)}>Collect fee</Button>}
            {canManage && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button size="sm" variant="outline">More</Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-52">
                  <DropdownMenuItem onClick={() => { setEditingOptIn(undefined); setOptInOpen(true) }}><Plus />Add optional fee</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setConcessionOpen(true)}><Percent />Add concession</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAdjustOpen(true)}><Scale />Adjust what is due</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />

      <div className="flex items-start gap-3 border-b p-3 md:gap-4 md:p-5">
        <UserAvatar name={student.name} size="xl" className="size-12 md:size-16" />
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold md:text-xl">{student.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {classLabel && <Tag>{classLabel}</Tag>}
            {yearOptions.length > 1 ? (
              <FilterChip
                label="Year"
                value={statement.academicYear.id}
                options={yearOptions}
                onChange={(value) => void navigate({ to: '/fees/students/$studentId', params: { studentId }, search: { academicYearId: value }, replace: true })}
                clearable={false}
                allLabel={statement.academicYear.name}
              />
            ) : (
              <Tag color="blue">{statement.academicYear.name}</Tag>
            )}
          </div>
          <p className="mt-2 text-[13px] text-muted-foreground"><span className="font-mono">{student.admissionNumber}</span></p>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 scrollbar-thin md:p-4">
        <Panel title="This year" description={`Worked out as at ${formatDate(statement.asOf)}.`}>
          <Facts
            columns={4}
            items={[
              { label: 'Fee for the year', value: formatPaise(totals.chargedYearPaise) },
              { label: 'Concessions', value: formatPaise(totals.concessionYearPaise) },
              { label: 'Due so far', value: formatPaise(totals.dueToDatePaise) },
              { label: 'Paid', value: formatPaise(totals.paidPaise) },
              { label: 'Balance', value: <BalanceCell paise={totals.balancePaise} /> },
            ]}
          />
        </Panel>

        <Panel title="Fee by fee" bodyClassName="overflow-x-auto">
          <table className="w-full text-[13.5px]">
            <thead>
              <tr className="text-left text-[13px] text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Fee</th>
                <th className="py-2 pr-3 font-medium">How often</th>
                <th className="py-2 pr-3 font-medium">Instalments due</th>
                <th className="py-2 pr-3 font-medium">Charged</th>
                <th className="py-2 pr-3 font-medium">Concession</th>
                <th className="py-2 pr-3 font-medium">Adjustments</th>
                <th className="py-2 pr-3 font-medium">Due so far</th>
                <th className="py-2 pr-3 font-medium">Paid</th>
                <th className="py-2 font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              {statement.lines.map((line) => (
                <tr key={line.head.id} className="border-t">
                  <td className="py-2 pr-3 font-medium">{line.head.name}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{FREQUENCY_LABEL[line.frequency]}</td>
                  <td className="py-2 pr-3 tabular-nums">{line.instalmentsDue} of {line.instalments}</td>
                  <td className="py-2 pr-3"><Money paise={line.chargedYearPaise} /></td>
                  <td className="py-2 pr-3"><Money paise={line.concessionYearPaise} /></td>
                  <td className="py-2 pr-3"><Money paise={line.adjustmentPaise} /></td>
                  <td className="py-2 pr-3"><Money paise={line.dueToDatePaise} /></td>
                  <td className="py-2 pr-3"><Money paise={line.paidPaise} /></td>
                  <td className="py-2"><BalanceCell paise={line.balancePaise} /></td>
                </tr>
              ))}
              {statement.lines.length === 0 && (
                <tr><td colSpan={9} className="py-4 text-muted-foreground">Nothing is charged to this pupil yet.</td></tr>
              )}
            </tbody>
          </table>
        </Panel>

        <Panel title="Optional fees" description="Fees only this pupil is charged.">
          {statement.optIns.length === 0 ? (
            <p className="text-[13.5px] text-muted-foreground">None.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {statement.optIns.map((optIn) => (
                <li key={optIn.id} className="flex min-h-11 items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{optIn.head.name}</span>
                  <span className="shrink-0 text-[12.5px] text-muted-foreground">
                    {optIn.amountPaise !== undefined ? formatPaise(optIn.amountPaise) : 'Class amount'} · from {formatDate(optIn.startsOn)}
                    {optIn.endsOn ? ` to ${formatDate(optIn.endsOn)}` : ''}
                  </span>
                  {canManage && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${optIn.head.name}`}><MoreHorizontal /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => { setEditingOptIn(optIn); setOptInOpen(true) }}>Change or end it</DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => removeOptIn.mutate(optIn)}>Remove</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Concessions" description="What this family is charged less.">
          {statement.concessions.length === 0 ? (
            <p className="text-[13.5px] text-muted-foreground">None.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {statement.concessions.map((concession) => (
                <li key={concession.id} className="flex min-h-11 items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{concession.head?.name ?? 'Every fee'}</span>
                  <Tag color="teal">
                    {concession.percentBp !== undefined
                      ? `${concession.percentBp / 100}% off`
                      : concession.amountPaise !== undefined
                        ? `${formatPaise(concession.amountPaise)} off`
                        : 'Concession'}
                  </Tag>
                  <span className="shrink-0 text-[12.5px] text-muted-foreground">{CONCESSION_CATEGORY_LABEL[concession.category]}</span>
                  {canManage && (
                    <Button variant="ghost" size="sm" onClick={() => setRemovingConcession(concession)}>Remove</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Receipts and adjustments" description="Every entry against this pupil, newest first.">
          {statement.receipts.length === 0 ? (
            <p className="text-[13.5px] text-muted-foreground">Nothing recorded yet.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {statement.receipts.map((receipt) => (
                <li key={receipt.id}>
                  <button
                    type="button"
                    onClick={() => void navigate({ to: '/fees/receipts/$receiptId', params: { receiptId: receipt.id } })}
                    className="flex min-h-11 w-full items-center gap-3 py-2 text-left hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <span className="w-40 shrink-0 truncate font-mono text-[12.5px]">{receipt.receiptNumber}</span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px]">{RECEIPT_KIND_LABEL[receipt.kind]}</span>
                    <span className="shrink-0 text-[12.5px] text-muted-foreground">{formatDate(receipt.receivedOn)}</span>
                    <span className="shrink-0"><Money paise={receipt.amountPaise} /></span>
                    <span className="w-32 shrink-0 text-right"><ReceiptStateTag state={receipt.state} /></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {canCollect && (
        <CollectSheet
          key={`collect:${statement.asOf}:${collectable.length}`}
          open={collectOpen}
          onOpenChange={setCollectOpen}
          studentId={student.id}
          studentName={student.name}
          academicYearId={academicYearId}
          lines={collectable}
        />
      )}
      {canManage && (
        <OptInSheet
          key={editingOptIn ? `optin:${editingOptIn.id}:${editingOptIn.version}` : 'optin:new'}
          open={optInOpen}
          onOpenChange={setOptInOpen}
          studentId={student.id}
          academicYearId={academicYearId}
          optIn={editingOptIn}
        />
      )}
      {canManage && (
        <ConcessionSheet open={concessionOpen} onOpenChange={setConcessionOpen} studentId={student.id} academicYearId={academicYearId} />
      )}
      {canManage && (
        <AdjustmentSheet open={adjustOpen} onOpenChange={setAdjustOpen} studentId={student.id} academicYearId={academicYearId} heads={heads} />
      )}
      {canManage && (
        <RemoveConcessionDialog concession={removingConcession} onClose={() => setRemovingConcession(null)} />
      )}
    </>
  )
}
