/** The assistant: one conversation on the whole screen, past ones in the history popover. */
import { createFileRoute } from '@tanstack/react-router'
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
  return <AssistantScreen threadId={thread} />
}
