import type { AssistantStatus, AssistantUnavailableReason } from '@erp/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UIMessage } from 'ai'
import { MessageSquareOff, Sparkles } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { describeError, isApiError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { Composer } from './composer'
import { Conversation } from './conversation'
import { UNAVAILABLE_TEXT } from './format'
import { HistoryPopover } from './history-popover'

/** Out of questions: old conversations can still be read, only asking waits. */
const LIMITS: ReadonlySet<AssistantUnavailableReason> = new Set(['daily_limit', 'monthly_limit'])

/**
 * The assistant: one conversation on the whole screen, past ones in the history popover at the
 * top left. A new conversation shows the composer in the middle; the first question creates the
 * conversation and is sent as soon as its chat exists.
 */
export function AssistantScreen({ threadId, onOpenThread }: {
  threadId?: string
  /** Open a conversation (or a new one without an id). Replaces history, so Back leaves the screen. */
  onOpenThread: (threadId?: string) => void
}) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()

  const status = useQuery({ queryKey: qk.assistant.status(schoolId), queryFn: () => api.assistant.status(schoolId) })
  const reason = status.data && !status.data.available ? status.data.reason ?? 'service_off' : undefined
  const limited = reason !== undefined && LIMITS.has(reason)
  const canBrowse = !!status.data && (status.data.available || limited)

  const threads = useQuery({
    queryKey: qk.assistant.threads(schoolId),
    queryFn: () => api.assistant.threads(schoolId),
    enabled: canBrowse,
  })

  // A conversation created on this screen: nothing to load yet, and its first question to send.
  // Choosing any conversation from the history forgets it, so coming back loads what was kept.
  const [fresh, setFresh] = useState<{ threadId: string; question?: string } | null>(null)
  const isFresh = !!threadId && fresh?.threadId === threadId
  const open = (id?: string) => {
    setFresh(null)
    onOpenThread(id)
  }

  const thread = useQuery({
    queryKey: qk.assistant.thread(schoolId, threadId ?? ''),
    queryFn: () => api.assistant.thread(schoolId, threadId!),
    enabled: canBrowse && !!threadId && !isFresh,
  })
  const initialMessages = useMemo<UIMessage[]>(
    () => (thread.data?.messages ?? []).map((m) => ({ id: m.id, role: m.role, parts: m.parts as UIMessage['parts'] })),
    [thread.data],
  )

  const start = useMutation({
    mutationFn: (_question: string) => api.assistant.createThread(schoolId),
    onSuccess: ({ id }, question) => {
      setFresh({ threadId: id, question })
      onOpenThread(id)
      void queryClient.invalidateQueries({ queryKey: qk.assistant.threads(schoolId) })
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const title = threadId
    ? threads.data?.items.find((t) => t.id === threadId)?.title ?? thread.data?.title ?? 'New chat'
    : 'New chat'

  const lockedNotice = limited && reason
    ? <p className="rounded-xl border bg-muted/40 px-3.5 py-3 text-[13px] text-muted-foreground">{UNAVAILABLE_TEXT[reason]}</p>
    : undefined

  let body: ReactNode
  if (status.isPending) {
    body = <CentredSkeleton />
  } else if (status.isError) {
    body = isApiError(status.error, 'ACCESS_DENIED')
      ? <Unavailable text={UNAVAILABLE_TEXT.restricted} />
      : <EmptyState icon={<MessageSquareOff />} title="The assistant could not be reached." description={describeError(status.error)} action={<Button variant="outline" onClick={() => void status.refetch()}>Try again</Button>} className="flex-1" />
  } else if (!canBrowse && reason) {
    body = <Unavailable text={UNAVAILABLE_TEXT[reason]} />
  } else if (!threadId) {
    body = limited && reason
      ? <Unavailable text={UNAVAILABLE_TEXT[reason]} />
      : <NewConversation status={status.data} starting={start.isPending} onStart={(question) => start.mutate(question)} />
  } else if (isFresh || thread.data) {
    body = (
      <Conversation
        key={threadId}
        threadId={threadId}
        initialMessages={isFresh ? [] : initialMessages}
        firstQuestion={isFresh ? fresh?.question : undefined}
        onFirstQuestionSent={() => setFresh({ threadId })}
        locked={lockedNotice}
      />
    )
  } else if (thread.isError) {
    body = isApiError(thread.error, 'RESOURCE_NOT_FOUND')
      ? <EmptyState icon={<MessageSquareOff />} title="This conversation is no longer here." description="Conversations are kept for 30 days, and a deleted one is gone." action={<Button variant="outline" onClick={() => open(undefined)}>New chat</Button>} className="flex-1" />
      : <EmptyState icon={<MessageSquareOff />} title="This conversation could not be opened." description={describeError(thread.error)} action={<Button variant="outline" onClick={() => void thread.refetch()}>Try again</Button>} className="flex-1" />
  } else {
    body = <CentredSkeleton />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-card">
      <div className="flex h-12 shrink-0 items-center border-b px-2 md:h-14 md:px-3">
        {canBrowse ? (
          <HistoryPopover title={title} threads={threads.data?.items ?? []} loading={threads.isPending} currentId={threadId} onOpen={open} />
        ) : (
          <span className="flex items-center gap-1.5 px-2.5 text-[14px] font-medium">
            <Sparkles className="size-4 text-muted-foreground" />
            Assistant
          </span>
        )}
      </div>
      {body}
    </div>
  )
}

function Unavailable({ text }: { text: string }) {
  return <EmptyState icon={<Sparkles />} title="The assistant is not available" description={text} className="flex-1" />
}

function CentredSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col justify-center gap-3 px-4">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-[92px] w-full rounded-xl" />
    </div>
  )
}

/** A new conversation: the composer in the middle, with a few questions to start from. */
function NewConversation({ status, starting, onStart }: { status: AssistantStatus; starting: boolean; onStart: (question: string) => void }) {
  const [draft, setDraft] = useState('')
  const send = (text: string) => { if (!starting) onStart(text) }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col justify-center px-4 pt-8 pb-[12vh] md:px-6">
        <div className="mb-5 flex flex-col items-center gap-2 text-center">
          <span className="flex size-10 items-center justify-center rounded-xl border bg-muted/50 text-muted-foreground"><Sparkles className="size-5" /></span>
          <h1 className="text-[18px] font-semibold">Ask anything about your school</h1>
          <p className="max-w-md text-[13px] text-muted-foreground">Answers come from the school's records you can already see.</p>
        </div>
        <Composer value={draft} onChange={setDraft} onSend={send} autoFocus />
        {status.suggestions.length > 0 && (
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {status.suggestions.map((suggestion) => (
              <Button key={suggestion} variant="outline" size="sm" disabled={starting} onClick={() => send(suggestion)} className="h-auto min-h-7 rounded-full py-1 font-normal whitespace-normal text-muted-foreground hover:text-foreground">
                {suggestion}
              </Button>
            ))}
          </div>
        )}
        {status.questionsLeftToday <= 5 && (
          <p className="mt-3 text-center text-[12px] text-muted-foreground">
            {status.questionsLeftToday} {status.questionsLeftToday === 1 ? 'question' : 'questions'} left today
          </p>
        )}
      </div>
    </div>
  )
}
