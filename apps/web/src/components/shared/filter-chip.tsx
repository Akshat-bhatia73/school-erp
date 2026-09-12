import { Check, ChevronDown, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export interface ChipOption<T extends string = string> { value: T; label: string; icon?: ReactNode; count?: number }

/**
 * Filter chip like "Stage  Any ⌄" from the dark reference and "All companies ⌄" from the light one.
 * `label` is the dim prefix, `value` is the current selection.
 */
export function FilterChip<T extends string>({ label, value, options, onChange, allLabel = 'All', className, clearable = true }: {
  label?: string
  value: T | undefined
  options: ChipOption<T>[]
  onChange: (v: T | undefined) => void
  allLabel?: string
  className?: string
  clearable?: boolean
}) {
  const current = options.find((o) => o.value === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-9 items-center gap-1.5 rounded-lg border bg-card pr-2 pl-3 text-[13.5px] transition-colors hover:bg-accent',
            value ? 'border-solid' : 'border-dashed text-muted-foreground',
            className,
          )}
        >
          {label && <span className="text-muted-foreground">{label}</span>}
          <span className={cn(value && 'font-medium text-foreground')}>{current?.label ?? allLabel}</span>
          {value && clearable ? (
            <span role="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); onChange(undefined) }} className="ml-0.5 rounded p-0.5 hover:bg-muted"><X className="size-3.5" /></span>
          ) : (
            <ChevronDown className="size-3.5 text-muted-foreground" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44 max-h-80 overflow-y-auto">
        {clearable && (
          <DropdownMenuItem onClick={() => onChange(undefined)} className="justify-between">
            {allLabel}
            {!value && <Check className="size-4" />}
          </DropdownMenuItem>
        )}
        {options.map((o) => (
          <DropdownMenuItem key={o.value} onClick={() => onChange(o.value)} className="justify-between gap-3">
            <span className="flex items-center gap-2">{o.icon}{o.label}</span>
            <span className="flex items-center gap-2">
              {o.count !== undefined && <span className="text-[11.5px] tabular-nums text-muted-foreground">{o.count}</span>}
              {o.value === value && <Check className="size-4" />}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Dashed-border toolbar button like "Sort" and "Filters" in the reference */
export function ToolbarButton({ icon, children, onClick, active, className }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; active?: boolean; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={cn('inline-flex h-9 items-center gap-2 rounded-lg border border-dashed bg-card px-3 text-[13.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&>svg]:size-4', active && 'border-solid text-foreground', className)}>
      {icon}{children}
    </button>
  )
}
