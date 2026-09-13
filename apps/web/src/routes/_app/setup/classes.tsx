import { useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Building2, MoreHorizontal, Plus, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import type { Grade, Section } from '@erp/shared'
import { api } from '@/api/client'
import { DataTable } from '@/components/shared/data-table'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { UserAvatar } from '@/components/shared/avatar'
import { SetupTabs } from '@/components/setup/setup-tabs'
import { GradeSheet } from '@/components/setup/grade-sheet'
import { SectionSheet } from '@/components/setup/section-sheet'
import { useAcademicYears } from '@/components/setup/use-current-year'
import { MobilePicker } from '@/components/shared/mobile-picker'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { cn, fullName } from '@/lib/utils'

export const Route = createFileRoute('/_app/setup/classes')({ component: Page })

function Page() {
  const { can } = useSession()
  const canEdit = can('school_setup', 'edit')
  const qc = useQueryClient()
  const { current } = useAcademicYears()
  const yearId = current?.id ?? ''

  const [gradeId, setGradeId] = useState<string>('')
  const [gradeSheet, setGradeSheet] = useState(false)
  const [sectionSheet, setSectionSheet] = useState(false)
  const [editing, setEditing] = useState<Section | undefined>()

  const { data: grades = [], isLoading: gradesLoading } = useQuery({ queryKey: qk.grades, queryFn: () => api.grades.list() })
  const { data: allSections = [], isLoading: sectionsLoading } = useQuery({ queryKey: qk.sections({ academicYearId: yearId }), queryFn: () => api.sections.list({ academicYearId: yearId }), enabled: !!yearId })
  const { data: strengths = {} } = useQuery({ queryKey: qk.sectionStrengths(yearId), queryFn: () => api.sections.strengths(yearId), enabled: !!yearId })
  const { data: staff } = useQuery({ queryKey: qk.staff({ pageSize: 500 }), queryFn: () => api.staff.list({ pageSize: 500 }) })

  useEffect(() => { if (!gradeId && grades.length) setGradeId(grades[0]!.id) }, [grades, gradeId])

  const staffById = useMemo(() => new Map((staff?.items ?? []).map((s) => [s.id, s])), [staff])
  const studentsByGrade = useMemo(() => {
    const out: Record<string, number> = {}
    for (const s of allSections) out[s.gradeId] = (out[s.gradeId] ?? 0) + (strengths[s.id] ?? 0)
    return out
  }, [allSections, strengths])

  const grade: Grade | undefined = grades.find((g) => g.id === gradeId)
  const sections = useMemo(() => allSections.filter((s) => s.gradeId === gradeId), [allSections, gradeId])

  const remove = useMutation({
    mutationFn: (id: string) => api.sections.remove(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sections'] }); qc.invalidateQueries({ queryKey: ['sectionStrengths'] }); toast.success('Section removed') },
    onError: (e: Error) => toast.error(e.message),
  })

  const columns = useMemo<ColumnDef<Section, unknown>[]>(() => [
    {
      id: 'name', header: 'Section', size: 150, accessorFn: (r) => r.name,
      cell: ({ row }) => (
        <div className="flex items-center gap-2.5">
          <span className="flex size-6 items-center justify-center rounded-md border bg-muted/60 text-[11px] font-semibold">{row.original.name}</span>
          <span className="font-medium link-dotted">{grade?.name} - {row.original.name}</span>
        </div>
      ),
    },
    {
      id: 'teacher', header: 'Class teacher', accessorFn: (r) => r.classTeacherId ?? '',
      cell: ({ row }) => {
        const t = row.original.classTeacherId ? staffById.get(row.original.classTeacherId) : undefined
        if (!t) {
          return canEdit ? (
            <button type="button" onClick={() => { setEditing(row.original); setSectionSheet(true) }} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-dashed px-2 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground">
              <UserPlus className="size-3.5" /> Assign
            </button>
          ) : <span className="text-muted-foreground/60">—</span>
        }
        return <span className="flex items-center gap-2"><UserAvatar name={fullName(t)} size="sm" />{fullName(t)}</span>
      },
    },
    {
      id: 'students', header: 'Students', size: 170, accessorFn: (r) => strengths[r.id] ?? 0,
      cell: ({ row }) => {
        const n = strengths[row.original.id] ?? 0
        const cap = row.original.capacity ?? 0
        const pct = cap ? Math.min(100, Math.round((n / cap) * 100)) : 0
        return (
          <div className="w-32">
            <div className="tabular-nums">{n}{cap ? <span className="text-muted-foreground"> / {cap}</span> : null}</div>
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
              <div className={cn('h-full rounded-full', pct > 95 ? 'bg-tag-red' : 'bg-tag-blue')} style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      },
    },
    { id: 'room', header: 'Room', size: 120, accessorFn: (r) => r.roomNumber ?? '', cell: ({ row }) => <span className="text-muted-foreground">{row.original.roomNumber || '—'}</span> },
    {
      id: 'actions', header: '', size: 60, enableSorting: false,
      cell: ({ row }) => canEdit ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" onClick={(e) => e.stopPropagation()}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => { setEditing(row.original); setSectionSheet(true) }}>Edit</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => remove.mutate(row.original.id)}>Remove</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null,
    },
  ], [canEdit, grade, staffById, strengths, remove])

  const totalStudents = sections.reduce((a, s) => a + (strengths[s.id] ?? 0), 0)

  const gradeList = (onPick?: () => void) => gradesLoading
    ? <div className="grid gap-2 px-3">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-9 rounded-lg" />)}</div>
    : grades.length === 0
    ? <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No classes yet.</p>
    : grades.map((g) => (
        <button
          key={g.id}
          type="button"
          onClick={() => { setGradeId(g.id); onPick?.() }}
          className={cn('flex h-11 w-full shrink-0 items-center justify-between gap-2 border-l-2 border-transparent px-4 text-left text-[13.5px] hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:-outline-offset-2 md:h-10', g.id === gradeId && 'border-l-foreground bg-accent font-medium')}
        >
          <span className="truncate">{g.name}{g.stream ? <span className="ml-1 text-muted-foreground capitalize">· {g.stream}</span> : null}</span>
          <span className="tabular-nums text-[12px] text-muted-foreground">{studentsByGrade[g.id] ?? 0}</span>
        </button>
      ))

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'School setup' }, { label: 'Classes & sections' }]}
        actions={canEdit ? <Button size="sm" variant="outline" onClick={() => setGradeSheet(true)}><Plus /> Add class</Button> : undefined}
      />
      <SetupTabs />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <MobilePicker label="Class" value={grade?.name} title="Pick a class">
          {(close) => gradeList(() => close())}
        </MobilePicker>
        <aside className="hidden w-72 shrink-0 flex-col overflow-auto border-r bg-card scrollbar-thin md:flex">
          <div className="px-4 pt-4 pb-2 text-[12px] font-medium tracking-wide text-muted-foreground">Classes</div>
          {gradeList()}
        </aside>

        <div className="flex min-w-0 min-h-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center justify-between border-b bg-card px-4">
            <h2 className="text-[14px] font-semibold">{grade?.name ?? 'Select a class'}{current ? <span className="ml-2 text-[12.5px] font-normal text-muted-foreground">{current.name}</span> : null}</h2>
            {canEdit && grade && <Button size="sm" disabled={!yearId} onClick={() => { setEditing(undefined); setSectionSheet(true) }}><Plus /> Add section</Button>}
          </div>
          <DataTable
            columns={columns}
            data={sections}
            isLoading={gradesLoading || sectionsLoading}
            getRowId={(r) => r.id}
            emptyState={<EmptyState icon={<Building2 />} title="No sections in this class" description="Add a section like A to start placing students." />}
            footer={<span>{sections.length} {sections.length === 1 ? 'section' : 'sections'} · {totalStudents} students</span>}
          />
        </div>
      </div>
      <GradeSheet open={gradeSheet} onOpenChange={setGradeSheet} nextOrder={(grades[grades.length - 1]?.order ?? -1) + 1} />
      <SectionSheet open={sectionSheet} onOpenChange={setSectionSheet} section={editing} gradeId={gradeId} academicYearId={yearId} />
    </>
  )
}
