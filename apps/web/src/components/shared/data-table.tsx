import { Link } from '@tanstack/react-router'
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type Row, type RowSelectionState, type SortingState, type OnChangeFn } from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { useIsMobile } from '@/lib/use-media'
import { cn } from '@/lib/utils'

/** Shape of one record rendered as a card on mobile, where a wide table cannot fit. */
export interface MobileRow {
  title: ReactNode
  subtitle?: ReactNode
  /** Small facts under the title, e.g. class, roll, phone */
  meta?: ReactNode
  /** Right-hand side, e.g. a status tag */
  trailing?: ReactNode
}

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
  /**
   * Destination for a record. Preferred over `onRowClick`: it renders a real link, so rows are
   * reachable by keyboard and support ⌘-click / middle-click to open in a new tab.
   */
  rowLink?: (row: T) => string
  onRowClick?: (row: T) => void
  /** When given, renders a tappable card list instead of the table under the `md` breakpoint. */
  mobileRow?: (row: T) => MobileRow
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
/** Fixed width for the leading checkbox column, so every table lines up. */
const SELECT_COL_PX = 50
/** TanStack's default when a column declares no `size`. */
const DEFAULT_COL_SIZE = 150

const EMPTY_ROWS: never[] = []
const EMPTY_SORTING: SortingState = []
const EMPTY_SELECTION: RowSelectionState = {}

export function DataTable<T>({ columns, data, isLoading, selectable, rowSelection, onRowSelectionChange, getRowId, sorting, onSortingChange, rowLink, onRowClick, mobileRow, emptyState, footer, pagination, className, dense }: DataTableProps<T>) {
  // TanStack Table re-runs its auto-reset logic whenever `data` or `columns` change identity.
  // Callers often pass `data?.items ?? []`, which is a new array every render while loading and
  // causes an infinite render loop. Keep references stable here so no caller has to remember.
  const stableData = data.length === 0 ? (EMPTY_ROWS as T[]) : data
  const isMobile = useIsMobile()
  const asCards = isMobile && !!mobileRow
  const cols = useMemo<ColumnDef<T, any>[]>(() => selectable
    ? [
        {
          id: '_select',
          size: SELECT_COL_PX,
          header: ({ table }) => (
            <span className="flex w-[50px] items-center justify-center">
              <Checkbox checked={table.getIsAllPageRowsSelected() ? true : table.getIsSomePageRowsSelected() ? 'indeterminate' : false} onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)} aria-label="Select all" />
            </span>
          ),
          cell: ({ row }) => (
            <span className="flex w-[50px] items-center justify-center">
              <Checkbox checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(!!v)} onClick={(e) => e.stopPropagation()} aria-label="Select row" />
            </span>
          ),
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
  // A column's declared `size` is its intended width. On desktop it stays a hint, so a wide
  // table still fills the pane the way it always has. On mobile there is no room to give, and
  // squeezing wraps content into unreadable stacks ("1 / Apr / 2025"), so pin min and max to
  // the size and let the table scroll instead. Unsized columns fall back to the nowrap class,
  // which makes their own content the floor.
  const colStyle = (size: number) => {
    if (size === DEFAULT_COL_SIZE) return undefined
    return isMobile ? { width: size, minWidth: size, maxWidth: size } : { width: size }
  }
  // The first data column is the record's name, so it carries the link to the record.
  const linkColumnId = cols[selectable ? 1 : 0]?.id

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        {asCards ? (
          <ul className="flex flex-col">
            {isLoading
              ? Array.from({ length: 8 }).map((_, r) => (
                  <li key={r} className="border-b px-3 py-3">
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="mt-2 h-3 w-1/3" />
                  </li>
                ))
              : table.getRowModel().rows.map((row: Row<T>) => {
                  const card = mobileRow!(row.original)
                  const href = rowLink?.(row.original)
                  const body = (
                    <>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-[14px] font-medium">{card.title}</span>
                        </span>
                        {card.subtitle && <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">{card.subtitle}</span>}
                        {card.meta && <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">{card.meta}</span>}
                      </span>
                      {card.trailing && <span className="flex shrink-0 items-center gap-2">{card.trailing}</span>}
                      {href && <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />}
                    </>
                  )
                  const rowClass = 'flex w-full min-h-14 items-center gap-3 px-3 py-3 text-left transition-colors active:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:-outline-offset-2'
                  return (
                    <li key={row.id} className={cn('border-b', row.getIsSelected() && 'bg-accent/70')}>
                      {href ? (
                        <Link to={href} className={rowClass}>{body}</Link>
                      ) : onRowClick ? (
                        <button type="button" onClick={() => onRowClick(row.original)} className={rowClass}>{body}</button>
                      ) : (
                        <div className={rowClass}>{body}</div>
                      )}
                    </li>
                  )
                })}
          </ul>
        ) : (
        <table className="w-full border-separate border-spacing-0 text-[13.5px]">
          <thead className="sticky top-0 z-10 bg-card">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h, i) => {
                  const canSort = h.column.getCanSort()
                  const sorted = h.column.getIsSorted()
                  const label = flexRender(h.column.columnDef.header, h.getContext())
                  return (
                    <th
                      key={h.id}
                      style={colStyle(h.getSize())}
                      aria-sort={canSort ? (sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none') : undefined}
                      className={cn('h-11 border-b bg-card px-3 text-left text-[13px] font-medium text-muted-foreground max-md:whitespace-nowrap', i > 0 && 'border-l', i === 0 && selectable && 'w-[50px] min-w-[50px] px-0')}
                    >
                      {canSort ? (
                        <button
                          type="button"
                          onClick={h.column.getToggleSortingHandler()}
                          className="inline-flex select-none items-center gap-1.5 rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                          {label}
                          {sorted === 'asc' && <ArrowUp className="size-3.5" />}
                          {sorted === 'desc' && <ArrowDown className="size-3.5" />}
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">{label}</span>
                      )}
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
                      <td key={c} className={cn(rowH, 'border-b px-3 max-md:whitespace-nowrap', c > 0 && 'border-l', c === 0 && selectable && 'w-[50px] min-w-[50px] px-0')}><Skeleton className={cn('h-4', c === 0 && selectable ? 'mx-auto w-4' : 'w-[70%]')} /></td>
                    ))}
                  </tr>
                ))
              : table.getRowModel().rows.map((row: Row<T>) => {
                  const href = rowLink?.(row.original)
                  const click = onRowClick ? () => onRowClick(row.original) : undefined
                  return (
                  <tr
                    key={row.id}
                    // Mouse convenience only; the link in the name cell is what makes a row
                    // reachable by keyboard, so this is never the sole way to open a record.
                    onClick={click}
                    data-state={row.getIsSelected() ? 'selected' : undefined}
                    className={cn('group transition-colors hover:bg-accent/50 data-[state=selected]:bg-accent/70', (click || href) && 'cursor-pointer')}
                  >
                    {row.getVisibleCells().map((cell, i) => {
                      const content = flexRender(cell.column.columnDef.cell, cell.getContext())
                      return (
                      <td key={cell.id} style={colStyle(cell.column.getSize())} className={cn(rowH, 'border-b px-3 align-middle max-md:whitespace-nowrap', i > 0 && 'border-l', i === 0 && selectable && 'w-[50px] min-w-[50px] px-0')}>
                        {cell.column.id !== linkColumnId ? content
                          : href ? <Link to={href} className="block rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">{content}</Link>
                          : click ? <button type="button" onClick={click} className="block w-full rounded-sm text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">{content}</button>
                          : content}
                      </td>
                      )
                    })}
                  </tr>
                  )
                })}
          </tbody>
        </table>
        )}
        {!isLoading && data.length === 0 && (emptyState ?? <div className="py-16 text-center text-muted-foreground">Nothing here yet.</div>)}
      </div>
      {(footer || pagination) && (
        <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-t bg-card px-3 text-[12.5px] text-muted-foreground md:px-4">
          {/* Only the headline count survives at 390px; the rest would collide with the pager */}
          <div className="flex min-w-0 items-center gap-x-4 overflow-hidden whitespace-nowrap max-md:[&>*:not(:first-child)]:hidden [&>*]:shrink-0 md:divide-x md:[&>*:not(:first-child)]:pl-4">{footer}</div>
          {pagination && pagination.total > pagination.pageSize && (
            <div className="flex shrink-0 items-center gap-2">
              <span className="tabular-nums" aria-live="polite">{(pagination.page - 1) * pagination.pageSize + 1}–{Math.min(pagination.page * pagination.pageSize, pagination.total)} of {pagination.total}</span>
              <button type="button" aria-label="Previous page" disabled={pagination.page <= 1} onClick={() => pagination.onPageChange(pagination.page - 1)} className="rounded-md border p-1.5 hover:bg-accent disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:p-1"><ChevronLeft className="size-4" /></button>
              <button type="button" aria-label="Next page" disabled={pagination.page * pagination.pageSize >= pagination.total} onClick={() => pagination.onPageChange(pagination.page + 1)} className="rounded-md border p-1.5 hover:bg-accent disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:p-1"><ChevronRight className="size-4" /></button>
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
