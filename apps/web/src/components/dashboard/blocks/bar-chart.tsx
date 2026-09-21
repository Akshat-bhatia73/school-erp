import { monthLong, monthShort, plural } from '@/components/dashboard/format'
import { cn } from '@/lib/utils'

export interface MonthBar { month: string; count: number }

const SLOT = 32
const BAR = 18
const PLOT_H = 150
const RADIUS = 4

const STEPS = [1, 2, 5, 10, 20, 25, 50, 100]

/**
 * Whole-number y ticks: the smallest step that reaches the max in three to five ticks,
 * always starting at 0. niceSteps(22) is [0, 10, 20, 30].
 */
export function niceSteps(max: number): number[] {
  const target = Math.max(0, Math.ceil(max))
  for (const step of STEPS) {
    const n = Math.max(2, Math.ceil(target / step))
    if (n <= 4) return Array.from({ length: n + 1 }, (_, i) => i * step)
  }
  const step = Math.max(100, Math.ceil(Math.ceil(target / 4) / 100) * 100)
  const n = Math.min(4, Math.max(2, Math.ceil(target / step)))
  return Array.from({ length: n + 1 }, (_, i) => i * step)
}

/** A bar with a rounded top and a square foot. */
function barPath(x: number, y: number, height: number): string {
  const r = Math.min(RADIUS, height)
  const bottom = y + height
  return `M ${x} ${bottom} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} L ${x + BAR - r} ${y} Q ${x + BAR} ${y} ${x + BAR} ${y + r} L ${x + BAR} ${bottom} Z`
}

/** Admissions by month. Thin bars, recessive gridlines, labels only where they help. */
export function MonthBarChart({ data, height = 200, highlightMonth, className }: {
  data: MonthBar[]
  height?: number
  /** The month of today, drawn in the darker tone; later months are drawn faint. */
  highlightMonth?: string
  className?: string
}) {
  const counts = data.map((d) => d.count)
  const peak = Math.max(...counts, 0)
  const ticks = niceSteps(peak)
  const top = ticks[ticks.length - 1]!
  const width = Math.max(1, data.length) * SLOT
  const empty = peak === 0
  const highlightIndex = highlightMonth ? data.findIndex((d) => d.month === highlightMonth) : -1

  return (
    <div className={cn('@container flex w-full flex-col', className)}>
      <div className="flex w-full gap-1" style={{ height }}>
        <div className="flex w-7 shrink-0 flex-col-reverse justify-between py-0 text-[11px] tabular-nums text-muted-foreground">
          {ticks.map((tick) => <span key={tick}>{tick}</span>)}
        </div>
        <div className="relative min-w-0 flex-1 px-1">
          <svg
            viewBox={`0 0 ${width} ${PLOT_H}`}
            preserveAspectRatio="xMidYMid meet"
            className="h-full w-full"
            role="img"
            aria-label="Admissions by month"
          >
            {ticks.map((tick) => {
              const y = PLOT_H - (tick / top) * PLOT_H
              return <line key={tick} x1="0" x2={width} y1={y} y2={y} className="stroke-border" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            })}
            {!empty && data.map((d, i) => {
              const h = d.count > 0 ? Math.max(2, (d.count / top) * PLOT_H) : 0
              const x = i * SLOT + (SLOT - BAR) / 2
              const y = PLOT_H - h
              const future = highlightIndex >= 0 && i > highlightIndex
              const fill = i === highlightIndex ? 'fill-tag-indigo' : future ? 'fill-tag-blue/25' : 'fill-tag-blue'
              const labelled = i === highlightIndex || (d.count === peak && peak > 0)
              return (
                <g key={d.month}>
                  {h > 0 && (
                    <path d={barPath(x, y, h)} className={cn(fill, 'hover:opacity-80')}>
                      <title>{`${monthLong(d.month)}: ${plural(d.count, 'admission', 'admissions')}`}</title>
                    </path>
                  )}
                  {labelled && d.count > 0 && (
                    <text x={x + BAR / 2} y={y - 4} textAnchor="middle" className="fill-foreground text-[12px] font-medium">{d.count}</text>
                  )}
                </g>
              )
            })}
          </svg>
          {empty && (
            <p className="absolute inset-0 flex items-center justify-center text-[13px] text-muted-foreground">
              No admissions recorded yet
            </p>
          )}
        </div>
      </div>
      <div className="flex w-full">
        <span className="w-7 shrink-0" />
        <div className="flex min-w-0 flex-1">
          {data.map((d) => (
            <span key={d.month} className="min-w-0 flex-1 text-center text-[11px] text-muted-foreground">
              <span className="hidden @[440px]:inline">{monthShort(d.month)}</span>
              <span className="@[440px]:hidden">{monthShort(d.month).charAt(0)}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
