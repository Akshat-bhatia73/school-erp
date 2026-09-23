/** One published report card. */
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/exams/report-cards/$versionId')({ component: Page })

function Page() {
  return null
}
