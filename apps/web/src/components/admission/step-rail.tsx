import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export function StepRail({ steps, current, onGo }: { steps: string[]; current: number; onGo: (i: number) => void }) {
  return (
    <nav aria-label="Admission steps" className="hidden w-56 shrink-0 border-r bg-card px-3 py-5 md:block">
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

/**
 * Mobile stand-in for the step rail: there is no room for a 224px column at 390px,
 * so the same progress is shown as "Step 2 of 4" plus a bar.
 */
export function StepProgress({ steps, current, className }: { steps: string[]; current: number; className?: string }) {
  return (
    <div className={cn('shrink-0 border-b bg-card px-3 py-2.5 md:hidden', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[13.5px] font-medium">{steps[current]}</span>
        <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">Step {current + 1} of {steps.length}</span>
      </div>
      <div className="mt-2 flex gap-1" role="progressbar" aria-valuenow={current + 1} aria-valuemin={1} aria-valuemax={steps.length} aria-label={`Step ${current + 1} of ${steps.length}: ${steps[current]}`}>
        {steps.map((label, i) => (
          <span key={label} className={cn('h-1 flex-1 rounded-full', i <= current ? 'bg-foreground' : 'bg-muted')} />
        ))}
      </div>
    </div>
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
