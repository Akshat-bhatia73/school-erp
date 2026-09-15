import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table'
import { BookOpen, MoreHorizontal, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { Tag, type TagColor } from '@/components/shared/tag'
import { SetupTabs } from '@/components/setup/setup-tabs'
import { SubjectSheet } from '@/components/setup/subject-sheet'
import { SubjectMatrix } from '@/components/setup/subject-matrix'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import type { SubjectRecord } from '@/lib/api/setup'
import { describeError, isApiError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { humanize } from '@/lib/utils'

export const Route = createFileRoute('/_app/setup/subjects')({ component: Page })

const TYPE_COLOR: Record<SubjectRecord['type'], TagColor> = { scholastic: 'blue', language: 'purple', co_scholastic: 'teal', elective: 'orange' }
const STILL_IN_USE = 'This still has students or a timetable. Move them first.'

function Page() {
  const { schoolId, hasPermission } = useSchoolContext()
  const canManage = hasPermission('subjects.manage')
  const canReadGrades = hasPermission('grades.read')
  const queryClient = useQueryClient()
  const { currentYearId } = useAcademicYear()
  const yearId = currentYearId ?? ''
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<SubjectRecord | undefined>()
  const [pending, setPending] = useState<SubjectRecord | null>(null)
  const [selection, setSelection] = useState<RowSelectionState>({})

  const { data: subjects = [], isLoading, error } = useQuery({
    queryKey: qk.subjects(schoolId),
    queryFn: () => api.setup.subjects(schoolId),
  })
  const { data: grades = [], isLoading: gradesLoading } = useQuery({
    queryKey: qk.grades(schoolId),
    queryFn: () => api.setup.grades(schoolId),
    enabled: canReadGrades,
  })
  const linkParams = { academicYearId: yearId }
  const { data: links = [] } = useQuery({
    queryKey: qk.gradeSubjects(schoolId, linkParams),
    queryFn: () => api.setup.gradeSubjects(schoolId, linkParams),
    enabled: !!yearId,
  })

  const usedIn = useMemo(() => {
    const out: Record<string, Set<string>> = {}
    for (const link of links) (out[link.subject.id] ??= new Set()).add(link.gradeId)
    return out
  }, [links])

  const remove = useMutation({
    mutationFn: (subject: SubjectRecord) => api.setup.deleteSubject(schoolId, subject.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'subjects'] })
      toast.success('Subject removed')
      setPending(null)
    },
    onError: (failure) => toast.error(isApiError(failure, 'INVALID_REQUEST') ? STILL_IN_USE : describeError(failure)),
  })

  const columns = useMemo<ColumnDef<SubjectRecord, unknown>[]>(() => [
    { id: 'name', header: 'Name', accessorFn: (r) => r.name, cell: ({ row }) => <EntityCell avatar={<BookOpen />} name={row.original.name} /> },
    { id: 'code', header: 'Code', size: 120, accessorFn: (r) => r.code, cell: ({ row }) => <span className="font-mono text-[12.5px] text-muted-foreground">{row.original.code}</span> },
    { id: 'type', header: 'Type', size: 170, accessorFn: (r) => r.type, cell: ({ row }) => <Tag color={TYPE_COLOR[row.original.type]}>{humanize(row.original.type)}</Tag> },
    {
      id: 'used', header: 'Used in', size: 140, accessorFn: (r) => usedIn[r.id]?.size ?? 0,
      cell: ({ row }) => {
        const count = usedIn[row.original.id]?.size ?? 0
        return <span className="tabular-nums text-muted-foreground">{count ? `${count} ${count === 1 ? 'class' : 'classes'}` : '—'}</span>
      },
    },
    {
      id: 'actions', header: '', size: 60, enableSorting: false,
      cell: ({ row }) => canManage ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.original.name}`} onClick={(e) => e.stopPropagation()}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => { setEditing(row.original); setSheetOpen(true) }}>Edit</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => setPending(row.original)}>Remove</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null,
    },
  ], [canManage, usedIn])

  const addButton = (label: string) => (
    <Button size="sm" onClick={() => { setEditing(undefined); setSheetOpen(true) }}><Plus /> {label}</Button>
  )

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'School setup' }, { label: 'Subjects' }]}
        actions={canManage ? addButton('Add subject') : undefined}
        hideOnMobile
      />
      <SetupTabs actions={canManage ? addButton('Add') : undefined} />
      {error ? (
        <p className="p-5 text-[13.5px] text-muted-foreground">{describeError(error)}</p>
      ) : (
        <Tabs defaultValue="all" className="min-h-0 flex-1 gap-0">
          <div className="flex h-12 shrink-0 items-center border-b bg-card px-4">
            <TabsList>
              <TabsTrigger value="all">All subjects</TabsTrigger>
              {canReadGrades && <TabsTrigger value="by-class">By class</TabsTrigger>}
            </TabsList>
          </div>
          <TabsContent value="all" className="flex min-h-0 flex-1 flex-col">
            <DataTable
              columns={columns}
              data={subjects}
              isLoading={isLoading}
              selectable
              rowSelection={selection}
              onRowSelectionChange={setSelection}
              getRowId={(r) => r.id}
              emptyState={<EmptyState icon={<BookOpen />} title="No subjects yet" description="Add subjects like Mathematics or Hindi, then map them to classes." />}
              footer={<span>{subjects.length} {subjects.length === 1 ? 'subject' : 'subjects'} in view</span>}
            />
          </TabsContent>
          {canReadGrades && (
            <TabsContent value="by-class" className="flex min-h-0 flex-1 flex-col">
              {yearId
                ? <SubjectMatrix academicYearId={yearId} grades={grades} subjects={subjects} canEdit={canManage} isLoading={isLoading || gradesLoading} />
                : <EmptyState title="No academic year yet" description="Add an academic year before mapping subjects to classes." />}
            </TabsContent>
          )}
        </Tabs>
      )}
      <SubjectSheet open={sheetOpen} onOpenChange={setSheetOpen} subject={editing} />
      <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pending?.name}?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone. A subject can only be removed once no class studies it.</AlertDialogDescription>
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
