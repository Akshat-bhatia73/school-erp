import { cn } from '@/lib/utils'

/** Twelve small April→March cards showing how many days off fall in each month. */
export function MonthStrip({ months }: { months: Array<{ key: string; label: string; days: number }> }) {
  const max = Math.max(1, ...months.map((m) => m.days))
  return (
    <div className="grid grid-cols-6 gap-2 border-b bg-card px-4 py-3 md:grid-cols-12">
      {months.map((m) => (
        <div key={m.key} className={cn('rounded-lg border px-2 py-1.5 text-center', m.days === 0 && 'border-dashed')}>
          <div className="text-[11.5px] text-muted-foreground">{m.label}</div>
          <div className={cn('text-[15px] font-semibold tabular-nums', m.days === 0 && 'text-muted-foreground/50')}>{m.days}</div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-tag-blue" style={{ width: `${(m.days / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}
