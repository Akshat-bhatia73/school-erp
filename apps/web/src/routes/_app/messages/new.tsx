/** Write a message: audience, words, files, send now or later. */
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/messages/new')({ component: Page })

function Page() {
  return null
}
