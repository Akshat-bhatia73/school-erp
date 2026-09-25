import { ASSISTANT_QUESTION_MAX } from '@erp/contracts'
import { ArrowUp, Square } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

/** The tallest the box grows before it scrolls. */
const MAX_HEIGHT_PX = 200
/** The count shows once the question gets close to the limit. */
const WARN_FROM = ASSISTANT_QUESTION_MAX - 200

/**
 * Where the person types. Enter sends, Shift+Enter starts a new line. While an answer is being
 * written the round button becomes Stop.
 */
export function Composer({ value, onChange, onSend, onStop, busy, autoFocus, className }: {
  value: string
  onChange: (value: string) => void
  onSend: (text: string) => void
  onStop?: () => void
  /** An answer is on its way: Enter does nothing and the button stops it. */
  busy?: boolean
  autoFocus?: boolean
  className?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const text = value.trim()

  // Grow with the words, up to a limit. Measured after every change so a paste sizes at once.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
  }, [value])

  const send = () => {
    if (busy || text === '') return
    onSend(text)
  }

  return (
    <div
      className={cn(
        'rounded-xl border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-16px_rgba(0,0,0,0.18)] transition-colors focus-within:border-ring/60',
        className,
      )}
    >
      <textarea
        ref={ref}
        rows={1}
        value={value}
        maxLength={ASSISTANT_QUESTION_MAX}
        autoFocus={autoFocus}
        aria-label="Your question"
        placeholder="Ask anything about your school…"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
        className="block max-h-[200px] min-h-[52px] w-full resize-none overflow-y-auto bg-transparent px-3.5 pt-3.5 pb-1 text-[13.5px] leading-relaxed outline-none placeholder:text-muted-foreground scrollbar-thin"
      />
      <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5">
        {value.length >= WARN_FROM && (
          <span className="mr-auto pl-1 text-[11.5px] tabular-nums text-muted-foreground">
            {ASSISTANT_QUESTION_MAX - value.length} characters left
          </span>
        )}
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            title="Stop"
            className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <Square className="size-3 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={text === ''}
            aria-label="Send"
            title="Send"
            className={cn(
              'flex size-8 items-center justify-center rounded-full border transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
              text === '' ? 'bg-card text-muted-foreground' : 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90',
            )}
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>
    </div>
  )
}
