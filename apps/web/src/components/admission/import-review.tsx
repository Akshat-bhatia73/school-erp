import { useMemo, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { CheckCircle2, Users } from 'lucide-react'
import { DataTable } from '@/components/shared/data-table'
import { EmptyState, Panel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import type { ImportPreview } from '@/lib/api/students'
import { columnFor, type SheetProblem } from './import-utils'

function Tile({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'bad' }) {
  return (
    <Panel bodyClassName="px-4 py-3.5">
      <p className="text-[12px] text-muted-foreground">{label}</p>
      <p className={`mt-1 text-[22px] font-semibold tabular-nums ${tone === 'good' ? 'text-tag-green' : tone === 'bad' ? 'text-tag-red' : ''}`}>{value}</p>
    </Panel>
  )
}

const READY_PAGE_SIZE = 50

type ProblemRow = { row: number; field: string; message: string }

const problemColumns: ColumnDef<ProblemRow, unknown>[] = [
  { id: 'row', header: 'Row #', size: 70, cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.row}</span> },
  { id: 'field', header: 'Field', size: 180, cell: ({ row }) => <Tag color="grey">{row.original.field && row.original.field !== 'row' ? columnFor(row.original.field) : 'Row'}</Tag> },
  { id: 'problem', header: 'Problem', cell: ({ row }) => row.original.message },
]

type ReadyRow = ImportPreview['rows'][number]

/** The number the row keeps, or a plain note that the server will give it one. */
const readyColumns: ColumnDef<ReadyRow, unknown>[] = [
  { id: 'row', header: 'Row #', size: 70, cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.rowNumber}</span> },
  { id: 'name', header: 'Student', cell: ({ row }) => [row.original.firstName, row.original.lastName].filter(Boolean).join(' ') },
  {
    id: 'admissionNumber',
    header: 'Admission number',
    size: 220,
    cell: ({ row }) => (row.original.admissionNumber
      ? <span className="font-mono text-[12.5px]">{row.original.admissionNumber}</span>
      : <Tag color="grey">Will be assigned</Tag>),
  },
]

/**
 * What the server made of the uploaded sheet. The counts and the per-row problems are the
 * server's: this screen never decides that a row can be imported.
 */
export function ImportReview({ preview, problems, onBack, onImport, isImporting }: {
  preview: ImportPreview | null
  /** Rows this app could not even send, because the file did not describe them.  */
  problems: SheetProblem[]
  onBack: () => void
  onImport: () => void
  isImporting: boolean
}) {
  const serverProblems: ProblemRow[] = (preview?.errors ?? []).map((error) => ({ row: error.row, field: error.field, message: error.message }))
  const allProblems = [...problems, ...serverProblems].sort((a, b) => a.row - b.row)
  const totalRows = (preview?.totalRows ?? 0) + problems.length
  const validRows = preview?.validRows ?? 0

  // A sheet can carry hundreds of rows, so the preview pages like every other list screen.
  const readyRows = preview?.rows ?? []
  const [page, setPage] = useState(1)
  // A fresh upload can be shorter than the last one, so never sit past the last page.
  const safePage = Math.min(page, Math.max(1, Math.ceil(readyRows.length / READY_PAGE_SIZE)))
  const pageRows = useMemo(() => readyRows.slice((safePage - 1) * READY_PAGE_SIZE, safePage * READY_PAGE_SIZE), [readyRows, safePage])

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Tile label="Rows in the file" value={totalRows} />
        <Tile label="Ready to import" value={validRows} tone="good" />
        <Tile label="Need fixing" value={allProblems.length} tone="bad" />
      </div>

      <Panel title="Rows ready to import" description="A blank number is given by the school's counter when you import." bodyClassName="p-0 pb-0">
        <DataTable
          dense
          columns={readyColumns}
          data={pageRows}
          getRowId={(row) => String(row.rowNumber)}
          footer={<span>{readyRows.length} students in view</span>}
          pagination={{ page: safePage, pageSize: READY_PAGE_SIZE, total: readyRows.length, onPageChange: setPage }}
          emptyState={<EmptyState icon={<Users />} title="No rows are ready yet" description="Fix the problems below and upload the file again." />}
        />
      </Panel>

      <Panel title="Problems to fix" bodyClassName="p-0 pb-0">
        <DataTable
          dense
          columns={problemColumns}
          data={allProblems}
          getRowId={(row) => `${row.row}:${row.field}`}
          footer={<span>Fix these in your Excel and upload again, or import the rows that passed.</span>}
          emptyState={<EmptyState icon={<CheckCircle2 />} title="No problems found" description="Every row in the file can be imported." />}
        />
      </Panel>

      <div className="flex items-center justify-between border-t pt-4">
        <Button variant="outline" onClick={onBack}>Back</Button>
        <Button onClick={onImport} disabled={validRows === 0 || isImporting}>
          {isImporting ? 'Importing…' : `Import ${validRows} students`}
        </Button>
      </div>
    </div>
  )
}
