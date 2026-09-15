import { Plus } from 'lucide-react'
import type { BellScheduleRecord, TimetableCellRecord } from '@/lib/api/timetable'
import { UserAvatar } from '@/components/shared/avatar'
import { Tag, colorFor } from '@/components/shared/tag'
import { DAY_LABELS } from '@/components/timetable/day-selector'
import { cn } from '@/lib/utils'

/** Diagonal stripes for slots that are outside the school day (e.g. a short Saturday). */
export const hatched = 'bg-muted/40 bg-[image:repeating-linear-gradient(45deg,transparent,transparent_5px,var(--color-border)_5px,var(--color-border)_6px)]'

export function periodLabel(p: { startTime: string; endTime: string }) {
  return p.startTime && p.endTime ? `${p.startTime}–${p.endTime}` : ''
}

/** The name a person reads for a slot, from the bell schedule when it is known. */
export function periodNameFor(bell: BellScheduleRecord | undefined, periodIndex: number) {
  return bell?.periods.find((p) => p.index === periodIndex)?.name ?? `Period ${periodIndex + 1}`
}

/**
 * One grid for a person whose week spans grades: the server has no bell schedule
 * "for this teacher", so merge every schedule of the year by period index and add a
 * row for any index a cell uses but no schedule declares, so no cell is dropped.
 */
export function mergeBellSchedules(
  schedules: BellScheduleRecord[],
  cells: TimetableCellRecord[] = [],
): BellScheduleRecord | undefined {
  const first = schedules[0]
  if (!first) return undefined
  const byIndex = new Map<number, BellScheduleRecord['periods'][number]>()
  for (const s of schedules) for (const p of s.periods) if (!byIndex.has(p.index)) byIndex.set(p.index, p)
  for (const c of cells) {
    if (byIndex.has(c.periodIndex)) continue
    byIndex.set(c.periodIndex, { index: c.periodIndex, name: `Period ${c.periodIndex + 1}`, startTime: '', endTime: '', type: 'period' })
  }
  const periods = [...byIndex.values()].sort((a, b) => (a.startTime === b.startTime ? a.index - b.index : a.startTime < b.startTime ? -1 : 1))
  const workingDays = [...new Set(schedules.flatMap((s) => s.workingDays))].sort((a, b) => a - b)
  const satCounts = schedules.map((s) => s.saturdayPeriodCount).filter((n): n is number => n !== undefined && n !== null)
  return {
    ...first,
    periods,
    workingDays,
    saturdayPeriodCount: satCounts.length === schedules.length && satCounts.length > 0 ? Math.max(...satCounts) : undefined,
  }
}

export interface TimetableGridProps {
  bell: BellScheduleRecord
  cells: TimetableCellRecord[]
  mode: 'section' | 'staff'
  onCellClick?: (dayOfWeek: number, periodIndex: number, existing?: TimetableCellRecord) => void
  /** In staff mode, mark empty teaching slots as "Free" */
  highlightFree?: boolean
  /** Show only this day */
  dayFilter?: number
  editable?: boolean
  className?: string
}

/** The weekly grid: periods down the side, working days across the top. */
export function TimetableGrid({ bell, cells, mode, onCellClick, highlightFree, dayFilter, editable, className }: TimetableGridProps) {
  const days = [...bell.workingDays].sort((a, b) => a - b).filter((d) => dayFilter === undefined || d === dayFilter)
  const byKey = new Map<string, TimetableCellRecord>()
  for (const c of cells) byKey.set(`${c.dayOfWeek}|${c.periodIndex}`, c)
  const satCount = bell.saturdayPeriodCount

  return (
    <div className={cn('min-h-0 overflow-auto scrollbar-thin', className)}>
      {/* A single day fits a phone; the full week needs the fixed width and horizontal scroll. */}
      <table className={cn('w-full border-separate border-spacing-0 text-[13.5px]', days.length > 1 && 'min-w-[760px]')}>
        <thead className="sticky top-0 z-20">
          <tr>
            <th className="sticky left-0 z-30 h-10 w-28 border-b border-r bg-card px-3 md:w-40 text-left text-[13px] font-medium text-muted-foreground">Period</th>
            {days.map((d) => (
              <th key={d} className="h-10 border-b border-l bg-card px-3 text-left text-[13px] font-medium text-muted-foreground first:border-l-0">{DAY_LABELS[d]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bell.periods.map((p) => {
            if (p.type !== 'period') {
              return (
                <tr key={p.index}>
                  <td className="sticky left-0 z-10 h-8 border-b border-r bg-muted/50 px-3">
                    <span className="text-[12px] tabular-nums text-muted-foreground">{periodLabel(p)}</span>
                  </td>
                  <td colSpan={days.length} className="h-8 border-b bg-muted/50 px-3 text-[12px] text-muted-foreground">
                    {p.name}
                  </td>
                </tr>
              )
            }
            return (
              <tr key={p.index}>
                <td className="sticky left-0 z-10 h-[58px] border-b border-r bg-card px-3 align-middle">
                  <div className="font-medium">{p.name}</div>
                  <div className="text-[12px] text-muted-foreground tabular-nums">{periodLabel(p)}</div>
                </td>
                {days.map((d) => {
                  const outside = d === 6 && satCount !== undefined && p.index >= satCount
                  const cell = byKey.get(`${d}|${p.index}`)
                  return (
                    <td key={d} className={cn('h-[58px] border-b border-l bg-card p-1.5 align-middle first:border-l-0', outside && hatched)}>
                      {outside ? null : cell ? (
                        <CellBody cell={cell} mode={mode} onClick={onCellClick ? () => onCellClick(d, p.index, cell) : undefined} />
                      ) : (
                        <EmptyCell editable={!!editable && !!onCellClick} free={!!highlightFree} onClick={onCellClick ? () => onCellClick(d, p.index, undefined) : undefined} />
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function CellBody({ cell, mode, onClick }: { cell: TimetableCellRecord; mode: 'section' | 'staff'; onClick?: () => void }) {
  const top = mode === 'section'
    ? <Tag color={colorFor(cell.subject.id)}>{cell.subject.name}</Tag>
    : <Tag color={colorFor(cell.section.id)}>{cell.section.name}</Tag>
  const bottom = mode === 'section'
    ? (cell.teacher
        ? <span className="flex items-center gap-1.5 truncate"><UserAvatar name={cell.teacher.name} size="xs" />{cell.teacher.name}</span>
        : <span className="text-tag-orange">No teacher</span>)
    : <span className="truncate">{cell.subject.name}</span>
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn('flex h-full w-full flex-col items-start justify-center gap-1 rounded-lg px-2 py-1 text-left', onClick && 'hover:bg-accent/60')}
    >
      {top}
      <span className="w-full truncate text-[12px] text-muted-foreground">{bottom}</span>
    </button>
  )
}

function EmptyCell({ editable, free, onClick }: { editable: boolean; free: boolean; onClick?: () => void }) {
  if (!editable) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center rounded-lg text-[12px] text-muted-foreground/70', free && 'bg-muted/30')}>
        {free ? 'Free' : ''}
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex h-full w-full items-center justify-center rounded-lg border border-dashed text-muted-foreground/60 transition-colors hover:border-foreground/30 hover:bg-accent/50"
    >
      <Plus className="size-4 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  )
}
