import { ArrowRightLeft, Download, UserMinus, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { MarkLeftDialog, MoveSectionDialog } from './student-dialogs'

/** Floating bar that appears at the bottom of the list when rows are selected */
export function StudentBulkBar({ ids, onClear, onExport, canEdit }: { ids: string[]; onClear: () => void; onExport: () => void; canEdit: boolean }) {
  const [move, setMove] = useState(false)
  const [left, setLeft] = useState(false)
  if (ids.length === 0) return null
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 bottom-14 z-20 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-1 rounded-xl border bg-card p-1.5 shadow-lg">
          <span className="px-2 text-[13px] tabular-nums text-muted-foreground">{ids.length} selected</span>
          {canEdit && <Button variant="ghost" size="sm" onClick={() => setMove(true)}><ArrowRightLeft />Move section</Button>}
          {canEdit && <Button variant="ghost" size="sm" onClick={() => setLeft(true)}><UserMinus />Mark as left</Button>}
          <Button variant="ghost" size="sm" onClick={onExport}><Download />Export</Button>
          <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={onClear}><X /></Button>
        </div>
      </div>
      <MoveSectionDialog open={move} onOpenChange={setMove} studentIds={ids} onDone={onClear} />
      <MarkLeftDialog open={left} onOpenChange={setLeft} studentIds={ids} onDone={onClear} />
    </>
  )
}
