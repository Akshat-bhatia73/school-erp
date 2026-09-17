import type { AuditEvent } from '@/lib/api/audit'
import { UserAvatar } from '@/components/shared/avatar'
import { Facts } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { formatDate } from '@/lib/utils'

export function formatWhen(iso: string) {
  const at = new Date(iso)
  const time = Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return { date: formatDate(iso), time }
}

/** 'members.suspend' -> 'Members suspend'. The server sends the raw action name. */
export function actionLabel(action: string): string {
  const words = action.replace(/[._]/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * One audit entry, exactly as the server sends it. The summary carries no field-level changes in
 * this build, so nothing here is reconstructed or guessed.
 */
export function AuditDetailSheet({ entry, onOpenChange }: { entry: AuditEvent | null; onOpenChange: (open: boolean) => void }) {
  const when = entry ? formatWhen(entry.at) : { date: '', time: '' }
  return (
    <Sheet open={!!entry} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Details</SheetTitle>
          <SheetDescription>{entry?.summary}</SheetDescription>
        </SheetHeader>
        {entry && (
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-6">
            <Facts
              items={[
                { label: 'Who', value: <span className="flex items-center gap-2"><UserAvatar name={entry.actorDisplayName} size="xs" />{entry.actorDisplayName}</span> },
                { label: 'When', value: <span className="tabular-nums">{when.date} · {when.time}</span> },
                { label: 'Action', value: <Tag color="blue">{actionLabel(entry.action)}</Tag> },
                { label: 'Outcome', value: <Tag color={entry.outcome === 'allowed' ? 'green' : 'red'} dot>{entry.outcome === 'allowed' ? 'Allowed' : 'Refused'}</Tag> },
                { label: 'Entry id', value: <span className="font-mono text-[12.5px]">{entry.id}</span> },
              ]}
            />
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
