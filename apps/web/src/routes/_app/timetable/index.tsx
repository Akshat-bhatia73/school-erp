import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { AlertTriangle, CalendarDays, ChevronUp, Printer, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { api } from '@/lib/api'
import type { TimetableCellRecord } from '@/lib/api/timetable'
import { describeError, isApiError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { FilterChip, ToolbarButton } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Panel, Toolbar } from '@/components/shared/page'
import { Tag, colorFor } from '@/components/shared/tag'
import { TimetableTabs } from '@/components/timetable/timetable-tabs'
import { TimetableExportMenu } from '@/components/timetable/export-menu'
import { TimetableGrid, periodNameFor } from '@/components/timetable/timetable-grid'
import { DAY_LABELS, DaySelector, defaultDay } from '@/components/timetable/day-selector'
import { NoAcademicYearState } from '@/components/timetable/states'
import { SetPeriodDialog, type SetPeriodTarget } from '@/components/timetable/set-period-dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/lib/use-media'

// A hand-edited or stale id must fall back to "nothing picked" rather than being
// sent to the API, which answers 400 for anything that is not a uuid.
const uuid = z.string().uuid().optional().catch(undefined)
const searchSchema = z.object({ gradeId: uuid, sectionId: uuid })

export const Route = createFileRoute('/_app/timetable/')({ component: Page, validateSearch: searchSchema })

export function Page() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const queryClient = useQueryClient()
  const { schoolId, hasPermission } = useSchoolContext()
  const { currentYearId, isLoading: yearLoading } = useAcademicYear()
  const yearId = currentYearId ?? ''

  const [target, setTarget] = useState<SetPeriodTarget | null>(null)
  const [day, setDay] = useState<number | undefined>()
  const [confirmGenerate, setConfirmGenerate] = useState(false)
  const [subjectsOpen, setSubjectsOpen] = useState(false)

  const canReadGrades = hasPermission('grades.read')
  const { data: grades = [] } = useQuery({
    queryKey: qk.grades(schoolId),
    queryFn: () => api.setup.grades(schoolId),
    enabled: canReadGrades,
  })
  const gradeId = search.gradeId
  // The year's visible sections, asked for once without a class filter: both chips are derived from
  // them, so a class with nothing visible this year never shows up.
  const sectionParams = useMemo(() => ({ academicYearId: yearId }), [yearId])
  const { data: allSections = [] } = useQuery({
    queryKey: qk.sections(schoolId, sectionParams),
    queryFn: () => api.setup.sections(schoolId, sectionParams),
    enabled: !!yearId && hasPermission('sections.read'),
  })
  const sections = useMemo(
    () => (gradeId ? allSections.filter((s) => s.gradeId === gradeId) : allSections),
    [allSections, gradeId],
  )
  const gradeOptions = useMemo(() => {
    const visible = new Set(allSections.map((s) => s.gradeId))
    return grades.filter((g) => visible.has(g.id))
  }, [grades, allSections])
  const sectionId = search.sectionId

  // Default to the first section the server let this person see. A section id in the URL that is
  // not among them (a stale link, or last year's class) is replaced rather than queried.
  useEffect(() => {
    if (allSections.length === 0) return
    if (sectionId && allSections.some((s) => s.id === sectionId)) return
    const first = (gradeId ? allSections.find((s) => s.gradeId === gradeId) : undefined) ?? allSections[0]
    if (!first) return
    void navigate({ search: { gradeId: first.gradeId, sectionId: first.id }, replace: true })
  }, [allSections, gradeId, sectionId, navigate])

  // Until the replacement lands in the URL, an unknown id counts as nothing picked.
  const sectionKnown = allSections.length === 0 || allSections.some((s) => s.id === sectionId)
  const shownSectionId = sectionKnown ? sectionId : undefined
  const section = allSections.find((s) => s.id === shownSectionId)
  const grade = grades.find((g) => g.id === (section?.gradeId ?? gradeId))
  const sectionLabel = section ? (grade ? `${grade.name} - ${section.name}` : section.name) : '—'
  const bellGradeId = section?.gradeId ?? gradeId

  const bellQuery = useQuery({
    queryKey: qk.bellScheduleForGrade(schoolId, bellGradeId ?? '', { academicYearId: yearId }),
    queryFn: () => api.timetable.bellScheduleForGrade(schoolId, bellGradeId!, { academicYearId: yearId }),
    enabled: !!bellGradeId && !!yearId,
  })
  const bell = bellQuery.data
  const bellMissing = isApiError(bellQuery.error, 'RESOURCE_NOT_FOUND')

  const gridQuery = useQuery({
    queryKey: qk.timetableSection(schoolId, shownSectionId ?? '', { academicYearId: yearId }),
    queryFn: () => api.timetable.forSection(schoolId, shownSectionId!, { academicYearId: yearId }),
    enabled: !!shownSectionId && !!yearId,
  })
  const cells = useMemo(() => gridQuery.data?.cells ?? [], [gridQuery.data])
  const allowedActions = gridQuery.data?.allowedActions
  const canEditEntries = allows(allowedActions, 'timetable.manage_entries')
  const canGenerate = allows(allowedActions, 'timetable.generate')

  const conflictParams = { academicYearId: yearId }
  const { data: conflicts = [] } = useQuery({
    queryKey: qk.conflicts(schoolId, conflictParams),
    queryFn: () => api.timetable.conflicts(schoolId, conflictParams),
    enabled: !!yearId && hasPermission('timetable.read_conflicts'),
  })

  const subjectParams = { academicYearId: yearId, gradeId: bellGradeId }
  const { data: gradeSubjects = [] } = useQuery({
    queryKey: qk.gradeSubjects(schoolId, subjectParams),
    queryFn: () => api.setup.gradeSubjects(schoolId, { academicYearId: yearId, gradeId: bellGradeId! }),
    enabled: !!yearId && !!bellGradeId && canEditEntries,
  })
  const subjects = useMemo(() => gradeSubjects.map((g) => g.subject), [gradeSubjects])

  const myConflicts = useMemo(
    () => conflicts.filter((c) => c.section.id === shownSectionId),
    [conflicts, shownSectionId],
  )

  const stats = useMemo(() => {
    if (!bell) return { filled: cells.length, total: 0, subjects: 0, teachers: 0 }
    const teachingSlots = bell.periods.filter((p) => p.type === 'period')
    let total = 0
    for (const d of bell.workingDays) {
      total += d === 6 && bell.saturdayPeriodCount !== undefined
        ? teachingSlots.filter((p) => p.index < bell.saturdayPeriodCount!).length
        : teachingSlots.length
    }
    return {
      filled: cells.length,
      total,
      subjects: new Set(cells.map((c) => c.subject.id)).size,
      teachers: new Set(cells.map((c) => c.teacher?.id).filter(Boolean)).size,
    }
  }, [bell, cells])

  const perSubject = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number }>()
    for (const c of cells) {
      const cur = map.get(c.subject.id) ?? { id: c.subject.id, name: c.subject.name, count: 0 }
      cur.count++
      map.set(c.subject.id, cur)
    }
    return [...map.values()].sort((a, b) => b.count - a.count)
  }, [cells])

  const generate = useMutation({
    mutationFn: () => api.timetable.generate(schoolId, shownSectionId!, { academicYearId: yearId, reason: 'Generated from teaching assignments' }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'timetable'] })
      toast.success(`Placed ${result.placed} periods${result.unplaced > 0 ? ` · ${result.unplaced} could not be placed` : ''}`)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const isMobile = useIsMobile()
  const workingDays = useMemo(() => [...(bell?.workingDays ?? [])].sort((a, b) => a - b), [bell])
  const shownDay = day !== undefined && workingDays.includes(day) ? day : defaultDay(workingDays)

  const subjectBreakdown = perSubject.length === 0 ? (
    <p className="text-[13px] text-muted-foreground">Nothing placed yet.</p>
  ) : (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {perSubject.map((s) => (
        <span key={s.id} className="flex items-center gap-1.5">
          <Tag color={colorFor(s.id)}>{s.name}</Tag>
          <span className="text-[13px] tabular-nums text-muted-foreground">{s.count}</span>
        </span>
      ))}
    </div>
  )

  const onCellClick = (dayOfWeek: number, periodIndex: number, existing?: TimetableCellRecord) => {
    if (!canEditEntries) return
    setTarget({ dayOfWeek, periodIndex, existing, periodName: periodNameFor(bell, periodIndex) })
  }

  const gridRefused = isApiError(gridQuery.error) && !bellMissing

  return (
    <>
      <PageHeader crumbs={[{ label: 'Timetable' }, { label: 'Class timetable' }]} hideOnMobile />
      <TimetableTabs />
      <Toolbar
        right={
          <>
            {canGenerate && (
              <ToolbarButton icon={<Wand2 />} onClick={() => setConfirmGenerate(true)}>Generate from assignments</ToolbarButton>
            )}
            {shownSectionId && yearId && (
              <TimetableExportMenu academicYearId={yearId} view={{ kind: 'section', sectionId: shownSectionId }} />
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
        {canReadGrades && gradeOptions.length > 0 && (
          <FilterChip
            label="Class"
            value={gradeId}
            clearable={false}
            options={gradeOptions.map((g) => ({ value: g.id, label: g.name }))}
            onChange={(v) => {
              const first = allSections.find((s) => s.gradeId === v)
              void navigate({ search: { gradeId: v, sectionId: first?.id }, replace: true })
            }}
            allLabel="Pick a class"
          />
        )}
        <FilterChip
          label="Section"
          value={shownSectionId}
          clearable={false}
          options={sections.map((s) => ({ value: s.id, label: s.name }))}
          onChange={(v) => void navigate({ search: (old) => ({ ...old, sectionId: v }), replace: true })}
          allLabel="Pick a section"
        />
      </Toolbar>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto scrollbar-thin">
        <div className="hidden flex-wrap items-center gap-x-3 gap-y-1 border-b bg-card px-3 py-2 text-[13px] text-muted-foreground md:flex md:px-4">
          <span><span className="font-medium text-foreground tabular-nums">{stats.filled}</span> of {stats.total} periods filled</span>
          <span>·</span>
          <span>{stats.subjects} subjects</span>
          <span>·</span>
          <span>{stats.teachers} teachers</span>
          {myConflicts.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <button type="button" className="ml-auto">
                  <Tag color="orange"><AlertTriangle className="size-3" />{myConflicts.length} {myConflicts.length === 1 ? 'conflict' : 'conflicts'} in this class</Tag>
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 p-0">
                <div className="border-b px-3 py-2 text-[13px] font-medium">Conflicts in this class</div>
                <ul className="max-h-72 overflow-auto scrollbar-thin">
                  {myConflicts.map((c, i) => (
                    <li key={i} className="border-b px-3 py-2 text-[12.5px] last:border-b-0">
                      <div>{conflictSentence(c)}</div>
                      <div className="mt-0.5 text-[11.5px] text-muted-foreground">{DAY_LABELS[c.dayOfWeek]} · {periodNameFor(bell, c.periodIndex)}</div>
                    </li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          )}
        </div>

        {yearLoading || (!!shownSectionId && (bellQuery.isLoading || gridQuery.isLoading)) ? (
          <div className="grid gap-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
        ) : !yearId ? (
          <NoAcademicYearState />
        ) : !shownSectionId ? (
          <EmptyState icon={<CalendarDays />} title="Pick a class" description="Choose a class and section above to see its week." />
        ) : gridRefused ? (
          <EmptyState icon={<CalendarDays />} title={describeError(gridQuery.error)} />
        ) : !bell ? (
          <EmptyState
            icon={<CalendarDays />}
            title="No periods set up for this class"
            description="A bell schedule decides which periods exist in the school day."
            action={hasPermission('timetable.manage_periods')
              ? <Button size="sm" asChild><Link to="/timetable/periods">Set up periods</Link></Button>
              : undefined}
          />
        ) : (
          <>
            <DaySelector days={workingDays} value={shownDay} onChange={setDay} />
            <TimetableGrid bell={bell} cells={cells} mode="section" editable={canEditEntries} dayFilter={isMobile ? shownDay : undefined} onCellClick={canEditEntries ? onCellClick : undefined} />
            {/* Desktop shows the breakdown inline; on a phone it is reference detail,
                so it collapses to a bar that opens a bottom drawer. */}
            <div className="hidden p-4 md:block">
              <Panel title="Subject periods per week">{subjectBreakdown}</Panel>
            </div>
            {/* Sits on the bottom edge of the scroll area and expands upward in place. */}
            <div className="sticky bottom-0 z-20 mt-auto border-t bg-card md:hidden">
              <button
                type="button"
                onClick={() => setSubjectsOpen((o) => !o)}
                aria-expanded={subjectsOpen}
                className="flex h-12 w-full items-center justify-between gap-2 px-3 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:-outline-offset-2"
              >
                <span className="min-w-0 truncate text-[13.5px]">
                  <span className="font-medium tabular-nums">{stats.filled}</span> of {stats.total} periods filled
                </span>
                <span className="flex shrink-0 items-center gap-2 text-[12.5px] text-muted-foreground">
                  {myConflicts.length > 0 && (
                    <Tag color="orange"><AlertTriangle className="size-3" />{myConflicts.length}</Tag>
                  )}
                  <ChevronUp className={cn('size-4 transition-transform duration-200', subjectsOpen && 'rotate-180')} />
                </span>
              </button>
              {/* 0fr -> 1fr animates to the content's own height, so the panel can grow
                  with the number of subjects without a hard-coded max height. */}
              <div className={cn('grid transition-[grid-template-rows] duration-200 ease-out', subjectsOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
                {/* min-h-0 matters: a grid item defaults to min-height:auto and would
                    refuse to shrink below its content, so 0fr alone collapses nothing. */}
                <div className="min-h-0 overflow-hidden">
                  <div className="space-y-3 border-t px-3 py-3">
                    <p className="text-[12.5px] text-muted-foreground">{stats.subjects} subjects · {stats.teachers} teachers</p>
                    {subjectBreakdown}
                    {myConflicts.length > 0 && (
                      <ul className="space-y-1.5 border-t pt-3">
                        {myConflicts.map((c, i) => (
                          <li key={i} className="text-[12.5px]">
                            <span className="text-tag-orange">{conflictSentence(c)}</span>
                            <span className="block text-[11.5px] text-muted-foreground">{DAY_LABELS[c.dayOfWeek]} · {periodNameFor(bell, c.periodIndex)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            </div>
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
            <AlertDialogAction onClick={() => generate.mutate()} disabled={!shownSectionId || generate.isPending}>Generate</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {canEditEntries && (
        <SetPeriodDialog
          target={target}
          onClose={() => setTarget(null)}
          sectionId={shownSectionId ?? ''}
          sectionLabel={sectionLabel}
          subjects={subjects}
          academicYearId={yearId}
        />
      )}
    </>
  )
}

/** A plain sentence for one conflict; the contract carries the kind, not a message. */
function conflictSentence(conflict: { kind: 'teacher_busy' | 'section_busy' | 'teacher_not_assigned'; section: { name: string }; teacher?: { name: string } }) {
  const teacher = conflict.teacher?.name ?? 'The teacher'
  if (conflict.kind === 'teacher_busy') return `${teacher} is already teaching another class in this period.`
  if (conflict.kind === 'section_busy') return `${conflict.section.name} already has another period here.`
  return `${teacher} is not assigned to teach this subject.`
}
