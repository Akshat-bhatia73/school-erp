/** One pupil's results and report cards for a year. */
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/exams/students/$studentId')({ component: Page })

function Page() {
  return null
}
