/** Change a draft or a scheduled message. */
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/messages/$messageId/edit')({ component: Page })

function Page() {
  return null
}
