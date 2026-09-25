import type { AssistantSource } from '@erp/contracts'
import { FileText } from 'lucide-react'
import { AppLink } from './app-link'

/** Where an answer came from. Built by the server from the calls it made, never by the model. */
export function Sources({ sources }: { sources: readonly AssistantSource[] }) {
  if (sources.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
      <span>From:</span>
      {sources.map((source) => (
        <AppLink key={source.href} href={source.href} className="inline-flex min-w-0 items-center gap-1 rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <FileText className="size-3.5 shrink-0" />
          <span className="truncate">{source.label}</span>
        </AppLink>
      ))}
    </div>
  )
}
