import { Cog, Globe, Monitor, Smartphone, Sparkles } from 'lucide-react'
import type { AuditLog } from '@erp/shared'
import { Facts } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { UserAvatar } from '@/components/shared/avatar'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDate, humanize } from '@/lib/utils'
import { auditActionColor, entityLabels } from './settings-tabs'

const viaIcon = { web: Globe, desktop: Monitor, mobile: Smartphone, assistant: Sparkles, system: Cog }
const viaLabel = { web: 'Web app', desktop: 'Desktop app', mobile: 'Mobile app', assistant: 'AI assistant', system: 'System' }

export function ViaIcon({ via }: { via: AuditLog['via'] }) {
  const Icon = viaIcon[via]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex text-muted-foreground"><Icon className="size-4" /></span>
      </TooltipTrigger>
      <TooltipContent>{viaLabel[via]}</TooltipContent>
    </Tooltip>
  )
}

export function formatWhen(iso: string) {
  const d = new Date(iso)
  const time = Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return { date: formatDate(iso), time }
}

function valueText(v: unknown) {
  if (v === undefined || v === null || v === '') return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** Full record for one audit entry */
export function AuditDetailSheet({ entry, onOpenChange }: { entry: AuditLog | null; onOpenChange: (v: boolean) => void }) {
  const when = entry ? formatWhen(entry.createdAt) : { date: '', time: '' }
  return (
    <Sheet open={!!entry} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Details</SheetTitle>
          <SheetDescription>{entry?.summary}</SheetDescription>
        </SheetHeader>
        {entry && (
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto scrollbar-thin px-4 pb-6">
            <Facts
              items={[
                { label: 'Who', value: <span className="flex items-center gap-2"><UserAvatar name={entry.actorName} size="xs" />{entry.actorName}</span> },
                { label: 'When', value: <span className="tabular-nums">{when.date} · {when.time}</span> },
                { label: 'Action', value: <Tag color={auditActionColor[entry.action]}>{humanize(entry.action)}</Tag> },
                { label: 'Entity', value: <Tag color="grey">{entityLabels[entry.entity]}</Tag> },
                { label: 'Entity id', value: <span className="font-mono text-[12.5px]">{entry.entityId ?? '—'}</span> },
                { label: 'Via', value: <span className="flex items-center gap-2"><ViaIcon via={entry.via} />{viaLabel[entry.via]}</span> },
                { label: 'IP address', value: <span className="font-mono text-[12.5px]">{entry.ipAddress ?? '—'}</span> },
              ]}
            />
            {entry.changes && entry.changes.length > 0 && (
              <div className="overflow-hidden rounded-xl border">
                <table className="w-full border-separate border-spacing-0 text-[13px]">
                  <thead>
                    <tr>
                      <th className="h-9 border-b bg-muted/40 px-3 text-left font-medium text-muted-foreground">Field</th>
                      <th className="h-9 border-b border-l bg-muted/40 px-3 text-left font-medium text-muted-foreground">From</th>
                      <th className="h-9 border-b border-l bg-muted/40 px-3 text-left font-medium text-muted-foreground">To</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entry.changes.map((c, i) => (
                      <tr key={`${c.field}-${i}`}>
                        <td className="h-9 border-b px-3 font-medium">{humanize(c.field)}</td>
                        <td className="h-9 border-b border-l px-3 text-muted-foreground">{valueText(c.from)}</td>
                        <td className="h-9 border-b border-l px-3">{valueText(c.to)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
