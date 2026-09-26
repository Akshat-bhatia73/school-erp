import { Loader2 } from 'lucide-react'
import { ToolCard } from './cards'
import { toolActivityLabel, viewToolPart, type ToolPartLike } from './format'
import { isProposalTool, viewProposalPart } from './proposals/model'
import { ProposalCard } from './proposals/proposal-card'

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
  if (isProposalTool(toolName)) return <ProposalPart part={part} />
  const view = viewToolPart(part)
  switch (view.kind) {
    case 'working': return <ActivityLine label={toolActivityLabel(toolName)} />
    case 'card': return view.card ? <ToolCard card={view.card} /> : null
    case 'failed': return <p className="text-[13px] text-muted-foreground">One lookup failed.</p>
    case 'nothing': return null
  }
}

/**
 * A change tool's call: its editable card, or why it could not be proposed. A refusal shows
 * nothing, as for a lookup, because the model explains.
 */
function ProposalPart({ part }: { part: ToolPartLike }) {
  const view = viewProposalPart(part)
  switch (view.kind) {
    case 'working': return <ActivityLine label="Preparing the change…" />
    case 'proposal': return <ProposalCard proposal={view.proposal} />
    case 'problem': return <p className="text-[13px] text-muted-foreground">{view.text}</p>
    case 'failed': return <p className="text-[13px] text-muted-foreground">That change could not be prepared.</p>
    case 'nothing': return null
  }
}
