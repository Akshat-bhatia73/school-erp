import { Link } from '@tanstack/react-router'
import { Check, ChevronRight } from 'lucide-react'
import { Panel } from '@/components/shared/page'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'

export interface SetupStep { key: string; label: string; to: string; done: boolean }

/** "Finish setting up": every step is a read this person is allowed to make. */
export function SetupChecklist({ steps, isLoading }: { steps?: SetupStep[]; isLoading?: boolean }) {
  const list = steps ?? []
  const done = list.filter((s) => s.done).length

  return (
    <Panel title="Setup checklist" description="Finish these to get the most out of the app">
      {isLoading ? (
        <div className="flex flex-col gap-2.5">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
        </div>
      ) : list.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Nothing to set up from here.</p>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <Progress value={(done / Math.max(1, list.length)) * 100} className="h-1.5 flex-1" />
            <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{done} of {list.length} done</span>
          </div>
          <ul className="mt-3 flex flex-col">
            {list.map((s) => (
              <li key={s.key}>
                <Link to={s.to} className="group -mx-2 flex h-9 items-center gap-2.5 rounded-lg px-2 hover:bg-accent">
                  {s.done ? (
                    <span className="flex size-4.5 shrink-0 items-center justify-center rounded-full bg-tag-green/15 text-tag-green"><Check className="size-3" /></span>
                  ) : (
                    <span className="size-4.5 shrink-0 rounded-full border-[1.5px] border-dashed border-muted-foreground/50" />
                  )}
                  <span className={s.done ? 'flex-1 truncate text-[13px] text-muted-foreground' : 'flex-1 truncate text-[13px]'}>{s.label}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground/60 group-hover:text-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  )
}
