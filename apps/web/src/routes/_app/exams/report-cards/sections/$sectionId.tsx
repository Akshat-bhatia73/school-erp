/** One section: co-scholastic grades and remarks, and its cards. */
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/exams/report-cards/sections/$sectionId')({ component: Page })

function Page() {
  return null
}
