import type { AssistantStatus } from '@erp/contracts'
import type { ReactNode } from 'react'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '@/lib/http'
import { renderWithSession } from '@/test/session'
import { AssistantScreen } from './assistant-screen'
import { UNAVAILABLE_TEXT } from './format'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => <a href={to} className={className}>{children}</a>,
  }
})

const status = vi.fn()
const threads = vi.fn()
const thread = vi.fn()
const createThread = vi.fn()
const deleteThread = vi.fn()
const proposals = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    assistant: {
      status: (...args: unknown[]) => status(...args),
      threads: (...args: unknown[]) => threads(...args),
      thread: (...args: unknown[]) => thread(...args),
      createThread: (...args: unknown[]) => createThread(...args),
      deleteThread: (...args: unknown[]) => deleteThread(...args),
      proposals: (...args: unknown[]) => proposals(...args),
      turnPath: (schoolId: string, threadId: string) => `/api/schools/${schoolId}/assistant/threads/${threadId}/turns`,
    },
  },
}))

const SCHOOL = '10000000-0000-4000-8000-000000000001'
const ACCESS = { roleKeys: ['teacher'], capabilities: ['ai_assistant.use' as const] }

const AVAILABLE: AssistantStatus = {
  available: true,
  questionsLeftToday: 42,
  suggestions: ['Who is absent in my class today?', 'Which pupils have fee dues?'],
}

/** A UI message stream as the turn route sends it. */
function streamResponse(chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } })
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  status.mockResolvedValue(AVAILABLE)
  threads.mockResolvedValue({ items: [] })
  proposals.mockResolvedValue({ items: [] })
})

const EMPTY_THREAD = { id: 'th-1', title: 'Fees', createdAt: '2026-09-25T04:00:00.000Z', lastMessageAt: '2026-09-25T04:00:00.000Z', messages: [] }

function textAnswer(text: string): Response {
  return streamResponse([
    { type: 'start', messageId: 'a1' },
    { type: 'start-step' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish-step' },
    { type: 'finish' },
  ])
}

afterEach(() => vi.unstubAllGlobals())

describe('when the assistant cannot be used', () => {
  it.each(['service_off', 'school_off', 'no_consent', 'restricted'] as const)('says why in plain words (%s)', async (reason) => {
    status.mockResolvedValue({ available: false, reason, questionsLeftToday: 0, suggestions: [] })
    renderWithSession(<AssistantScreen onOpenThread={() => {}} />, ACCESS)
    expect(await screen.findByText(UNAVAILABLE_TEXT[reason])).toBeInTheDocument()
    expect(screen.queryByLabelText('Your question')).not.toBeInTheDocument()
    expect(threads).not.toHaveBeenCalled()
  })

  it('tells a restricted person to ask the office when the status route refuses', async () => {
    status.mockRejectedValue(new ApiRequestError({ code: 'ACCESS_DENIED', status: 403, message: 'Access denied.' }))
    renderWithSession(<AssistantScreen onOpenThread={() => {}} />, ACCESS)
    expect(await screen.findByText('The assistant has been switched off for you. Ask the school office if you need it.')).toBeInTheDocument()
  })

  it('still opens an old conversation when today\'s questions are used up, without a composer', async () => {
    status.mockResolvedValue({ available: false, reason: 'daily_limit', questionsLeftToday: 0, suggestions: [] })
    thread.mockResolvedValue({
      id: 'th-1', title: 'Absences in 9 A', createdAt: '2026-09-25T04:00:00.000Z', lastMessageAt: '2026-09-25T04:00:00.000Z',
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Who was absent?' }], createdAt: '2026-09-25T04:00:00.000Z' },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Nobody was absent.' }], createdAt: '2026-09-25T04:00:01.000Z' },
      ],
    })
    renderWithSession(<AssistantScreen threadId="th-1" onOpenThread={() => {}} />, ACCESS)
    expect(await screen.findByText('Nobody was absent.')).toBeInTheDocument()
    expect(screen.getByText(UNAVAILABLE_TEXT.daily_limit)).toBeInTheDocument()
    expect(screen.queryByLabelText('Your question')).not.toBeInTheDocument()
  })
})

describe('a new conversation', () => {
  it('starts from a suggestion, keeps the first question across the new chat and draws the answer', async () => {
    createThread.mockResolvedValue({ id: 'th-new' })
    fetchMock.mockResolvedValue(streamResponse([
      { type: 'start', messageId: 'a1' },
      { type: 'start-step' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'section_attendance_day', input: { sectionId: 's1', date: '2026-09-25' } },
      {
        type: 'tool-output-available', toolCallId: 'c1', output: {
          status: 'ok',
          card: { kind: 'table', title: 'Absent in 9 A', columns: [{ key: 'name', label: 'Pupil' }], rows: [{ cells: { name: { type: 'text', value: 'Riya Sharma' } } }] },
          source: { label: 'Attendance, 9 A, 25 Sep', href: '/attendance' },
          forModel: { absent: ['Riya Sharma'] },
        },
      },
      { type: 'finish-step' },
      { type: 'start-step' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'One pupil was **absent** in 9 A today.' },
      { type: 'text-end', id: 't1' },
      { type: 'finish-step' },
      { type: 'finish' },
    ]))
    const onOpenThread = vi.fn()
    const view = renderWithSession(<AssistantScreen onOpenThread={onOpenThread} />, ACCESS)

    expect(await screen.findByText('Ask anything about your school')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Who is absent in my class today?' }))
    await waitFor(() => expect(onOpenThread).toHaveBeenCalledWith('th-new'))
    expect(createThread).toHaveBeenCalledWith(SCHOOL)

    // The route puts the new id in the address; the chat for it must still send the first question.
    view.rerender(<AssistantScreen threadId="th-new" onOpenThread={onOpenThread} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`/api/schools/${SCHOOL}/assistant/threads/th-new/turns`)
    expect(init.credentials).toBe('same-origin')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['messageId', 'text'])
    expect(body.text).toBe('Who is absent in my class today?')

    expect(await screen.findByText('absent')).toBeInTheDocument()
    expect(screen.getByText('Who is absent in my class today?')).toBeInTheDocument()
    expect(screen.getByText('Absent in 9 A')).toBeInTheDocument()
    expect(screen.getByText('Attendance, 9 A, 25 Sep').closest('a')).toHaveAttribute('href', '/attendance')
    expect(screen.queryByText(/forModel|absent":/)).not.toBeInTheDocument()
    expect(thread).not.toHaveBeenCalled()
  })

  it('shows a refused turn in plain words with Try again', async () => {
    thread.mockResolvedValue({ id: 'th-1', title: 'Fees', createdAt: '2026-09-25T04:00:00.000Z', lastMessageAt: '2026-09-25T04:00:00.000Z', messages: [] })
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Slow down.', requestId: 'r1', retryAfterSeconds: 30 } }), { status: 429, headers: { 'content-type': 'application/json' } }))
    renderWithSession(<AssistantScreen threadId="th-1" onOpenThread={() => {}} />, ACCESS)

    const box = await screen.findByLabelText('Your question')
    await userEvent.type(box, 'Which pupils have fee dues?{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many tries. Try again in 30 seconds.')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

describe('the history popover', () => {
  it('groups past conversations and deletes one after asking', async () => {
    const now = Date.now()
    threads.mockResolvedValue({
      items: [
        { id: 'th-1', title: 'Absences in 9 A', createdAt: new Date(now - 21 * 60_000).toISOString(), lastMessageAt: new Date(now - 21 * 60_000).toISOString() },
        { id: 'th-2', title: 'Fee dues for Class 7', createdAt: new Date(now - 20 * 86_400_000).toISOString(), lastMessageAt: new Date(now - 20 * 86_400_000).toISOString() },
      ],
    })
    thread.mockResolvedValue({ id: 'th-1', title: 'Absences in 9 A', createdAt: new Date(now).toISOString(), lastMessageAt: new Date(now).toISOString(), messages: [] })
    deleteThread.mockResolvedValue(undefined)
    const onOpenThread = vi.fn()
    renderWithSession(<AssistantScreen threadId="th-1" onOpenThread={onOpenThread} />, ACCESS)

    await userEvent.click(await screen.findByRole('button', { name: /Absences in 9 A/ }))
    expect(await screen.findByText('Chat history')).toBeInTheDocument()
    expect(screen.getByText('Older')).toBeInTheDocument()
    expect(screen.getByText('21m')).toBeInTheDocument()
    expect(screen.getByText('2w')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Delete Absences in 9 A' }))
    expect(await screen.findByText('Delete this conversation?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Delete conversation' }))
    await waitFor(() => expect(deleteThread).toHaveBeenCalledWith(SCHOOL, 'th-1'))
    // The open conversation was the one deleted, so the screen goes back to a new one.
    await waitFor(() => expect(onOpenThread).toHaveBeenCalledWith(undefined))
  })
})

describe('what a screen reader hears', () => {
  it('says once that the answer is ready, in one status region, and labels who said what', async () => {
    thread.mockResolvedValue(EMPTY_THREAD)
    fetchMock.mockResolvedValue(textAnswer('Nine pupils have fee dues.'))
    renderWithSession(<AssistantScreen threadId="th-1" onOpenThread={() => {}} />, ACCESS)

    const log = await screen.findByRole('log', { name: 'Conversation' })
    expect(log).toHaveAttribute('aria-live', 'off')
    await userEvent.type(screen.getByLabelText('Your question'), 'Which pupils have fee dues?{Enter}')
    expect(await screen.findByText('Nine pupils have fee dues.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Answer ready.')).toHaveAttribute('role', 'status'))
    expect(screen.getByText('You said:')).toHaveClass('sr-only')
    expect(screen.getByText('Assistant:')).toHaveClass('sr-only')
  })

  it('says a change is ready to check when the answer proposes one', async () => {
    thread.mockResolvedValue(EMPTY_THREAD)
    const proposal = {
      id: 'p-1', kind: 'attendance_day', title: 'Mark 9 A for 26 Sep 2026', status: 'open', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      preview: { kind: 'attendance_day', mode: 'first_entry', sectionId: 'sec-9a', sectionName: '9 A', date: '2026-09-26', rows: [{ studentId: 'st-1', name: 'Riya Sharma', rollNumber: 1, current: null, proposed: 'absent' }] },
    }
    fetchMock.mockResolvedValue(streamResponse([
      { type: 'start', messageId: 'a1' },
      { type: 'start-step' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'propose_attendance_day', input: {} },
      { type: 'tool-output-available', toolCallId: 'c1', output: { status: 'ok', proposal } },
      { type: 'finish-step' },
      { type: 'start-step' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Check the register below.' },
      { type: 'text-end', id: 't1' },
      { type: 'finish-step' },
      { type: 'finish' },
    ]))
    renderWithSession(<AssistantScreen threadId="th-1" onOpenThread={() => {}} />, ACCESS)
    await userEvent.type(await screen.findByLabelText('Your question'), 'Mark Riya absent{Enter}')
    expect(await screen.findByText('A change is ready to check.')).toBeInTheDocument()
    // Made in this session, so it may be confirmed at once.
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
  })
})

describe('the history list when it cannot be loaded', () => {
  it('says so, apart from having none, and tries again', async () => {
    threads.mockRejectedValueOnce(new ApiRequestError({ code: 'NETWORK_ERROR', status: 0, message: 'No connection.' }))
    threads.mockResolvedValueOnce({ items: [{ id: 'th-9', title: 'Absences in 9 A', createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString() }] })
    renderWithSession(<AssistantScreen onOpenThread={() => {}} />, ACCESS)
    await userEvent.click(await screen.findByRole('button', { name: /New chat/ }))
    expect(await screen.findByText('Could not load your conversations.')).toBeInTheDocument()
    expect(screen.queryByText('Your conversations of the last 30 days show here.')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Absences in 9 A')).toBeInTheDocument()
    expect(screen.queryByText('Could not load your conversations.')).not.toBeInTheDocument()
  })
})

describe('an unsent question', () => {
  it('is still there after leaving and coming back, and gone once sent', async () => {
    thread.mockResolvedValue(EMPTY_THREAD)
    fetchMock.mockResolvedValue(textAnswer('Nobody.'))
    const first = renderWithSession(<AssistantScreen threadId="th-1" onOpenThread={() => {}} />, ACCESS)
    await userEvent.type(await screen.findByLabelText('Your question'), 'Who has fee dues in Class 7')
    first.unmount()

    renderWithSession(<AssistantScreen threadId="th-1" onOpenThread={() => {}} />, ACCESS)
    const box = await screen.findByLabelText('Your question')
    expect(box).toHaveValue('Who has fee dues in Class 7')
    await userEvent.type(box, '?{Enter}')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(box).toHaveValue('')
    expect(window.sessionStorage.getItem(`erp:assistant:draft:${SCHOOL}:th-1`)).toBeNull()
  })

  it('on a new chat is kept apart from any conversation', async () => {
    const first = renderWithSession(<AssistantScreen onOpenThread={() => {}} />, ACCESS)
    await userEvent.type(await screen.findByLabelText('Your question'), 'Fee dues')
    first.unmount()
    renderWithSession(<AssistantScreen onOpenThread={() => {}} />, ACCESS)
    expect(await screen.findByLabelText('Your question')).toHaveValue('Fee dues')
  })
})
