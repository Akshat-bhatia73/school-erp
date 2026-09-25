import type { AssistantValue } from '@erp/contracts'
import { Tag } from '@/components/shared/tag'
import { cn } from '@/lib/utils'
import { tagColor, valueText } from '../format'

/** One card value, drawn by its type: a status as a pill, nothing as a quiet dash, the rest as words. */
export function Value({ value, className }: { value: AssistantValue; className?: string }) {
  if (value.type === 'tag') return <Tag color={tagColor(value.value)} className={className}>{value.value}</Tag>
  if (value.type === 'empty') return <span className={cn('text-muted-foreground/60', className)}>—</span>
  const numeric = value.type === 'number' || value.type === 'money' || value.type === 'percent'
  return <span className={cn(numeric && 'tabular-nums', className)}>{valueText(value)}</span>
}
