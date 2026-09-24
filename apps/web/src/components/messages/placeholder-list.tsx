/** The placeholders a message's words may use, each with what it becomes. */
import { MESSAGE_PLACEHOLDERS, type MessagePlaceholder } from '@erp/contracts'

export function PlaceholderList({ names }: { names: readonly MessagePlaceholder[] }) {
  return (
    <ul className="grid gap-x-4 gap-y-0.5 text-[12px] text-muted-foreground sm:grid-cols-2">
      {names.map((p) => <li key={p}><code className="text-foreground">{`{${p}}`}</code> {MESSAGE_PLACEHOLDERS[p]}</li>)}
    </ul>
  )
}
