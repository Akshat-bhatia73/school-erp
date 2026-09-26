/**
 * "Confirm all (3)" under an answer that proposed more than one change. It presses each open
 * card's own Confirm in the order the answer made them, so every card checks and sends itself
 * exactly as it would alone, and stops at the first one that is not saved.
 */
import type { AssistantProposal } from '@erp/contracts'
import { CheckCheck } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useProposals } from './context'

interface Run {
  saved: number
  total: number
  /** The title of the change it stopped at, when it did not get through them all. */
  stoppedAt?: string
}

function runText(run: Run): string {
  if (!run.stoppedAt) return run.saved === 1 ? 'Saved the change.' : `Saved all ${run.saved} changes.`
  const done = run.saved === 0 ? 'Nothing was saved.' : `Saved ${run.saved} of ${run.total}.`
  return `${done} Stopped at “${run.stoppedAt}”: check that card, then confirm it or the rest again.`
}

export function ConfirmAllBar({ proposals: made }: { proposals: readonly AssistantProposal[] }) {
  const proposals = useProposals()
  const [running, setRunning] = useState(false)
  const [run, setRun] = useState<Run | null>(null)

  const open = made.filter((proposal) => (proposals.live(proposal.id)?.proposal ?? proposal).status === 'open')
  if (open.length < 2 && !run) return null

  const confirmAll = async () => {
    setRunning(true)
    setRun(null)
    const total = open.length
    let saved = 0
    try {
      for (const proposal of open) {
        const handle = proposals.handle(proposal.id)
        const result = handle ? await handle() : 'blocked'
        if (result !== 'done') {
          setRun({ saved, total, stoppedAt: proposal.title })
          return
        }
        saved += 1
      }
      setRun({ saved, total })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border bg-card px-3.5 py-2">
      {open.length >= 2 && (
        <Button size="sm" disabled={running} onClick={() => void confirmAll()}>
          <CheckCheck />
          Confirm all ({open.length})
        </Button>
      )}
      <p className="min-w-0 flex-1 text-[12.5px] text-muted-foreground" role="status">
        {running ? 'Saving the changes one by one…' : run ? runText(run) : 'Each change is saved in turn. It stops at the first one that is not saved.'}
      </p>
    </div>
  )
}
