/** Small pieces every change card shares: how a changed row looks, the old value struck through, and the table's scroll box. */
import type { ReactNode } from 'react'

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
