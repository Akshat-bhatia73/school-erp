import type { AssistantCard } from '@erp/contracts'
import { ArrowUpRight, FileText, School, Users } from 'lucide-react'
import { UserAvatar } from '@/components/shared/avatar'
import { Facts } from '@/components/shared/page'
import { Tag, colorFor } from '@/components/shared/tag'
import { AppLink } from '../app-link'
import { Value } from './value'

type RecordCardData = Extract<AssistantCard, { kind: 'record' }>

const PEOPLE = new Set<RecordCardData['entity']>(['student', 'staff', 'guardian'])

/** One pupil, staff member, section or school: who or what it is, a few facts, and its page. */
export function RecordCard({ card }: { card: RecordCardData }) {
  const icon = card.entity === 'section' ? <Users /> : card.entity === 'school' ? <School /> : <FileText />
  return (
    <section className="rounded-xl border bg-card">
      <header className="flex items-start gap-3 px-3.5 pt-3.5 pb-3">
        {PEOPLE.has(card.entity)
          ? <UserAvatar name={card.title} size="lg" />
          : <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground [&>svg]:size-5">{icon}</span>}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold leading-tight">
            {card.href ? <AppLink href={card.href} className="link-dotted hover:text-foreground">{card.title}</AppLink> : card.title}
          </p>
          {card.subtitle && <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">{card.subtitle}</p>}
          {card.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {card.tags.map((tag) => <Tag key={tag} color={colorFor(tag)}>{tag}</Tag>)}
            </div>
          )}
        </div>
        {card.href && (
          <AppLink href={card.href} className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground">
            Open<ArrowUpRight className="size-3.5" />
          </AppLink>
        )}
      </header>
      {card.facts.length > 0 && (
        <div className="border-t px-3.5 py-3">
          <Facts columns={2} items={card.facts.map((fact) => ({ label: fact.label, value: <Value value={fact.value} /> }))} />
        </div>
      )}
    </section>
  )
}
