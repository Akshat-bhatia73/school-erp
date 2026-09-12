import { useRef, useState } from 'react'
import { Download, FileSpreadsheet, Sparkles, UploadCloud } from 'lucide-react'
import { Panel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { COLUMN_HELP, downloadTemplate } from './import-utils'

export function ImportUpload({ onFile, onSample, isBusy }: { onFile: (file: File) => void; onSample: () => void; isBusy?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  return (
    <div className="space-y-4">
      <Panel bodyClassName="p-4">
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click() }}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault(); setOver(false)
            const f = e.dataTransfer.files?.[0]
            if (f) onFile(f)
          }}
          className={cn('flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors', over ? 'border-foreground bg-accent/60' : 'hover:bg-accent/40')}
        >
          <div className="flex size-10 items-center justify-center rounded-xl border bg-muted/50 text-muted-foreground">
            <UploadCloud className="size-5" />
          </div>
          <p className="text-[14px] font-medium">{isBusy ? 'Reading your file…' : 'Drop your Excel file here, or click to pick one'}</p>
          <p className="text-[13px] text-muted-foreground">.xlsx or .csv, one student per row. Nothing is saved until you confirm.</p>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onFile(f)
              e.target.value = ''
            }}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={downloadTemplate}><Download /> Download template</Button>
          <Button variant="outline" size="sm" onClick={onSample} disabled={isBusy}><Sparkles /> Try with sample data</Button>
        </div>
      </Panel>

      <Panel title="What each column means" description="Your first row must be the header row with these names." actions={<FileSpreadsheet className="size-4 text-muted-foreground" />}>
        <ul className="divide-y">
          {COLUMN_HELP.map((c) => (
            <li key={c.name} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
              <span className="w-56 shrink-0 text-[13.5px] font-medium">{c.name}</span>
              {c.required ? <Tag color="red">Required</Tag> : <Tag color="grey">Optional</Tag>}
              <span className="text-[13px] text-muted-foreground">{c.help}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  )
}
