import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

export type TagColor = 'orange' | 'blue' | 'teal' | 'cyan' | 'purple' | 'pink' | 'red' | 'green' | 'yellow' | 'indigo' | 'grey'

const colorClass: Record<TagColor, string> = {
  orange: 'bg-tag-orange/12 text-tag-orange dark:bg-tag-orange/18',
  blue: 'bg-tag-blue/12 text-tag-blue dark:bg-tag-blue/18',
  teal: 'bg-tag-teal/12 text-tag-teal dark:bg-tag-teal/18',
  cyan: 'bg-tag-cyan/12 text-tag-cyan dark:bg-tag-cyan/18',
  purple: 'bg-tag-purple/12 text-tag-purple dark:bg-tag-purple/18',
  pink: 'bg-tag-pink/12 text-tag-pink dark:bg-tag-pink/18',
  red: 'bg-tag-red/12 text-tag-red dark:bg-tag-red/18',
  green: 'bg-tag-green/12 text-tag-green dark:bg-tag-green/18',
  yellow: 'bg-tag-yellow/15 text-tag-yellow dark:bg-tag-yellow/18',
  indigo: 'bg-tag-indigo/12 text-tag-indigo dark:bg-tag-indigo/18',
  grey: 'bg-muted text-muted-foreground',
}

/** Filled tinted pill like "Enterprise" / "Upsell" in the reference. */
export function Tag({ color = 'grey', className, children, dot }: { color?: TagColor; className?: string; children: ReactNode; dot?: boolean }) {
  return (
    <span className={cn('inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12.5px] font-medium leading-none', colorClass[color], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

/** Stable colour for an arbitrary string, so the same class/department always gets the same colour */
export function colorFor(key: string): TagColor {
  const palette: TagColor[] = ['orange', 'blue', 'teal', 'purple', 'pink', 'green', 'indigo', 'cyan', 'yellow', 'red']
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return palette[h % palette.length]!
}

/** Small ring/half/full status glyph like the reference's status column */
export function StatusDot({ state, className, title }: { state: 'empty' | 'partial' | 'full' | 'done' | 'warn'; className?: string; title?: string }) {
  const base = 'inline-block size-3.5 rounded-full'
  if (state === 'empty') return <span title={title} className={cn(base, 'border-[1.5px] border-dashed border-muted-foreground/50', className)} />
  if (state === 'partial') return <span title={title} className={cn(base, 'bg-[conic-gradient(var(--tag-orange)_0_50%,transparent_50%)] ring-[1.5px] ring-inset ring-tag-orange', className)} />
  if (state === 'full') return <span title={title} className={cn(base, 'bg-tag-blue ring-2 ring-tag-blue/30 ring-offset-1 ring-offset-card', className)} />
  if (state === 'warn') return <span title={title} className={cn(base, 'bg-tag-red/15 ring-[1.5px] ring-inset ring-tag-red', className)} />
  return <span title={title} className={cn(base, 'bg-tag-green', className)} />
}
