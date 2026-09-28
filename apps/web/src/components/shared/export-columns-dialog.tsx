/**
 * "Choose columns" for the student and staff list exports. Only the columns whose key the person
 * holds are offered, the defaults start ticked, and the last choice is remembered in this browser.
 * The request names the columns only when the choice differs from the defaults.
 */
import { useMemo, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  FULL_IDENTITY_COLUMNS, columnsToSend, initialColumns, offeredColumns, rememberColumns, type ExportColumnList,
} from '@/lib/export-columns'
import { useSchoolContext } from '@/lib/session'

const NOUN: Record<ExportColumnList, (count: number) => string> = {
  students: (count) => (count === 1 ? '1 student' : `${count} students`),
  staff: (count) => `${count} staff`,
}

export function ExportColumnsDialog({ list, open, onOpenChange, count, pending = false, onExport }: {
  list: ExportColumnList
  open: boolean
  onOpenChange: (open: boolean) => void
  /** How many rows are selected, for the button. */
  count: number
  pending?: boolean
  /** Called with the columns to send, or undefined for the default file. */
  onExport: (columns: string[] | undefined) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mounted only while open, so each opening starts from the remembered choice. */}
      {open && <ColumnChoice list={list} count={count} pending={pending} onExport={onExport} onCancel={() => onOpenChange(false)} />}
    </Dialog>
  )
}

function ColumnChoice({ list, count, pending, onExport, onCancel }: {
  list: ExportColumnList
  count: number
  pending: boolean
  onExport: (columns: string[] | undefined) => void
  onCancel: () => void
}) {
  const { schoolId, hasPermission } = useSchoolContext()
  const offered = useMemo(() => offeredColumns(list, hasPermission), [list, hasPermission])
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(initialColumns(schoolId, list, offered)))

  const toggle = (key: string) => {
    setChosen((old) => {
      const next = new Set(old)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const submit = () => {
    if (chosen.size === 0) return
    rememberColumns(schoolId, list, chosen)
    onExport(columnsToSend(list, chosen))
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Choose columns</DialogTitle>
        <DialogDescription>The file keeps the columns in this order. Your choice is remembered on this device.</DialogDescription>
      </DialogHeader>
      <div className="grid max-h-[55vh] gap-1 overflow-y-auto px-6 scrollbar-thin">
        {offered.map((option) => (
          <div key={option.key}>
            <label className="flex items-center gap-2.5 rounded-md px-1 py-1.5 text-[13.5px] hover:bg-accent">
              <Checkbox checked={chosen.has(option.key)} onCheckedChange={() => toggle(option.key)} aria-label={option.label} />
              {option.label}
            </label>
            {FULL_IDENTITY_COLUMNS.has(option.key) && (
              <p className="flex items-start gap-1.5 pb-1 pl-7 text-[12.5px] text-tag-red">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                The file will hold whole Aadhaar numbers. Keep it safe and delete it when done.
              </p>
            )}
          </div>
        ))}
      </div>
      {chosen.size === 0 && <p className="px-6 text-[12.5px] text-destructive">Choose at least one column.</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button disabled={pending || chosen.size === 0} onClick={submit}>
          {pending ? 'Starting…' : `Export ${NOUN[list](count)}`}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
