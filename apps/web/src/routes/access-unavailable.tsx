import { createFileRoute } from '@tanstack/react-router'
import { AccessUnavailable } from '@/components/auth/school/access-unavailable'
import { isAccessReason, type AccessReason } from '@/components/auth/school/access-error'

export const Route = createFileRoute('/access-unavailable')({
  validateSearch: (search: Record<string, unknown>): { reason?: AccessReason } => ({ reason: isAccessReason(search.reason) ? search.reason : undefined }),
  component: Page,
})

function Page() {
  const { reason } = Route.useSearch()
  return <AccessUnavailable reason={reason ?? 'forbidden'} />
}
