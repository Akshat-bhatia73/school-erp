/** One exam across the school: which sections are complete, locked and published. */
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/exams/$examId')({ component: Page })

function Page() {
  return null
}
