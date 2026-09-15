import type { ColumnDef } from '@tanstack/react-table'
import { CheckCircle2 } from 'lucide-react'
import { DataTable } from '@/components/shared/data-table'
import { EmptyState, Panel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import type { ImportPreview } from '@/lib/api/students'
import { humanize } from '@/lib/utils'
import type { SheetProblem } from './import-utils'

function Tile({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'bad' }) {
  return (
    <Panel bodyClassName="px-4 py-3.5">
      <p className="text-[12px] text-muted-foreground">{label}</p>
      <p className={`mt-1 text-[22px] font-semibold tabular-nums ${tone === 'good' ? 'text-tag-green' : tone === 'bad' ? 'text-tag-red' : ''}`}>{value}</p>
    </Panel>
  )
}

type ProblemRow = { row: number; field: string; message: string }

const problemColumns: ColumnDef<ProblemRow, unknown>[] = [
  { id: 'row', header: 'Row #', size: 70, cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.row}</span> },
  { id: 'field', header: 'Field', size: 180, cell: ({ row }) => <Tag color="grey">{row.original.field ? humanize(row.original.field.replace(/([A-Z])/g, ' $1').toLowerCase()) : 'Row'}</Tag> },
  { id: 'problem', header: 'Problem', cell: ({ row }) => row.original.message },
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

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Tile label="Rows in the file" value={totalRows} />
        <Tile label="Ready to import" value={validRows} tone="good" />
        <Tile label="Need fixing" value={allProblems.length} tone="bad" />
      </div>

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
