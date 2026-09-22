import { createFileRoute } from '@tanstack/react-router'

/** Stub: this screen is built by the attendance workflow. */
export const Route = createFileRoute('/_app/attendance/students/$studentId')({ component: Page })

function Page() {
  return null
}
