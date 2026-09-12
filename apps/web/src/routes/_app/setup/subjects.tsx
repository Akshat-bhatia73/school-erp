import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table'
import { BookOpen, MoreHorizontal, Plus } from 'lucide-react'
import { toast } from 'sonner'
import type { Subject, SubjectType } from '@erp/shared'
import { api } from '@/api/client'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { Tag, type TagColor } from '@/components/shared/tag'
import { SetupTabs } from '@/components/setup/setup-tabs'
import { SubjectSheet } from '@/components/setup/subject-sheet'
import { SubjectMatrix } from '@/components/setup/subject-matrix'
import { useAcademicYears } from '@/components/setup/use-current-year'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { humanize } from '@/lib/utils'

export const Route = createFileRoute('/_app/setup/subjects')({ component: Page })

const TYPE_COLOR: Record<SubjectType, TagColor> = { scholastic: 'blue', language: 'purple', co_scholastic: 'teal', elective: 'orange' }

function Page() {
  const canEdit = useSession().can('school_setup', 'edit')
  const qc = useQueryClient()
  const { current } = useAcademicYears()
  const yearId = current?.id ?? ''
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<Subject | undefined>()
  const [selection, setSelection] = useState<RowSelectionState>({})

  const { data: subjects = [], isLoading } = useQuery({ queryKey: qk.subjects, queryFn: () => api.subjects.list() })
  const { data: grades = [] } = useQuery({ queryKey: qk.grades, queryFn: () => api.grades.list() })
  const { data: links = [] } = useQuery({ queryKey: qk.gradeSubjects({ academicYearId: yearId }), queryFn: () => api.subjects.gradeSubjects({ academicYearId: yearId }), enabled: !!yearId })

  const usedIn = useMemo(() => {
    const out: Record<string, Set<string>> = {}
    for (const l of links) (out[l.subjectId] ??= new Set()).add(l.gradeId)
    return out
  }, [links])

  const remove = useMutation({
    mutationFn: (id: string) => api.subjects.remove(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.subjects }); qc.invalidateQueries({ queryKey: ['gradeSubjects'] }); toast.success('Subject removed') },
    onError: (e: Error) => toast.error(e.message),
  })

  const columns = useMemo<ColumnDef<Subject, unknown>[]>(() => [
    { id: 'name', header: 'Name', accessorFn: (r) => r.name, cell: ({ row }) => <EntityCell avatar={<BookOpen />} name={row.original.name} /> },
    { id: 'code', header: 'Code', size: 120, accessorFn: (r) => r.code, cell: ({ row }) => <span className="font-mono text-[12.5px] text-muted-foreground">{row.original.code}</span> },
    { id: 'type', header: 'Type', size: 170, accessorFn: (r) => r.type, cell: ({ row }) => <Tag color={TYPE_COLOR[row.original.type]}>{humanize(row.original.type)}</Tag> },
    {
      id: 'used', header: 'Used in', size: 140, accessorFn: (r) => usedIn[r.id]?.size ?? 0,
      cell: ({ row }) => {
        const n = usedIn[row.original.id]?.size ?? 0
        return <span className="tabular-nums text-muted-foreground">{n ? `${n} ${n === 1 ? 'class' : 'classes'}` : '—'}</span>
      },
    },
    {
      id: 'actions', header: '', size: 60, enableSorting: false,
      cell: ({ row }) => canEdit ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" onClick={(e) => e.stopPropagation()}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => { setEditing(row.original); setSheetOpen(true) }}>Edit</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => remove.mutate(row.original.id)}>Remove</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null,
    },
  ], [canEdit, usedIn, remove])

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'School setup' }, { label: 'Subjects' }]}
        actions={canEdit ? <Button size="sm" onClick={() => { setEditing(undefined); setSheetOpen(true) }}><Plus /> Add subject</Button> : undefined}
      />
      <SetupTabs />
      <Tabs defaultValue="all" className="min-h-0 flex-1 gap-0">
        <div className="flex h-12 shrink-0 items-center border-b bg-card px-4">
          <TabsList>
            <TabsTrigger value="all">All subjects</TabsTrigger>
            <TabsTrigger value="by-class">By class</TabsTrigger>
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
        <TabsContent value="by-class" className="flex min-h-0 flex-1 flex-col">
          <SubjectMatrix academicYearId={yearId} grades={grades} subjects={subjects} canEdit={canEdit && !!yearId} isLoading={isLoading} />
        </TabsContent>
      </Tabs>
      <SubjectSheet open={sheetOpen} onOpenChange={setSheetOpen} subject={editing} />
    </>
  )
}
