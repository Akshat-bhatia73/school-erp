import { cn } from '@/lib/utils'

/** Tiny segmented control used for the per-row promote / detain decision */
export function Segmented<T extends string>({ value, options, onChange, className }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cn('inline-flex h-7 items-center rounded-lg border p-0.5', className)} onClick={(e) => e.stopPropagation()}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn('h-6 rounded-md px-2 text-[12.5px] transition-colors', value === o.value ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
