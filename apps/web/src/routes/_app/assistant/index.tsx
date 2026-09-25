/** The assistant: one conversation on the whole screen, past ones in the history popover. */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { AssistantScreen } from '@/components/assistant/assistant-screen'

const searchSchema = z.object({
  /** The open conversation; absent for a new one. A search param, so opening one never remounts the chat. */
  thread: z.string().min(1).max(128).optional().catch(undefined),
})

export const Route = createFileRoute('/_app/assistant/')({
  validateSearch: searchSchema,
  component: Page,
})

function Page() {
  const { thread } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  // Replace, not push: moving between conversations is not a trail Back should walk through.
  return <AssistantScreen threadId={thread} onOpenThread={(id) => void navigate({ search: { thread: id }, replace: true })} />
}
