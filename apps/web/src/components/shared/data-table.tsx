import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type Row, type RowSelectionState, type SortingState, type OnChangeFn } from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export interface DataTableProps<T> {
  columns: ColumnDef<T, any>[]
  data: T[]
  isLoading?: boolean
  /** Enables the leading checkbox column */
  selectable?: boolean
  rowSelection?: RowSelectionState
  onRowSelectionChange?: OnChangeFn<RowSelectionState>
  getRowId?: (row: T) => string
  sorting?: SortingState
  onSortingChange?: OnChangeFn<SortingState>
  onRowClick?: (row: T) => void
  emptyState?: ReactNode
  /** Footer summary like "20 Companies in view" */
  footer?: ReactNode
  pagination?: { page: number; pageSize: number; total: number; onPageChange: (p: number) => void }
  className?: string
  dense?: boolean
}

/**
 * Data table in the style of the reference: hairline row dividers, column dividers,
 * checkbox column, sortable headers, optional footer bar.
 */
const EMPTY_ROWS: never[] = []
const EMPTY_SORTING: SortingState = []
const EMPTY_SELECTION: RowSelectionState = {}

export function DataTable<T>({ columns, data, isLoading, selectable, rowSelection, onRowSelectionChange, getRowId, sorting, onSortingChange, onRowClick, emptyState, footer, pagination, className, dense }: DataTableProps<T>) {
  // TanStack Table re-runs its auto-reset logic whenever `data` or `columns` change identity.
  // Callers often pass `data?.items ?? []`, which is a new array every render while loading and
  // causes an infinite render loop. Keep references stable here so no caller has to remember.
  const stableData = data.length === 0 ? (EMPTY_ROWS as T[]) : data
  const cols = useMemo<ColumnDef<T, any>[]>(() => selectable
    ? [
        {
          id: '_select',
          size: 44,
          header: ({ table }) => (
            <Checkbox checked={table.getIsAllPageRowsSelected() ? true : table.getIsSomePageRowsSelected() ? 'indeterminate' : false} onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)} aria-label="Select all" className="translate-y-px" />
          ),
          cell: ({ row }) => <Checkbox checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(!!v)} onClick={(e) => e.stopPropagation()} aria-label="Select row" className="translate-y-px" />,
          enableSorting: false,
        },
        ...columns,
      ]
    : columns, [columns, selectable])

  const table = useReactTable({
    data: stableData, columns: cols, getRowId,
    state: { rowSelection: rowSelection ?? EMPTY_SELECTION, sorting: sorting ?? EMPTY_SORTING },
    onRowSelectionChange, onSortingChange,
    enableRowSelection: !!selectable,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    manualSorting: !!onSortingChange,
    autoResetAll: false,
  })

  const rowH = dense ? 'h-10' : 'h-12'

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <table className="w-full border-separate border-spacing-0 text-[13.5px]">
          <thead className="sticky top-0 z-10 bg-card">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h, i) => {
                  const canSort = h.column.getCanSort()
                  const sorted = h.column.getIsSorted()
                  return (
                    <th
                      key={h.id}
                      style={{ width: h.getSize() !== 150 ? h.getSize() : undefined }}
                      className={cn('h-11 border-b bg-card px-3 text-left text-[13px] font-medium text-muted-foreground', i > 0 && 'border-l', i === 0 && selectable && 'pl-4 pr-0 w-11', canSort && 'cursor-pointer select-none hover:text-foreground')}
                      onClick={canSort ? h.column.getToggleSortingHandler() : undefined}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        {sorted === 'asc' && <ArrowUp className="size-3.5" />}
                        {sorted === 'desc' && <ArrowDown className="size-3.5" />}
                      </span>
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {isLoading
              ? Array.from({ length: 8 }).map((_, r) => (
                  <tr key={r}>
                    {cols.map((_, c) => (
                      <td key={c} className={cn(rowH, 'border-b px-3', c > 0 && 'border-l')}><Skeleton className="h-4 w-[70%]" /></td>
                    ))}
                  </tr>
                ))
              : table.getRowModel().rows.map((row: Row<T>) => (
                  <tr
                    key={row.id}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    data-state={row.getIsSelected() ? 'selected' : undefined}
                    className={cn('group transition-colors hover:bg-accent/50 data-[state=selected]:bg-accent/70', onRowClick && 'cursor-pointer')}
                  >
                    {row.getVisibleCells().map((cell, i) => (
                      <td key={cell.id} className={cn(rowH, 'border-b px-3 align-middle', i > 0 && 'border-l', i === 0 && selectable && 'pl-4 pr-0 w-11')}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
        {!isLoading && data.length === 0 && (emptyState ?? <div className="py-16 text-center text-muted-foreground">Nothing here yet.</div>)}
      </div>
      {(footer || pagination) && (
        <div className="flex h-11 shrink-0 items-center justify-between border-t bg-card px-4 text-[12.5px] text-muted-foreground">
          <div className="flex items-center gap-4 divide-x [&>*:not(:first-child)]:pl-4">{footer}</div>
          {pagination && pagination.total > pagination.pageSize && (
            <div className="flex items-center gap-2">
              <span className="tabular-nums">{(pagination.page - 1) * pagination.pageSize + 1}–{Math.min(pagination.page * pagination.pageSize, pagination.total)} of {pagination.total}</span>
              <button type="button" disabled={pagination.page <= 1} onClick={() => pagination.onPageChange(pagination.page - 1)} className="rounded-md border p-1 hover:bg-accent disabled:opacity-40"><ChevronLeft className="size-4" /></button>
              <button type="button" disabled={pagination.page * pagination.pageSize >= pagination.total} onClick={() => pagination.onPageChange(pagination.page + 1)} className="rounded-md border p-1 hover:bg-accent disabled:opacity-40"><ChevronRight className="size-4" /></button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Name cell with a small avatar/icon and dotted underline like "ClickUp" in the reference */
export function EntityCell({ avatar, name, sub, className }: { avatar?: ReactNode; name: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', className)}>
      {avatar && <div className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md [&>img]:size-full [&>img]:object-cover [&>svg]:size-4">{avatar}</div>}
      <div className="min-w-0">
        <div className="truncate font-medium link-dotted">{name}</div>
        {sub && <div className="truncate text-[12px] text-muted-foreground">{sub}</div>}
      </div>
    </div>
  )
}
