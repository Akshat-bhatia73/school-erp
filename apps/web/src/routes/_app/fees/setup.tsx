import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { IndianRupee, MoreHorizontal, Plus, Tags } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  APPLIES_TO_LABEL, FREQUENCY_LABEL, HEAD_CATEGORY_LABEL, Money,
} from '@/components/fees/labels'
import { FeeHeadSheet, FeeStructureSheet } from '@/components/fees/setup-sheets'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import type { FeeHeadRecord, FeeStructureRecord } from '@/lib/api/fees'
import { describeError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'

export const Route = createFileRoute('/_app/fees/setup')({ component: Page })

function Page() {
  const { hasPermission } = useSchoolContext()
  const canManage = hasPermission('fees.manage')
  const [tab, setTab] = useState('heads')

  return (
    <>
      <PageHeader crumbs={[{ label: 'Fees', to: '/fees', icon: <IndianRupee /> }, { label: 'Fee setup' }]} />
      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
        <TabsList variant="line" className="px-3">
          <TabsTrigger value="heads">Fees charged</TabsTrigger>
          <TabsTrigger value="amounts">Amounts</TabsTrigger>
        </TabsList>
        <TabsContent value="heads" className="flex min-h-0 flex-1 flex-col"><HeadsTab canManage={canManage} /></TabsContent>
        <TabsContent value="amounts" className="flex min-h-0 flex-1 flex-col"><AmountsTab canManage={canManage} /></TabsContent>
      </Tabs>
    </>
  )
}

/** What the school charges. Each row is the school's own name for a fee. */
function HeadsTab({ canManage }: { canManage: boolean }) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<FeeHeadRecord | undefined>()
  const [pending, setPending] = useState<FeeHeadRecord | null>(null)

  const { data: heads = [], isLoading, error } = useQuery({
    queryKey: qk.feeHeads(schoolId),
    queryFn: () => api.fees.heads(schoolId),
  })

  const remove = useMutation({
    mutationFn: (head: FeeHeadRecord) => api.fees.deleteHead(schoolId, head.id, head.version),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'fees'] })
      toast.success('Fee removed')
      setPending(null)
    },
    // A fee somebody has already been charged cannot go; the server says so in its own words.
    onError: (failure) => toast.error(describeError(failure)),
  })

  const columns = useMemo<ColumnDef<FeeHeadRecord, unknown>[]>(() => [
    { id: 'name', header: 'Fee', size: 220, cell: ({ row }) => <EntityCell avatar={<Tags />} name={row.original.name} /> },
    { id: 'category', header: 'Category', size: 150, cell: ({ row }) => HEAD_CATEGORY_LABEL[row.original.category] },
    { id: 'appliesTo', header: 'Who pays', size: 200, cell: ({ row }) => APPLIES_TO_LABEL[row.original.appliesTo] },
    { id: 'frequency', header: 'How often', size: 150, cell: ({ row }) => FREQUENCY_LABEL[row.original.frequency] },
    { id: 'active', header: 'In use', size: 110, cell: ({ row }) => <Tag color={row.original.active ? 'green' : 'grey'}>{row.original.active ? 'In use' : 'Retired'}</Tag> },
    {
      id: 'actions', header: '', size: 60, enableSorting: false,
      cell: ({ row }) => allows(row.original.allowedActions, 'fees.manage') ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.original.name}`} onClick={(event) => event.stopPropagation()}><MoreHorizontal /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => { setEditing(row.original); setSheetOpen(true) }}>Edit</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => setPending(row.original)}>Remove</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null,
    },
  ], [])

  return (
    <>
      <Toolbar
        right={canManage ? <Button size="sm" onClick={() => { setEditing(undefined); setSheetOpen(true) }}><Plus />Add fee</Button> : undefined}
      />
      {error ? (
        <EmptyState icon={<Tags />} title="Fees are not available" description={describeError(error)} />
      ) : (
        <DataTable
          columns={columns}
          data={heads}
          isLoading={isLoading}
          getRowId={(row) => row.id}
          emptyState={<EmptyState icon={<Tags />} title="No fees yet" description="Add what the school charges: tuition, transport, exams." />}
          footer={<span>{heads.length} {heads.length === 1 ? 'fee' : 'fees'}</span>}
        />
      )}
      {canManage && (
        <FeeHeadSheet key={editing ? `head:${editing.id}:${editing.version}` : 'head:new'} open={sheetOpen} onOpenChange={setSheetOpen} head={editing} />
      )}
      <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pending?.name}?</AlertDialogTitle>
            <AlertDialogDescription>A fee somebody has already paid cannot be removed. Retire it instead so it stops being charged.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction disabled={remove.isPending} onClick={(event) => { event.preventDefault(); if (pending) remove.mutate(pending) }}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** How much each fee costs in one academic year, for every class or for one. */
function AmountsTab({ canManage }: { canManage: boolean }) {
  const { schoolId, hasPermission } = useSchoolContext()
  const queryClient = useQueryClient()
  const { years, currentYearId } = useAcademicYear()
  const [pickedYearId, setPickedYearId] = useState<string | undefined>()
  const [gradeId, setGradeId] = useState<string | undefined>()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<FeeStructureRecord | undefined>()
  const [pending, setPending] = useState<FeeStructureRecord | null>(null)

  const academicYearId = pickedYearId ?? currentYearId ?? ''
  const params = { academicYearId, gradeId }

  const { data: grades = [] } = useQuery({
    queryKey: qk.grades(schoolId),
    queryFn: () => api.setup.grades(schoolId),
    enabled: hasPermission('grades.read'),
  })

  const { data: structures = [], isLoading, error } = useQuery({
    queryKey: qk.feeStructures(schoolId, params),
    queryFn: () => api.fees.structures(schoolId, { academicYearId, gradeId }),
    enabled: academicYearId !== '',
  })

  const remove = useMutation({
    mutationFn: (structure: FeeStructureRecord) => api.fees.deleteStructure(schoolId, structure.id, structure.version),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'fees'] })
      toast.success('Amount removed')
      setPending(null)
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const columns = useMemo<ColumnDef<FeeStructureRecord, unknown>[]>(() => [
    { id: 'head', header: 'Fee', size: 220, cell: ({ row }) => <EntityCell avatar={<IndianRupee />} name={row.original.head.name} /> },
    { id: 'grade', header: 'Class', size: 160, cell: ({ row }) => row.original.grade?.name ?? 'Every class' },
    { id: 'frequency', header: 'How often', size: 150, cell: ({ row }) => FREQUENCY_LABEL[row.original.frequency] },
    { id: 'amount', header: 'Amount per instalment', size: 190, cell: ({ row }) => <Money paise={row.original.amountPaise} /> },
    {
      id: 'actions', header: '', size: 60, enableSorting: false,
      cell: ({ row }) => allows(row.original.allowedActions, 'fees.manage') ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.original.head.name}`} onClick={(event) => event.stopPropagation()}><MoreHorizontal /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => { setEditing(row.original); setSheetOpen(true) }}>Edit</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => setPending(row.original)}>Remove</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null,
    },
  ], [])

  return (
    <>
      <Toolbar
        right={canManage ? (
          <Button size="sm" disabled={academicYearId === ''} onClick={() => { setEditing(undefined); setSheetOpen(true) }}><Plus />Set amount</Button>
        ) : undefined}
      >
        {years.length > 0 && (
          <FilterChip
            label="Year"
            value={academicYearId || undefined}
            options={years.map((year) => ({ value: year.id, label: year.name }))}
            onChange={(value) => setPickedYearId(value ?? undefined)}
            clearable={false}
            allLabel="Current year"
          />
        )}
        {grades.length > 0 && (
          <FilterChip
            label="Class"
            value={gradeId}
            options={grades.map((grade) => ({ value: grade.id, label: grade.name }))}
            onChange={setGradeId}
            allLabel="Any"
          />
        )}
      </Toolbar>
      {error ? (
        <EmptyState icon={<IndianRupee />} title="Amounts are not available" description={describeError(error)} />
      ) : (
        <DataTable
          columns={columns}
          data={structures}
          isLoading={isLoading}
          getRowId={(row) => row.id}
          emptyState={<EmptyState icon={<IndianRupee />} title="No amounts set" description="Set what each fee costs this year." />}
          footer={<span>{structures.length} {structures.length === 1 ? 'amount' : 'amounts'}</span>}
        />
      )}
      {canManage && academicYearId !== '' && (
        <FeeStructureSheet
          key={editing ? `structure:${editing.id}:${editing.version}` : `structure:new:${academicYearId}`}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          academicYearId={academicYearId}
          structure={editing}
        />
      )}
      <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this amount?</AlertDialogTitle>
            <AlertDialogDescription>An amount that has already been paid against cannot be removed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction disabled={remove.isPending} onClick={(event) => { event.preventDefault(); if (pending) remove.mutate(pending) }}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
