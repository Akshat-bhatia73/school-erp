import { Plus } from 'lucide-react'
import type { BellSchedule } from '@erp/shared'
import { DAY_LABELS } from '@erp/shared'
import type { TimetableCell } from '@/api/client'
import { UserAvatar } from '@/components/shared/avatar'
import { Tag, colorFor } from '@/components/shared/tag'
import { cn, fullName } from '@/lib/utils'

/** Diagonal stripes for slots that are outside the school day (e.g. a short Saturday). */
export const hatched = 'bg-muted/40 bg-[image:repeating-linear-gradient(45deg,transparent,transparent_5px,var(--color-border)_5px,var(--color-border)_6px)]'

export function periodLabel(p: { startTime: string; endTime: string }) {
  return `${p.startTime}–${p.endTime}`
}

export interface TimetableGridProps {
  bell: BellSchedule
  cells: TimetableCell[]
  mode: 'section' | 'staff'
  onCellClick?: (dayOfWeek: number, periodIndex: number, existing?: TimetableCell) => void
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
  const byKey = new Map<string, TimetableCell>()
  for (const c of cells) byKey.set(`${c.dayOfWeek}|${c.periodIndex}`, c)
  const satCount = bell.saturdayPeriodCount

  return (
    <div className={cn('min-h-0 overflow-auto scrollbar-thin', className)}>
      <table className="w-full min-w-[760px] border-separate border-spacing-0 text-[13.5px]">
        <thead className="sticky top-0 z-20">
          <tr>
            <th className="sticky left-0 z-30 h-10 w-40 border-b border-r bg-card px-3 text-left text-[13px] font-medium text-muted-foreground">Period</th>
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

function CellBody({ cell, mode, onClick }: { cell: TimetableCell; mode: 'section' | 'staff'; onClick?: () => void }) {
  const top = mode === 'section'
    ? <Tag color={colorFor(cell.subject?.code ?? cell.subjectId)}>{cell.subject?.name ?? 'Subject'}</Tag>
    : <Tag color={colorFor(cell.sectionId)}>{cell.grade?.name} - {cell.section?.name}</Tag>
  const bottom = mode === 'section'
    ? (cell.staff
        ? <span className="flex items-center gap-1.5 truncate"><UserAvatar name={fullName(cell.staff)} size="xs" />{fullName(cell.staff)}</span>
        : <span className="text-tag-orange">No teacher</span>)
    : <span className="truncate">{cell.subject?.name ?? ''}</span>
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
