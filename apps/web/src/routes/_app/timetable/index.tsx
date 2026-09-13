import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AlertTriangle, CalendarDays, ChevronUp, Printer, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { DAY_LABELS } from '@erp/shared'
import { api, type TimetableCell } from '@/api/client'
import { FilterChip, ToolbarButton } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Panel, Toolbar } from '@/components/shared/page'
import { Tag, colorFor } from '@/components/shared/tag'
import { useAcademicYears } from '@/components/setup/use-current-year'
import { TimetableTabs } from '@/components/timetable/timetable-tabs'
import { TimetableGrid } from '@/components/timetable/timetable-grid'
import { DaySelector, defaultDay } from '@/components/timetable/day-selector'
import { SetPeriodDialog, type SetPeriodTarget } from '@/components/timetable/set-period-dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { useIsMobile } from '@/lib/use-media'

const searchSchema = z.object({ gradeId: z.string().optional(), sectionId: z.string().optional() })

export const Route = createFileRoute('/_app/timetable/')({ component: Page, validateSearch: searchSchema })

function Page() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const qc = useQueryClient()
  const { can } = useSession()
  const canEdit = can('timetable', 'edit')
  const { current } = useAcademicYears()
  const yearId = current?.id ?? ''

  const [target, setTarget] = useState<SetPeriodTarget | null>(null)
  const [day, setDay] = useState<number | undefined>()
  const [confirmGenerate, setConfirmGenerate] = useState(false)
  const [subjectsOpen, setSubjectsOpen] = useState(false)

  const { data: grades = [] } = useQuery({ queryKey: qk.grades, queryFn: () => api.grades.list() })
  const { data: allSections = [] } = useQuery({ queryKey: qk.sections({ academicYearId: yearId }), queryFn: () => api.sections.list({ academicYearId: yearId }), enabled: !!yearId })

  const gradeId = search.gradeId
  const sections = useMemo(() => allSections.filter((s) => s.gradeId === gradeId), [allSections, gradeId])
  const sectionId = search.sectionId

  // Default to the first grade and its first section once the lists arrive.
  useEffect(() => {
    if (!grades.length || !allSections.length) return
    if (gradeId && sectionId) return
    const g = gradeId ?? allSections.find((s) => grades.some((x) => x.id === s.gradeId))?.gradeId ?? grades[0]!.id
    const s = allSections.find((x) => x.gradeId === g)
    navigate({ search: { gradeId: g, sectionId: sectionId ?? s?.id }, replace: true })
  }, [grades, allSections, gradeId, sectionId, navigate])

  const grade = grades.find((g) => g.id === gradeId)
  const section = allSections.find((s) => s.id === sectionId)
  const sectionLabel = grade && section ? `${grade.name} - ${section.name}` : '—'

  const { data: bell, isLoading: bellLoading } = useQuery({ queryKey: [...qk.bellSchedules, sectionId ?? ''], queryFn: () => api.timetable.bellFor(sectionId), enabled: !!sectionId })
  const { data: cells = [], isLoading: cellsLoading } = useQuery({ queryKey: qk.timetableSection(sectionId ?? ''), queryFn: () => api.timetable.forSection(sectionId!), enabled: !!sectionId })
  const { data: conflicts = [] } = useQuery({ queryKey: qk.timetableConflicts, queryFn: () => api.timetable.conflicts() })
  const { data: gradeSubjects = [] } = useQuery({ queryKey: qk.gradeSubjects({ academicYearId: yearId, gradeId }), queryFn: () => api.subjects.gradeSubjects({ academicYearId: yearId, gradeId }), enabled: !!yearId && !!gradeId })
  const { data: allSubjects = [] } = useQuery({ queryKey: qk.subjects, queryFn: () => api.subjects.list() })

  const subjects = useMemo(() => {
    const ids = new Set(gradeSubjects.map((g) => g.subjectId))
    const forGrade = allSubjects.filter((s) => ids.has(s.id))
    return forGrade.length ? forGrade : allSubjects
  }, [gradeSubjects, allSubjects])

  const myConflicts = useMemo(() => {
    const staffIds = new Set(cells.map((c) => c.staffId).filter(Boolean))
    return conflicts.filter((c) => c.sectionId === sectionId || (c.staffId && staffIds.has(c.staffId)))
  }, [conflicts, cells, sectionId])

  const stats = useMemo(() => {
    if (!bell) return { filled: 0, total: 0, subjects: 0, teachers: 0 }
    const teachingSlots = bell.periods.filter((p) => p.type === 'period')
    let total = 0
    for (const d of bell.workingDays) {
      total += d === 6 && bell.saturdayPeriodCount !== undefined
        ? teachingSlots.filter((p) => p.index < bell.saturdayPeriodCount!).length
        : teachingSlots.length
    }
    return { filled: cells.length, total, subjects: new Set(cells.map((c) => c.subjectId)).size, teachers: new Set(cells.map((c) => c.staffId).filter(Boolean)).size }
  }, [bell, cells])

  const perSubject = useMemo(() => {
    const map = new Map<string, { name: string; code: string; count: number }>()
    for (const c of cells) {
      const key = c.subjectId
      const cur = map.get(key) ?? { name: c.subject?.name ?? 'Subject', code: c.subject?.code ?? key, count: 0 }
      cur.count++
      map.set(key, cur)
    }
    return [...map.values()].sort((a, b) => b.count - a.count)
  }, [cells])

  const generate = useMutation({
    mutationFn: () => api.timetable.generateForSection(sectionId!),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['timetable'] })
      qc.invalidateQueries({ queryKey: ['substitutions'] })
      toast.success(`Placed ${r.placed} periods${r.unplaced > 0 ? ` · ${r.unplaced} could not be placed` : ''}`)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const isMobile = useIsMobile()
  const workingDays = useMemo(() => [...(bell?.workingDays ?? [])].sort((a, b) => a - b), [bell])
  const shownDay = day !== undefined && workingDays.includes(day) ? day : defaultDay(workingDays)

  const subjectBreakdown = perSubject.length === 0 ? (
    <p className="text-[13px] text-muted-foreground">Nothing placed yet.</p>
  ) : (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {perSubject.map((s) => (
        <span key={s.code} className="flex items-center gap-1.5">
          <Tag color={colorFor(s.code)}>{s.name}</Tag>
          <span className="text-[13px] tabular-nums text-muted-foreground">{s.count}</span>
        </span>
      ))}
    </div>
  )

  const onCellClick = (dayOfWeek: number, periodIndex: number, existing?: TimetableCell) => {
    if (!canEdit) return
    const p = bell?.periods.find((x) => x.index === periodIndex)
    setTarget({ dayOfWeek, periodIndex, existing, periodName: p?.name ?? `Period ${periodIndex + 1}` })
  }

  return (
    <>
      <PageHeader crumbs={[{ label: 'Timetable' }, { label: 'Class timetable' }]} />
      <TimetableTabs />
      <Toolbar
        right={
          <>
            {canEdit && (
              <ToolbarButton icon={<Wand2 />} onClick={() => setConfirmGenerate(true)}>Generate from assignments</ToolbarButton>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <ToolbarButton icon={<Printer />} className="pointer-events-none opacity-50">Print</ToolbarButton>
                </span>
              </TooltipTrigger>
              <TooltipContent>Phase 2</TooltipContent>
            </Tooltip>
          </>
        }
      >
        <FilterChip
          label="Class"
          value={gradeId}
          clearable={false}
          options={grades.map((g) => ({ value: g.id, label: g.name }))}
          onChange={(v) => {
            const first = allSections.find((s) => s.gradeId === v)
            navigate({ search: { gradeId: v, sectionId: first?.id }, replace: true })
          }}
          allLabel="Pick a class"
        />
        <FilterChip
          label="Section"
          value={sectionId}
          clearable={false}
          options={sections.map((s) => ({ value: s.id, label: s.name }))}
          onChange={(v) => navigate({ search: (old) => ({ ...old, sectionId: v }), replace: true })}
          allLabel="Pick a section"
        />
      </Toolbar>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto scrollbar-thin">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-card px-3 py-2 text-[13px] text-muted-foreground md:px-4">
          <span><span className="font-medium text-foreground tabular-nums">{stats.filled}</span> of {stats.total} periods filled</span>
          <span>·</span>
          <span>{stats.subjects} subjects</span>
          <span>·</span>
          <span>{stats.teachers} teachers</span>
          {myConflicts.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <button type="button" className="ml-auto">
                  <Tag color="orange"><AlertTriangle className="size-3" />{myConflicts.length} {myConflicts.length === 1 ? 'conflict' : 'conflicts'}</Tag>
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 p-0">
                <div className="border-b px-3 py-2 text-[13px] font-medium">Conflicts</div>
                <ul className="max-h-72 overflow-auto scrollbar-thin">
                  {myConflicts.map((c, i) => (
                    <li key={i} className="border-b px-3 py-2 text-[12.5px] last:border-b-0">
                      <div>{c.message}</div>
                      <div className="mt-0.5 text-[11.5px] text-muted-foreground">{DAY_LABELS[c.dayOfWeek]} · {bell?.periods.find((p) => p.index === c.periodIndex)?.name ?? `Period ${c.periodIndex + 1}`}</div>
                    </li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          )}
        </div>

        {bellLoading || cellsLoading ? (
          <div className="grid gap-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
        ) : !sectionId ? (
          <EmptyState icon={<CalendarDays />} title="Pick a class" description="Choose a class and section above to see its week." />
        ) : !bell ? (
          <EmptyState icon={<CalendarDays />} title="No bell schedule yet" description="Set up periods on the Bell schedule tab before filling the timetable." />
        ) : (
          <>
            <DaySelector days={workingDays} value={shownDay} onChange={setDay} />
            <TimetableGrid bell={bell} cells={cells} mode="section" editable={canEdit} dayFilter={isMobile ? shownDay : undefined} onCellClick={canEdit ? onCellClick : undefined} />
            {/* Desktop shows the breakdown inline; on a phone it is reference detail,
                so it collapses to a bar that opens a bottom drawer. */}
            <div className="hidden p-4 md:block">
              <Panel title="Subject periods per week">{subjectBreakdown}</Panel>
            </div>
            <button
              type="button"
              onClick={() => setSubjectsOpen(true)}
              className="flex h-12 w-full shrink-0 items-center justify-between gap-2 border-t bg-card px-3 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:-outline-offset-2 md:hidden"
            >
              <span className="text-[13.5px] font-medium">Subject periods per week</span>
              <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                {perSubject.length} {perSubject.length === 1 ? 'subject' : 'subjects'}
                <ChevronUp className="size-4" />
              </span>
            </button>
            <Sheet open={subjectsOpen} onOpenChange={setSubjectsOpen}>
              <SheetContent side="bottom" className="max-h-[70dvh] gap-0 p-0 md:hidden">
                <SheetTitle className="shrink-0 border-b px-4 py-3 text-[14px] font-semibold">Subject periods per week</SheetTitle>
                <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin">{subjectBreakdown}</div>
              </SheetContent>
            </Sheet>
          </>
        )}
      </div>

      <AlertDialog open={confirmGenerate} onOpenChange={setConfirmGenerate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Generate from assignments?</AlertDialogTitle>
            <AlertDialogDescription>
              This replaces the current week for {sectionLabel} using the subject teachers assigned in Classes &amp; sections.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => generate.mutate()} disabled={!sectionId || generate.isPending}>Generate</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SetPeriodDialog target={target} onClose={() => setTarget(null)} sectionId={sectionId ?? ''} sectionLabel={sectionLabel} subjects={subjects} />
    </>
  )
}
