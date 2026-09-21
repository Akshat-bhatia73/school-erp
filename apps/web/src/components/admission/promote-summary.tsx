import { ArrowRight } from 'lucide-react'
import { Facts, Panel } from '@/components/shared/page'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

export function PromoteSummary({
  total, promoteCount, detainCount, leftOutCount, fromLabel, toLabel, fromYear, toYear,
  reason, onReasonChange, reasonError, result, disabled, disabledReason, isPending, onConfirm,
}: {
  total: number
  promoteCount: number
  detainCount: number
  /** Students in view who are not sent at all, so nothing about them changes. */
  leftOutCount: number
  fromLabel: string
  toLabel: string
  fromYear: string
  toYear: string
  reason: string
  onReasonChange: (value: string) => void
  reasonError?: string
  /** What the last promotion actually did, once the server has answered. */
  result?: { promoted: number; detained: number }
  disabled: boolean
  disabledReason?: string
  isPending: boolean
  onConfirm: () => void
}) {
  return (
    <aside className="flex shrink-0 flex-col gap-3 border-t bg-card p-3 scrollbar-thin md:w-80 md:overflow-y-auto md:border-t-0 md:border-l md:p-4">
      <Panel title="What will happen">
        <p className="text-[13.5px]">
          <span className="font-semibold tabular-nums">{total}</span> students ·{' '}
          <span className="font-semibold tabular-nums text-tag-green">{promoteCount}</span> promote ·{' '}
          <span className="font-semibold tabular-nums text-tag-orange">{detainCount}</span> detain ·{' '}
          <span className="font-semibold tabular-nums text-muted-foreground">{leftOutCount}</span> left out
        </p>
        <div className="mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px]">
          <span className="truncate">{fromLabel}</span>
          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{toLabel}</span>
        </div>
        <Facts className="mt-3" columns={1} items={[{ label: 'From year', value: fromYear }, { label: 'To year', value: toYear }]} />
      </Panel>

      <Panel title="Reason">
        <div className="grid gap-1.5">
          <Label className="text-[12.5px] text-muted-foreground">Why are these students moving up?</Label>
          <Textarea rows={2} value={reason} onChange={(event) => onReasonChange(event.target.value)} placeholder="End of year promotion" />
          {reasonError && <p className="text-[12px] text-destructive">{reasonError}</p>}
        </div>
      </Panel>

      {result && (
        <Panel title="Last promotion">
          <Facts columns={1} items={[{ label: 'Promoted', value: result.promoted }, { label: 'Detained', value: result.detained }]} />
        </Panel>
      )}

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button className="w-full" disabled={disabled || isPending}>{isPending ? 'Promoting…' : 'Promote students'}</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move {promoteCount + detainCount} students?</AlertDialogTitle>
            <AlertDialogDescription>
              {promoteCount} to promote, {detainCount} to detain, {leftOutCount} left out.{' '}
              {promoteCount} {promoteCount === 1 ? 'student moves' : 'students move'} from {fromLabel} to {toLabel} for {toYear}
              {detainCount ? `, and ${detainCount} stay in the same grade` : ''}.
              {leftOutCount ? ` The ${leftOutCount} left out are not touched at all.` : ''} The {fromYear} record is kept for history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirm}>Promote students</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {disabled && disabledReason && <p className="text-[12px] text-muted-foreground">{disabledReason}</p>}
    </aside>
  )
}
