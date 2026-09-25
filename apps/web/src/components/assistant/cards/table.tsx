import type { AssistantCard } from '@erp/contracts'
import type { ColumnDef } from '@tanstack/react-table'
import { useMemo } from 'react'
import { DataTable } from '@/components/shared/data-table'
import { cn } from '@/lib/utils'
import { AppLink } from '../app-link'
import { tableFooter } from '../format'
import { Value } from './value'

type TableCardData = Extract<AssistantCard, { kind: 'table' }>
type Row = TableCardData['rows'][number]

/** A list the assistant looked up, in the app's own table look. The first cell opens the row's page. */
export function TableCard({ card }: { card: TableCardData }) {
  const columns = useMemo<ColumnDef<Row>[]>(() => card.columns.map((column, index) => ({
    id: column.key,
    header: column.label,
    cell: ({ row }) => {
      const value = row.original.cells[column.key] ?? { type: 'empty' as const }
      const content = <Value value={value} />
      const aligned = <div className={cn('min-w-0 truncate', column.align === 'end' && 'text-right')}>{content}</div>
      return index === 0 && row.original.href
        ? <AppLink href={row.original.href} className="block truncate font-medium link-dotted">{content}</AppLink>
        : aligned
    },
  })), [card.columns])

  return (
    <section className="flex max-h-[440px] flex-col overflow-hidden rounded-xl border bg-card">
      <h4 className="shrink-0 border-b px-3.5 py-2.5 text-[13px] font-medium">{card.title}</h4>
      <DataTable
        dense
        columns={columns}
        data={card.rows}
        footer={<span>{tableFooter(card)}</span>}
        emptyState={<p className="py-8 text-center text-[13px] text-muted-foreground">Nothing found.</p>}
      />
    </section>
  )
}
