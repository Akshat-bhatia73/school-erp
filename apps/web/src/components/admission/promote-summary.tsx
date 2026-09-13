import { ArrowRight, TriangleAlert } from 'lucide-react'
import { Facts, Panel } from '@/components/shared/page'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

export function PromoteSummary({ total, promoteCount, detainCount, fromLabel, toLabel, fromYear, toYear, capacityWarning, canPromote, disabled, isPending, onConfirm }: {
  total: number
  promoteCount: number
  detainCount: number
  fromLabel: string
  toLabel: string
  fromYear: string
  toYear: string
  capacityWarning?: string
  canPromote: boolean
  disabled: boolean
  isPending: boolean
  onConfirm: () => void
}) {
  return (
    <aside className="flex shrink-0 flex-col gap-3 border-t bg-card p-3 scrollbar-thin md:w-80 md:overflow-y-auto md:border-t-0 md:border-l md:p-4">
      <Panel title="What will happen">
        <p className="text-[13.5px]">
          <span className="font-semibold tabular-nums">{total}</span> students ·{' '}
          <span className="font-semibold tabular-nums text-tag-green">{promoteCount}</span> promote ·{' '}
          <span className="font-semibold tabular-nums text-tag-orange">{detainCount}</span> detain
        </p>
        <div className="mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px]">
          <span className="truncate">{fromLabel}</span>
          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{toLabel}</span>
        </div>
        <Facts className="mt-3" columns={1} items={[{ label: 'From year', value: fromYear }, { label: 'To year', value: toYear }]} />
      </Panel>

      {capacityWarning && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>The new section will be over capacity</AlertTitle>
          <AlertDescription>{capacityWarning}</AlertDescription>
        </Alert>
      )}

      {canPromote && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button className="w-full" disabled={disabled || isPending}>{isPending ? 'Promoting…' : 'Promote students'}</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Promote {promoteCount} students?</AlertDialogTitle>
              <AlertDialogDescription>
                {promoteCount} students move from {fromLabel} to {toLabel} for {toYear}
                {detainCount ? `, and ${detainCount} stay in ${fromLabel}` : ''}. The {fromYear} record is kept for history.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onConfirm}>Promote students</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </aside>
  )
}
