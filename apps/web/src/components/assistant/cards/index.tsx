import type { AssistantCard } from '@erp/contracts'
import { FiguresCard } from './figures'
import { RecordCard } from './record'
import { TableCard } from './table'

/** The card a tool result is drawn as, chosen by its kind. */
export function ToolCard({ card }: { card: AssistantCard }) {
  switch (card.kind) {
    case 'record': return <RecordCard card={card} />
    case 'table': return <TableCard card={card} />
    case 'figures': return <FiguresCard card={card} />
  }
}
