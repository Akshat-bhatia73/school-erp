import { colorFor, type TagColor } from '@/components/shared/tag'
import { cn } from '@/lib/utils'

export interface ClassStrengthRow {
  grade: { id: string; name: string }
  sections: Array<{ id: string; name: string; count: number }>
}

/**
 * The class's own colour, fading section by section. Every class name is written out in full:
 * Tailwind reads the source, so `bg-tag-${colour}/60` would never be generated.
 */
const SEGMENTS: Record<TagColor, string[]> = {
  orange: ['bg-tag-orange', 'bg-tag-orange/60', 'bg-tag-orange/40', 'bg-tag-orange/25'],
  blue: ['bg-tag-blue', 'bg-tag-blue/60', 'bg-tag-blue/40', 'bg-tag-blue/25'],
  teal: ['bg-tag-teal', 'bg-tag-teal/60', 'bg-tag-teal/40', 'bg-tag-teal/25'],
  cyan: ['bg-tag-cyan', 'bg-tag-cyan/60', 'bg-tag-cyan/40', 'bg-tag-cyan/25'],
  purple: ['bg-tag-purple', 'bg-tag-purple/60', 'bg-tag-purple/40', 'bg-tag-purple/25'],
  pink: ['bg-tag-pink', 'bg-tag-pink/60', 'bg-tag-pink/40', 'bg-tag-pink/25'],
  red: ['bg-tag-red', 'bg-tag-red/60', 'bg-tag-red/40', 'bg-tag-red/25'],
  green: ['bg-tag-green', 'bg-tag-green/60', 'bg-tag-green/40', 'bg-tag-green/25'],
  yellow: ['bg-tag-yellow', 'bg-tag-yellow/60', 'bg-tag-yellow/40', 'bg-tag-yellow/25'],
  indigo: ['bg-tag-indigo', 'bg-tag-indigo/60', 'bg-tag-indigo/40', 'bg-tag-indigo/25'],
  grey: ['bg-muted-foreground', 'bg-muted-foreground/60', 'bg-muted-foreground/40', 'bg-muted-foreground/25'],
}

/** One row per class: the name, a stacked bar comparable across classes, and the total. */
export function ClassStrengthList({ rows, className }: { rows: ClassStrengthRow[]; className?: string }) {
  const totals = rows.map((row) => row.sections.reduce((sum, section) => sum + section.count, 0))
  const widest = Math.max(1, ...totals)
  return (
    <div className={cn('flex flex-col divide-y', className)}>
      {rows.map((row, index) => {
        const total = totals[index] ?? 0
        const shades = SEGMENTS[colorFor(row.grade.name)]!
        return (
          <div key={row.grade.id} className="grid grid-cols-[5rem_1fr_2.5rem] items-center gap-3 py-2">
            <span className="truncate text-[13.5px] font-medium">{row.grade.name}</span>
            <div className="min-w-0">
              <div className="flex h-3 w-full gap-px overflow-hidden rounded-full bg-muted">
                {row.sections.map((section, i) => (
                  <span
                    key={section.id}
                    className={cn('h-full', shades[i % shades.length])}
                    style={{ width: `${(section.count / widest) * 100}%` }}
                  />
                ))}
              </div>
              <p className="mt-1 truncate text-[12px] text-muted-foreground">
                {row.sections.length === 0
                  ? 'No sections'
                  : row.sections.map((section) => `${section.name} ${section.count}`).join(' · ')}
              </p>
            </div>
            <span className="text-right text-[13.5px] font-semibold tabular-nums">{total}</span>
          </div>
        )
      })}
    </div>
  )
}
