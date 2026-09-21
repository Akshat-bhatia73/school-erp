import type { ReactNode } from 'react'
import { longDate } from '@/components/dashboard/format'
import { tagColorForTone, type Tone } from '@/components/dashboard/blocks/card'
import { Tag } from '@/components/shared/tag'
import { cn } from '@/lib/utils'

export interface HeroDay {
  date: string
  dayOfWeek: number
  kind: 'school_day' | 'holiday' | 'sunday'
  holidayName?: string
  nextSchoolDay?: { date: string; dayOfWeek: number }
}

export interface HeroChip {
  label: string
  tone: Tone
  icon?: ReactNode
}

/** Which tone a day wears: a school day is blue, a holiday orange, a Sunday teal. */
export function toneForDay(kind: HeroDay['kind']): Tone {
  if (kind === 'holiday') return 'orange'
  if (kind === 'sunday') return 'teal'
  return 'blue'
}

/**
 * One line of detail in the hero: a tag, then muted text. Pass `tone` to have the tag
 * wrapped for you; pass an already-built `Tag` element as `tag` and leave `tone` unset.
 */
export function HeroPill({ tag, children, tone, className }: {
  tag: ReactNode
  children: ReactNode
  tone?: Tone
  className?: string
}) {
  return (
    <span className={cn('inline-flex max-w-full items-center gap-1.5', className)}>
      {tone ? <Tag color={tagColorForTone(tone)}>{tag}</Tag> : tag}
      <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">{children}</span>
    </span>
  )
}

/** The band at the top of a dashboard: the day, one plain sentence, chips and actions. */
export function HeroCard({ day, headline, sentence, details, chips, actions, className }: {
  day: HeroDay
  headline: ReactNode
  sentence: ReactNode
  /** A slot under the sentence: lesson pills and the like. */
  details?: ReactNode
  chips?: HeroChip[]
  actions?: ReactNode
  className?: string
}) {
  const shown = chips?.filter(Boolean) ?? []
  return (
    <div className={cn('flex h-full min-h-0 flex-col gap-3 overflow-y-auto rounded-xl border bg-card p-4 md:flex-row md:items-start md:justify-between md:p-5', className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="min-w-0">
          <p className="text-xl font-semibold leading-tight">{headline}</p>
          <p className="mt-1 text-[13px] text-muted-foreground">{longDate(day.date)}</p>
          <p className="mt-2 max-w-[60ch] text-[13.5px] leading-snug">{sentence}</p>
        </div>
        {details && <div className="flex flex-wrap items-center gap-x-4 gap-y-2">{details}</div>}
        {shown.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {shown.map((chip) => (
              <Tag key={chip.label} color={tagColorForTone(chip.tone)}>
                {chip.icon && <span className="shrink-0 [&>svg]:size-3.5">{chip.icon}</span>}
                {chip.label}
              </Tag>
            ))}
          </div>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
