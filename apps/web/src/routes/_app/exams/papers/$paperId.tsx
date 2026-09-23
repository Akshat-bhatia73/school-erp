/** One marks sheet: roster down, components across, saved in one write. */
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/exams/papers/$paperId')({ component: Page })

function Page() {
  return null
}
