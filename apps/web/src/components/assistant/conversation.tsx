import { useChat } from '@ai-sdk/react'
import { ApiError } from '@erp/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { describeError } from '@/lib/api-errors'
import { api } from '@/lib/api'
import { ApiRequestError } from '@/lib/http'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { Composer } from './composer'
import { turnBody } from './format'
import { Message } from './message'
import { ActivityLine } from './tool-activity'

/**
 * The turn route answers a refusal with the usual ApiError envelope, not a stream. Turning it into
 * an ApiRequestError here lets the screen say it in the same words as everywhere else.
 */
const turnFetch: typeof fetch = async (input, init) => {
  let response: Response
  try {
    response = await fetch(input, init)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiRequestError({ code: 'NETWORK_ERROR', status: 0, message: 'We could not reach the server. Check your connection and try again.' })
  }
  if (response.ok) return response
  let payload: unknown
  try { payload = await response.json() } catch { payload = undefined }
  const envelope = ApiError.safeParse(payload)
  if (!envelope.success) throw new ApiRequestError({ code: 'UNEXPECTED_RESPONSE', status: response.status, message: 'The server sent an answer we did not understand.' })
  const { code, message, requestId, reason, retryAfterSeconds } = envelope.data.error
  throw new ApiRequestError({ code, status: response.status, message, requestId, reason, retryAfterSeconds })
}

/** How far from the bottom still counts as "at the bottom". */
const STICK_PX = 80

/**
 * One open conversation. Mounted once per thread id with its kept messages, because the chat
 * reads its first messages only when it is created. `firstQuestion` is the question that started
 * a brand new conversation: it is sent once the chat for this id exists, so it is never lost.
 */
export function Conversation({ threadId, initialMessages, firstQuestion, onFirstQuestionSent, locked }: {
  threadId: string
  initialMessages: UIMessage[]
  firstQuestion?: string
  onFirstQuestionSent?: () => void
  /** Reading is fine but asking is not (today's or this month's questions are used up). */
  locked?: ReactNode
}) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')

  const transport = useMemo(() => new DefaultChatTransport({
    api: api.assistant.turnPath(schoolId, threadId),
    credentials: 'same-origin',
    fetch: turnFetch,
    prepareSendMessagesRequest: ({ messages }) => ({ body: turnBody(messages) }),
  }), [schoolId, threadId])

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.assistant.threads(schoolId) })
    void queryClient.invalidateQueries({ queryKey: qk.assistant.status(schoolId) })
    void queryClient.invalidateQueries({ queryKey: qk.assistant.thread(schoolId, threadId) })
  }

  const { messages, sendMessage, regenerate, stop, status, error, clearError } = useChat({
    id: threadId,
    messages: initialMessages,
    transport,
    onFinish: refresh,
    // A refused turn may mean the limit was reached: the status says so on the next look.
    onError: refresh,
  })
  const busy = status === 'submitted' || status === 'streaming'

  // Stick to the bottom while an answer streams, unless the person scrolled up to read.
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages, status])

  // The first question of a new conversation. Deferred a tick so a development double mount
  // (which stops the chat on its first unmount) cannot swallow it.
  const firstRef = useRef(firstQuestion)
  const sentRef = useRef(onFirstQuestionSent)
  useEffect(() => { sentRef.current = onFirstQuestionSent }, [onFirstQuestionSent])
  useEffect(() => {
    const text = firstRef.current
    if (!text) return
    const timer = setTimeout(() => {
      firstRef.current = undefined
      sentRef.current?.()
      void sendMessage({ text })
    }, 0)
    return () => clearTimeout(timer)
  }, [sendMessage])

  const ask = (text: string) => {
    stick.current = true
    clearError()
    setDraft('')
    void sendMessage({ text })
  }

  const last = messages[messages.length - 1]
  const waiting = status === 'submitted' && last?.role === 'user'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
        }}
        className="min-h-0 flex-1 overflow-y-auto scrollbar-thin"
      >
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 pt-6 pb-8 md:px-6">
          {messages.map((message) => <Message key={message.id} message={message} />)}
          {waiting && <ActivityLine label="Thinking…" />}
          {error && !busy && (
            <p className="text-[13px] text-muted-foreground" role="alert">
              {describeError(error)}{' '}
              <button type="button" onClick={() => { stick.current = true; void regenerate() }} className="font-medium text-foreground underline-offset-4 hover:underline">
                Try again
              </button>
            </p>
          )}
        </div>
      </div>
      <div className="shrink-0 pb-4">
        <div className="mx-auto w-full max-w-[760px] px-4 md:px-6">
          {locked ?? (
            <Composer value={draft} onChange={setDraft} onSend={ask} onStop={() => void stop()} busy={busy} autoFocus={!firstQuestion} />
          )}
        </div>
      </div>
    </div>
  )
}
