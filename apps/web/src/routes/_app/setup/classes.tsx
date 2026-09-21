import { useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Building2, MoreHorizontal, Plus, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { DataTable } from '@/components/shared/data-table'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { FilterChip } from '@/components/shared/filter-chip'
import { UserAvatar } from '@/components/shared/avatar'
import { MobilePicker } from '@/components/shared/mobile-picker'
import { SetupTabs } from '@/components/setup/setup-tabs'
import { GradeSheet } from '@/components/setup/grade-sheet'
import { SectionSheet } from '@/components/setup/section-sheet'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import type { GradeRecord, SectionRecord } from '@/lib/api/setup'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { allows } from '@/lib/permissions'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/setup/classes')({ component: Page })

type Pending = { kind: 'grade'; record: GradeRecord } | { kind: 'section'; record: SectionRecord }

function Page() {
  const { schoolId, hasPermission } = useSchoolContext()
  const canManageGrades = hasPermission('grades.manage')
  const canManageSections = hasPermission('sections.manage')
  const canReadStrengths = hasPermission('sections.read_strengths')
  const queryClient = useQueryClient()

  const { years, currentYearId, isLoading: yearLoading } = useAcademicYear()
  const [pickedYearId, setPickedYearId] = useState<string | undefined>()
  const yearId = pickedYearId ?? currentYearId ?? ''

  const [gradeId, setGradeId] = useState<string>('')
  const [gradeSheet, setGradeSheet] = useState(false)
  const [editingGrade, setEditingGrade] = useState<GradeRecord | undefined>()
  const [sectionSheet, setSectionSheet] = useState(false)
  const [editingSection, setEditingSection] = useState<SectionRecord | undefined>()
  const [pending, setPending] = useState<Pending | null>(null)

  const { data: grades = [], isLoading: gradesLoading, error: gradesError } = useQuery({
    queryKey: qk.grades(schoolId),
    queryFn: () => api.setup.grades(schoolId),
  })
  const sectionParams = { academicYearId: yearId }
  const { data: allSections = [], isLoading: sectionsLoading, error: sectionsError } = useQuery({
    queryKey: qk.sections(schoolId, sectionParams),
    queryFn: () => api.setup.sections(schoolId, sectionParams),
    enabled: !!yearId,
  })
  const { data: strengthRows = [] } = useQuery({
    queryKey: qk.sectionStrengths(schoolId, sectionParams),
    queryFn: () => api.setup.sectionStrengths(schoolId, { academicYearId: yearId }),
    enabled: !!yearId && canReadStrengths,
  })

  // Somebody who cannot add sections has no use for a class with nothing visible in the chosen year
  // (a teacher's class list still carries last year's classes), so only classes with a section show.
  const visibleGrades = useMemo(() => {
    if (canManageGrades) return grades
    const withSections = new Set(allSections.map((section) => section.gradeId))
    return grades.filter((g) => withSections.has(g.id))
  }, [canManageGrades, grades, allSections])

  useEffect(() => {
    if (visibleGrades.some((g) => g.id === gradeId)) return
    setGradeId(visibleGrades[0]?.id ?? '')
  }, [visibleGrades, gradeId])

  const strengths = useMemo(() => new Map(strengthRows.map((row) => [row.sectionId, row.count])), [strengthRows])
  const studentsByGrade = useMemo(() => {
    const out: Record<string, number> = {}
    for (const section of allSections) out[section.gradeId] = (out[section.gradeId] ?? 0) + (strengths.get(section.id) ?? 0)
    return out
  }, [allSections, strengths])

  const grade = grades.find((g) => g.id === gradeId)
  const sections = useMemo(() => allSections.filter((s) => s.gradeId === gradeId), [allSections, gradeId])

  const remove = useMutation({
    mutationFn: (target: Pending) => target.kind === 'grade'
      ? api.setup.deleteGrade(schoolId, target.record.id)
      : api.setup.deleteSection(schoolId, target.record.id),
    onSuccess: (_result, target) => {
      void queryClient.invalidateQueries({ queryKey: target.kind === 'grade' ? qk.grades(schoolId) : [schoolId, 'sections'] })
      toast.success(target.kind === 'grade' ? 'Class removed' : 'Section removed')
      // The removed class was the selected one, so let the effect pick the next class.
      if (target.kind === 'grade' && target.record.id === gradeId) setGradeId('')
      setPending(null)
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const columns = useMemo<ColumnDef<SectionRecord, unknown>[]>(() => [
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
        const teacher = row.original.classTeacher
        if (teacher) return <span className="flex items-center gap-2"><UserAvatar name={teacher.name} size="sm" />{teacher.name}</span>
        // A teacher this person may not read comes back as an id with no name.
        if (row.original.classTeacherId) return <span className="text-muted-foreground">Assigned</span>
        return allows(row.original.allowedActions, 'sections.manage') ? (
          <button
            type="button"
            onClick={() => { setEditingSection(row.original); setSectionSheet(true) }}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-dashed px-2 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <UserPlus className="size-3.5" /> Assign
          </button>
        ) : <span className="text-muted-foreground/60">Not set</span>
      },
    },
    ...(canReadStrengths ? [{
      id: 'students', header: 'Students', size: 170, accessorFn: (r: SectionRecord) => strengths.get(r.id) ?? 0,
      cell: ({ row }: { row: { original: SectionRecord } }) => {
        const count = strengths.get(row.original.id) ?? 0
        const capacity = row.original.capacity ?? 0
        const pct = capacity ? Math.min(100, Math.round((count / capacity) * 100)) : 0
        return (
          <div className="w-32">
            <div className="tabular-nums">{count}{capacity ? <span className="text-muted-foreground"> / {capacity}</span> : null}</div>
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
              <div className={cn('h-full rounded-full', pct > 95 ? 'bg-tag-red' : 'bg-tag-blue')} style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      },
    } as ColumnDef<SectionRecord, unknown>] : []),
    { id: 'room', header: 'Room', size: 120, accessorFn: (r) => r.roomNumber ?? '', cell: ({ row }) => <span className="text-muted-foreground">{row.original.roomNumber || '—'}</span> },
    {
      id: 'actions', header: '', size: 60, enableSorting: false,
      cell: ({ row }) => allows(row.original.allowedActions, 'sections.manage') ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for section ${row.original.name}`} onClick={(e) => e.stopPropagation()}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => { setEditingSection(row.original); setSectionSheet(true) }}>Edit</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => setPending({ kind: 'section', record: row.original })}>Remove</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null,
    },
  ], [canReadStrengths, grade, strengths])

  const totalStudents = sections.reduce((sum, section) => sum + (strengths.get(section.id) ?? 0), 0)

  const gradeList = (onPick?: () => void) => gradesLoading || yearLoading
    ? <div className="grid gap-2 px-3">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-9 rounded-lg" />)}</div>
    : visibleGrades.length === 0
    ? <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No classes yet.</p>
    : visibleGrades.map((g) => (
        <button
          key={g.id}
          type="button"
          onClick={() => { setGradeId(g.id); onPick?.() }}
          className={cn('flex h-11 w-full shrink-0 items-center justify-between gap-2 border-l-2 border-transparent px-4 text-left text-[13.5px] hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:-outline-offset-2 md:h-10', g.id === gradeId && 'border-l-foreground bg-accent font-medium')}
        >
          <span className="truncate">{g.name}{g.stream ? <span className="ml-1 text-muted-foreground capitalize">· {g.stream}</span> : null}</span>
          {canReadStrengths ? <span className="tabular-nums text-[12px] text-muted-foreground">{studentsByGrade[g.id] ?? 0}</span> : null}
        </button>
      ))

  const addClassButton = (label: string) => (
    <Button size="sm" variant="outline" onClick={() => { setEditingGrade(undefined); setGradeSheet(true) }}><Plus /> {label}</Button>
  )
  const activeYear = years.find((year) => year.id === yearId)

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'School setup' }, { label: 'Classes & sections' }]}
        actions={canManageGrades ? addClassButton('Add class') : undefined}
        hideOnMobile
      />
      <SetupTabs actions={canManageGrades ? addClassButton('Class') : undefined} />
      {years.length > 1 ? (
        <div className="flex items-center gap-2 border-b bg-card px-3 py-2 md:px-5">
          <FilterChip
            label="Year"
            value={yearId || undefined}
            options={years.map((year) => ({ value: year.id, label: year.name }))}
            onChange={(v) => setPickedYearId(v ?? undefined)}
            clearable={false}
            allLabel="Current year"
          />
        </div>
      ) : null}
      {gradesError ? (
        <p className="p-5 text-[13.5px] text-muted-foreground">{describeError(gradesError)}</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <MobilePicker label="Class" value={grade?.name} title="Pick a class">
            {(close) => gradeList(() => close())}
          </MobilePicker>
          <aside className="hidden w-72 shrink-0 flex-col overflow-auto border-r bg-card scrollbar-thin md:flex">
            <div className="px-4 pt-4 pb-2 text-[12px] font-medium tracking-wide text-muted-foreground">Classes</div>
            {gradeList()}
          </aside>

          <div className="flex min-w-0 min-h-0 flex-1 flex-col">
            <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b bg-card px-4">
              <h2 className="truncate text-[14px] font-semibold">
                {grade?.name ?? 'Select a class'}
                {activeYear ? <span className="ml-2 text-[12.5px] font-normal text-muted-foreground">{activeYear.name}</span> : null}
              </h2>
              <div className="flex items-center gap-2">
                {grade && allows(grade.allowedActions, 'grades.manage') && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${grade.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => { setEditingGrade(grade); setGradeSheet(true) }}>Edit class</DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onClick={() => setPending({ kind: 'grade', record: grade })}>Remove class</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {canManageSections && grade && (
                  <Button size="sm" disabled={!yearId} title={yearId ? undefined : 'Pick an academic year first'} onClick={() => { setEditingSection(undefined); setSectionSheet(true) }}>
                    <Plus /> Add section
                  </Button>
                )}
              </div>
            </div>
            {sectionsError ? (
              <p className="p-5 text-[13.5px] text-muted-foreground">{describeError(sectionsError)}</p>
            ) : (
            <DataTable
              columns={columns}
              data={sections}
              isLoading={gradesLoading || sectionsLoading || yearLoading}
              getRowId={(r) => r.id}
              emptyState={<EmptyState icon={<Building2 />} title="No sections in this class" description="Add a section like A to start placing students." />}
              footer={<span>{sections.length} {sections.length === 1 ? 'section' : 'sections'}{canReadStrengths ? ` · ${totalStudents} students` : ''}</span>}
            />
            )}
          </div>
        </div>
      )}
      <GradeSheet open={gradeSheet} onOpenChange={setGradeSheet} grade={editingGrade} nextOrder={(grades[grades.length - 1]?.order ?? -1) + 1} />
      <SectionSheet open={sectionSheet} onOpenChange={setSectionSheet} section={editingSection} gradeId={gradeId} academicYearId={yearId} />
      <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pending?.kind === 'grade' ? 'class' : 'section'} {pending?.record.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. A {pending?.kind === 'grade' ? 'class' : 'section'} can only be removed once nothing points at it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={(event) => { event.preventDefault(); if (pending) remove.mutate(pending) }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
