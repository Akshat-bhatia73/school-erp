/**
 * Small pieces every change card shares: how a changed row looks, the old value struck through,
 * the table's scroll box, and a fee card's pupil line and field errors.
 */
import { UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { Tag } from '@/components/shared/tag'

/** Past this many rows a card's table scrolls inside the card and offers "Show only changes". */
export const LONG_LIST = 12

/** About twelve rows and the header, then the table scrolls inside the card. */
export const SCROLL_BOX = 'max-h-[31rem] overflow-auto scrollbar-thin'

/** A changed row: a faint wash and a hairline on its leading edge, never a loud colour. */
export const CHANGED_ROW = 'bg-accent/60 [&>td:first-child]:shadow-[inset_2px_0_0_var(--color-ring)]'

/** What is saved now, struck through beside the new value. */
export function Was({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 text-[12.5px] text-muted-foreground line-through decoration-muted-foreground/70">
      <span className="sr-only">was </span>
      {children}
    </span>
  )
}

/** Who a fee change is for and the year, both fixed: for another pupil the person asks again. */
export function PupilLine({ label, year, children }: { label: string; year: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3.5 py-2.5 text-[13px]">
      <UserRound className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 font-medium break-words">{label}</span>
      {children}
      <Tag color="grey">{year}</Tag>
    </div>
  )
}

/** A field's own error under it, tied to the box by id. */
export function FieldError({ id, text }: { id: string; text?: string }) {
  return text ? <p id={id} role="alert" className="text-[12.5px] text-tag-red">{text}</p> : null
}

/** The small grey label every card field uses. */
export const FIELD_LABEL = 'text-[12.5px] font-normal text-muted-foreground'
