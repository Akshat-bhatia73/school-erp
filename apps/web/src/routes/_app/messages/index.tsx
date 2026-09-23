/** Messages: the inbox for everyone, and the messages the school and the caller sent. */
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/messages/')({ component: Page })

function Page() {
  return null
}
