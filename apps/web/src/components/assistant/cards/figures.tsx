import type { AssistantCard } from '@erp/contracts'
import { Value } from './value'

type FiguresCardData = Extract<AssistantCard, { kind: 'figures' }>

/** A few numbers side by side: attendance, dues, results. */
export function FiguresCard({ card }: { card: FiguresCardData }) {
  return (
    <section className="rounded-xl border bg-card px-3.5 pt-3 pb-3.5">
      <h4 className="text-[13px] font-medium">{card.title}</h4>
      <dl className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {card.items.map((item, i) => (
          <div key={`${item.label}-${i}`} className="min-w-0 rounded-lg border bg-muted/30 px-3 py-2.5">
            <dt className="truncate text-[12px] text-muted-foreground">{item.label}</dt>
            <dd className="mt-1 truncate text-[18px] font-semibold leading-tight">
              <Value value={item.value} className={item.value.type === 'tag' ? 'text-[12.5px]' : undefined} />
            </dd>
            {item.hint && <p className="mt-1 truncate text-[11.5px] text-muted-foreground">{item.hint}</p>}
          </div>
        ))}
      </dl>
    </section>
  )
}
