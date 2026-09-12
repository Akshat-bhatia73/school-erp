import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

export type TagColor = 'orange' | 'blue' | 'teal' | 'cyan' | 'purple' | 'pink' | 'red' | 'green' | 'yellow' | 'indigo' | 'grey'

const colorClass: Record<TagColor, string> = {
  orange: 'text-tag-orange border-tag-orange/40 dark:bg-tag-orange/15 dark:border-transparent',
  blue: 'text-tag-blue border-tag-blue/40 dark:bg-tag-blue/15 dark:border-transparent',
  teal: 'text-tag-teal border-tag-teal/40 dark:bg-tag-teal/15 dark:border-transparent',
  cyan: 'text-tag-cyan border-tag-cyan/40 dark:bg-tag-cyan/15 dark:border-transparent',
  purple: 'text-tag-purple border-tag-purple/40 dark:bg-tag-purple/15 dark:border-transparent',
  pink: 'text-tag-pink border-tag-pink/40 dark:bg-tag-pink/15 dark:border-transparent',
  red: 'text-tag-red border-tag-red/40 dark:bg-tag-red/15 dark:border-transparent',
  green: 'text-tag-green border-tag-green/40 dark:bg-tag-green/15 dark:border-transparent',
  yellow: 'text-tag-yellow border-tag-yellow/50 dark:bg-tag-yellow/15 dark:border-transparent',
  indigo: 'text-tag-indigo border-tag-indigo/40 dark:bg-tag-indigo/15 dark:border-transparent',
  grey: 'text-muted-foreground border-border dark:bg-muted dark:border-transparent',
}

/** Outline pill like "Project Management" in the reference. */
export function Tag({ color = 'grey', className, children, dot }: { color?: TagColor; className?: string; children: ReactNode; dot?: boolean }) {
  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[12.5px] font-medium leading-none', colorClass[color], className)}>
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
