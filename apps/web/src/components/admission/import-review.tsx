import type { ColumnDef } from '@tanstack/react-table'
import type { ImportPreview, ImportRowError, StudentImportRow } from '@erp/shared'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { EmptyState, Panel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { UserAvatar } from '@/components/shared/avatar'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CheckCircle2 } from 'lucide-react'
import { formatDate, humanize } from '@/lib/utils'

function Tile({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'bad' }) {
  return (
    <Panel bodyClassName="px-4 py-3.5">
      <p className="text-[12px] text-muted-foreground">{label}</p>
      <p className={`mt-1 text-[22px] font-semibold tabular-nums ${tone === 'good' ? 'text-tag-green' : tone === 'bad' ? 'text-tag-red' : ''}`}>{value}</p>
    </Panel>
  )
}

const validColumns: ColumnDef<StudentImportRow, unknown>[] = [
  { id: 'row', header: 'Row #', size: 70, cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.rowNumber}</span> },
  { id: 'name', header: 'Name', cell: ({ row }) => {
    const name = [row.original.firstName, row.original.lastName].filter(Boolean).join(' ')
    return <EntityCell avatar={<UserAvatar name={name} size="sm" />} name={name} sub={row.original.admissionNumber || undefined} />
  } },
  { id: 'dob', header: 'Date of birth', cell: ({ row }) => formatDate(row.original.dateOfBirth) },
  { id: 'gender', header: 'Gender', cell: ({ row }) => humanize(row.original.gender) },
  { id: 'class', header: 'Class', cell: ({ row }) => <Tag color="blue">{row.original.grade} · {row.original.section}</Tag> },
  { id: 'roll', header: 'Roll', size: 70, cell: ({ row }) => <span className="tabular-nums">{row.original.rollNumber ?? '—'}</span> },
  { id: 'phone', header: 'Guardian phone', cell: ({ row }) => <span className="tabular-nums">{row.original.guardianPhone}</span> },
]

const errorColumns: ColumnDef<ImportRowError, unknown>[] = [
  { id: 'row', header: 'Row #', size: 70, cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.rowNumber}</span> },
  { id: 'field', header: 'Field', size: 180, cell: ({ row }) => <Tag color="grey">{row.original.field ? humanize(row.original.field.replace(/([A-Z])/g, ' $1').toLowerCase()) : 'Row'}</Tag> },
  { id: 'problem', header: 'Problem', cell: ({ row }) => row.original.message },
]

export function ImportReview({ preview, onBack, onImport, isImporting }: { preview: ImportPreview; onBack: () => void; onImport: () => void; isImporting: boolean }) {
  const ready = preview.validRows.length
  const broken = preview.errors.length
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Tile label="Rows in the file" value={preview.totalRows} />
        <Tile label="Ready to import" value={ready} tone="good" />
        <Tile label="Need fixing" value={broken} tone="bad" />
      </div>

      <Tabs defaultValue={ready ? 'ready' : 'errors'}>
        <TabsList>
          <TabsTrigger value="ready">Ready ({ready})</TabsTrigger>
          <TabsTrigger value="errors">Errors ({broken})</TabsTrigger>
        </TabsList>
        <TabsContent value="ready">
          <Panel bodyClassName="p-0 pb-0">
            <DataTable
              dense
              columns={validColumns}
              data={preview.validRows}
              footer={<span>{ready} students ready</span>}
              emptyState={<EmptyState icon={<CheckCircle2 />} title="No rows are ready yet" description="Fix the problems in the Errors tab and upload the file again." />}
            />
          </Panel>
        </TabsContent>
        <TabsContent value="errors">
          <Panel bodyClassName="p-0 pb-0">
            <DataTable
              dense
              columns={errorColumns}
              data={preview.errors}
              footer={<span>Fix these in your Excel and upload again, or import the ready rows now.</span>}
              emptyState={<EmptyState icon={<CheckCircle2 />} title="No problems found" description="Every row in the file can be imported." />}
            />
          </Panel>
        </TabsContent>
      </Tabs>

      <div className="flex items-center justify-between border-t pt-4">
        <Button variant="outline" onClick={onBack}>Back</Button>
        <Button onClick={onImport} disabled={!ready || isImporting}>{isImporting ? 'Importing…' : `Import ${ready} students`}</Button>
      </div>
    </div>
  )
}
