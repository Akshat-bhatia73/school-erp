/** One message: the words and files, and for its sender or the office the delivery record. */
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/messages/$messageId/')({ component: Page })

function Page() {
  return null
}
