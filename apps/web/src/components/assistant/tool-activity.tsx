import { Loader2 } from 'lucide-react'
import { ToolCard } from './cards'
import { toolActivityLabel, viewToolPart, type ToolPartLike } from './format'

/** One quiet line with a small spinner: "Looking up attendance…", "Thinking…". */
export function ActivityLine({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-[13px] text-muted-foreground" role="status">
      <Loader2 className="size-3.5 animate-spin" />
      {label}
    </p>
  )
}

/**
 * One tool call inside an answer. Running: an activity line. Done: its card. Refused: nothing,
 * because the model explains. Broken: one muted line.
 */
export function ToolPart({ part, toolName }: { part: ToolPartLike; toolName: string }) {
  const view = viewToolPart(part)
  switch (view.kind) {
    case 'working': return <ActivityLine label={toolActivityLabel(toolName)} />
    case 'card': return view.card ? <ToolCard card={view.card} /> : null
    case 'failed': return <p className="text-[13px] text-muted-foreground">One lookup failed.</p>
    case 'nothing': return null
  }
}
