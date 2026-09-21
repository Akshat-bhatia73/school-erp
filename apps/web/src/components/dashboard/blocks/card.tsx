import { AlertCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { EmptyState } from '@/components/shared/page'
import type { TagColor } from '@/components/shared/tag'
import { Skeleton } from '@/components/ui/skeleton'
import { describeError } from '@/lib/api-errors'
import { cn } from '@/lib/utils'

/** One colour per card, so the eye finds things. `plain` is the untinted card. */
export type Tone = 'plain' | 'blue' | 'teal' | 'purple' | 'orange' | 'pink' | 'green' | 'indigo' | 'yellow' | 'red'

export interface ToneClasses {
  /** The icon badge: the same tint recipe as a Tag, plus the icon colour. */
  badge: string
  /** A solid fill for a bar or a dot. */
  bar: string
  /** The colour for a number or a small piece of emphasis. */
  text: string
}

/**
 * Every class name is written out in full: Tailwind reads the source, so an interpolated
 * name like `bg-tag-${tone}/12` would never be generated.
 */
export const TONE: Record<Tone, ToneClasses> = {
  plain: { badge: 'bg-muted text-muted-foreground', bar: 'bg-muted-foreground', text: 'text-foreground' },
  blue: { badge: 'bg-tag-blue/12 text-tag-blue dark:bg-tag-blue/18', bar: 'bg-tag-blue', text: 'text-tag-blue' },
  teal: { badge: 'bg-tag-teal/12 text-tag-teal dark:bg-tag-teal/18', bar: 'bg-tag-teal', text: 'text-tag-teal' },
  purple: { badge: 'bg-tag-purple/12 text-tag-purple dark:bg-tag-purple/18', bar: 'bg-tag-purple', text: 'text-tag-purple' },
  orange: { badge: 'bg-tag-orange/12 text-tag-orange dark:bg-tag-orange/18', bar: 'bg-tag-orange', text: 'text-tag-orange' },
  pink: { badge: 'bg-tag-pink/12 text-tag-pink dark:bg-tag-pink/18', bar: 'bg-tag-pink', text: 'text-tag-pink' },
  green: { badge: 'bg-tag-green/12 text-tag-green dark:bg-tag-green/18', bar: 'bg-tag-green', text: 'text-tag-green' },
  indigo: { badge: 'bg-tag-indigo/12 text-tag-indigo dark:bg-tag-indigo/18', bar: 'bg-tag-indigo', text: 'text-tag-indigo' },
  yellow: { badge: 'bg-tag-yellow/15 text-tag-yellow dark:bg-tag-yellow/18', bar: 'bg-tag-yellow', text: 'text-tag-yellow' },
  red: { badge: 'bg-tag-red/12 text-tag-red dark:bg-tag-red/18', bar: 'bg-tag-red', text: 'text-tag-red' },
}

export function toneClasses(tone: Tone = 'plain'): ToneClasses {
  return TONE[tone]
}

/** The tone as a `Tag` colour, so a badge and a pill next to it agree. */
export function tagColorForTone(tone: Tone = 'plain'): TagColor {
  return tone === 'plain' ? 'grey' : tone
}

/** The small tinted icon badge: the card header's only colour, reusable inside a body row. */
export function ToneBadge({ tone = 'plain', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex size-7 shrink-0 items-center justify-center rounded-md [&>svg]:size-4', TONE[tone].badge, className)}>
      {children}
    </span>
  )
}

export interface DashboardCardProps {
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
  children?: ReactNode
  isLoading?: boolean
  error?: unknown
  empty?: { icon?: ReactNode; title: string; description?: string }
  className?: string
  bodyClassName?: string
  /** The card's colour. Only the header icon badge is tinted; the border is always plain. */
  tone?: Tone
  /** A lucide element for the header badge. */
  icon?: ReactNode
  /** A hairline-topped strip at the bottom of the card. */
  footer?: ReactNode
  /** False lets a table or a chart touch the card edges. */
  padded?: boolean
  /** Accepted for call-site compatibility; the body always scrolls when it overflows. */
  scrollable?: boolean
}

/** One calm card: it knows how to be loading, broken or empty, and it fills its grid cell. */
export function DashboardCard({
  title, description, action, children, isLoading, error, empty, className, bodyClassName,
  tone = 'plain', icon, footer, padded = true,
}: DashboardCardProps) {
  let body: ReactNode
  if (isLoading) {
    body = (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-2/3 rounded-md" />
        <Skeleton className="h-4 w-1/2 rounded-md" />
        <Skeleton className="h-4 w-3/5 rounded-md" />
        <Skeleton className="mt-1 h-20 w-full rounded-lg" />
      </div>
    )
  } else if (error) {
    body = (
      <p className="flex items-start gap-2 text-[13.5px] text-muted-foreground">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-tag-red" />
        <span>{describeError(error)}</span>
      </p>
    )
  } else if (empty && !children) {
    body = <EmptyState icon={empty.icon} title={empty.title} description={empty.description} className="px-2 py-8" />
  } else {
    body = children
  }

  const hasHeader = Boolean(title || description || action || icon)
  return (
    <div className={cn('flex h-full min-h-0 flex-col rounded-xl border bg-card text-[13.5px]', className)}>
      {hasHeader && (
        <header className="flex items-start gap-3 px-3 pt-3.5 pb-2 md:px-4">
          {icon && <ToneBadge tone={tone}>{icon}</ToneBadge>}
          <div className="min-w-0 flex-1">
            {title && <h3 className="truncate text-[13.5px] font-semibold">{title}</h3>}
            {description && <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted-foreground">{description}</p>}
          </div>
          {action && <div className="shrink-0 text-[13px]">{action}</div>}
        </header>
      )}
      <div className="min-h-0 flex-1">
        <div className={cn('h-full overflow-y-auto', padded ? 'px-3 pb-3.5 md:px-4' : 'pb-0', !hasHeader && padded && 'pt-3.5', bodyClassName)}>
          {body}
        </div>
      </div>
      {footer && (
        <div className="border-t px-3 py-2 text-[12.5px] text-muted-foreground md:px-4">{footer}</div>
      )}
    </div>
  )
}

const COL: Record<number, string> = {
  1: 'xl:col-span-1', 2: 'xl:col-span-2', 3: 'xl:col-span-3', 4: 'xl:col-span-4',
  5: 'xl:col-span-5', 6: 'xl:col-span-6', 7: 'xl:col-span-7', 8: 'xl:col-span-8',
  9: 'xl:col-span-9', 10: 'xl:col-span-10', 11: 'xl:col-span-11', 12: 'xl:col-span-12',
}

const ROW: Record<number, string> = {
  1: 'xl:row-span-1', 2: 'xl:row-span-2', 3: 'xl:row-span-3', 4: 'xl:row-span-4',
  5: 'xl:row-span-5', 6: 'xl:row-span-6', 7: 'xl:row-span-7', 8: 'xl:row-span-8',
  9: 'xl:row-span-9', 10: 'xl:row-span-10',
}

/**
 * The dashboard canvas: twelve columns of 104px rows from xl up (the bento), two plain columns
 * on a laptop between lg and xl, and a single stack below that. The two-column band keeps
 * every card at its natural height, so nothing is squeezed at 1024px.
 */
export function BentoGrid({ children, dense, className }: { children: ReactNode; dense?: boolean; className?: string }) {
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-12 xl:auto-rows-[104px]',
        dense && 'xl:[grid-auto-flow:dense]',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** One cell of the BentoGrid: `col` columns wide, `rows` rows tall. */
export function Cell({ col = 12, rows = 2, children, className }: { col?: number; rows?: number; children: ReactNode; className?: string }) {
  // A wide card (two thirds or more) also takes the whole width of the two-column laptop band.
  const laptop = col >= 8 ? 'lg:col-span-2' : 'lg:col-span-1'
  return <div className={cn('min-w-0', laptop, COL[col] ?? COL[12], ROW[rows] ?? ROW[2], className)}>{children}</div>
}
