/**
 * Where the cards of one conversation meet. The conversation asks the server how each proposal
 * stands now (a reopened conversation shows what happened, not what was true when the answer was
 * written), each card keeps the answer its own Confirm or Discard got back, and each open card
 * lends its Confirm to "Confirm all" so one bar can run them in order.
 */
import type { AssistantProposal, AssistantProposalStatus } from '@erp/contracts'
import { useQuery } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '@/lib/api'
import { qk } from '@/lib/query'

/** A proposal as it stands, with the moment this screen saw it saved, when it did. */
export interface SettledProposal {
  proposal: AssistantProposal
  savedAt?: string
}

/** What one card's Confirm came to: the proposal's new status, or `blocked` when nothing was sent or it was refused. */
export type ConfirmResult = AssistantProposalStatus | 'blocked'

export type ConfirmHandle = () => Promise<ConfirmResult>

interface ProposalsValue {
  /** The latest known state of a proposal, or nothing when only the answer's own copy is known. */
  live: (id: string) => SettledProposal | undefined
  settle: (settled: SettledProposal) => void
  register: (id: string, handle: ConfirmHandle) => () => void
  handle: (id: string) => ConfirmHandle | undefined
}

const NONE: ProposalsValue = {
  live: () => undefined,
  settle: () => {},
  register: () => () => {},
  handle: () => undefined,
}

const ProposalsContext = createContext<ProposalsValue>(NONE)

export function useProposals(): ProposalsValue {
  return useContext(ProposalsContext)
}

export function ProposalsProvider({ schoolId, threadId, enabled, children }: {
  schoolId: string
  threadId: string
  /** Only a conversation that holds a change asks for the states. */
  enabled: boolean
  children: ReactNode
}) {
  const states = useQuery({
    queryKey: qk.assistant.proposals(schoolId, threadId),
    queryFn: () => api.assistant.proposals(schoolId, threadId),
    enabled,
    // A change being saved settles within seconds, or later from the server's
    // own records if the save was cut off; look again until it has.
    refetchInterval: (query) => (query.state.data?.items.some((item) => item.status === 'confirming') ? 15_000 : false),
  })
  const [settled, setSettled] = useState<Record<string, SettledProposal>>({})
  const handles = useRef(new Map<string, ConfirmHandle>())

  const fetched = useMemo(() => new Map((states.data?.items ?? []).map((item) => [item.id, item])), [states.data])

  const settle = useCallback((next: SettledProposal) => {
    setSettled((old) => ({ ...old, [next.proposal.id]: next }))
  }, [])

  const register = useCallback((id: string, handle: ConfirmHandle) => {
    handles.current.set(id, handle)
    return () => {
      if (handles.current.get(id) === handle) handles.current.delete(id)
    }
  }, [])

  const value = useMemo<ProposalsValue>(() => ({
    // What a card got back from its own Confirm or Discard is the newest word; the server's list
    // covers a reopened conversation and anything that expired while nobody looked.
    live: (id) => {
      const own = settled[id]
      if (own) return own
      const item = fetched.get(id)
      return item ? { proposal: item } : undefined
    },
    settle,
    register,
    handle: (id) => handles.current.get(id),
  }), [settled, fetched, settle, register])

  return <ProposalsContext.Provider value={value}>{children}</ProposalsContext.Provider>
}
