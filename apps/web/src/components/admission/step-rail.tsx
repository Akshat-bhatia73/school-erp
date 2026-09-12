import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export function StepRail({ steps, current, onGo }: { steps: string[]; current: number; onGo: (i: number) => void }) {
  return (
    <nav className="w-56 shrink-0 border-r bg-card px-3 py-5">
      <ol className="space-y-0.5">
        {steps.map((label, i) => {
          const done = i < current
          const active = i === current
          return (
            <li key={label}>
              <button
                type="button"
                onClick={() => onGo(i)}
                disabled={i > current}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] transition-colors',
                  active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  i > current && 'cursor-not-allowed opacity-60 hover:bg-transparent',
                )}
              >
                <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums', done && 'border-transparent bg-foreground text-background', active && 'border-foreground text-foreground')}>
                  {done ? <Check className="size-3" /> : i + 1}
                </span>
                <span className="truncate">{label}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/** Horizontal steps used by the import wizard */
export function StepBar({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="flex items-center gap-2">
      {steps.map((label, i) => {
        const done = i < current
        const active = i === current
        return (
          <div key={label} className="flex items-center gap-2">
            {i > 0 && <span className="h-px w-8 bg-border" />}
            <span className={cn('inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-[13.5px]', active ? 'border-solid font-medium' : 'border-dashed text-muted-foreground')}>
              <span className={cn('flex size-5 items-center justify-center rounded-full border text-[11px] tabular-nums', done && 'border-transparent bg-foreground text-background', active && 'border-foreground text-foreground')}>
                {done ? <Check className="size-3" /> : i + 1}
              </span>
              {label}
            </span>
          </div>
        )
      })}
    </div>
  )
}
