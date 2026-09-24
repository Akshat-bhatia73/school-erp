/** Change a draft or a scheduled message. */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Mail } from 'lucide-react'
import { MessageForm } from '@/components/messages/message-form'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

export const Route = createFileRoute('/_app/messages/$messageId/edit')({ component: Page })

function Page() {
  const { messageId } = Route.useParams()
  const { schoolId } = useSchoolContext()
  const messageQuery = useQuery({ queryKey: qk.messages.detail(schoolId, messageId), queryFn: () => api.messages.get(schoolId, messageId) })
  const message = messageQuery.data
  const editable = message && (message.status === 'draft' || message.status === 'scheduled')

  return (
    <>
      <PageHeader crumbs={[{ label: 'Messages', to: '/messages', icon: <Mail /> }, { label: message?.status === 'draft' ? 'Draft' : 'Change message' }]} />
      {messageQuery.isError ? (
        <EmptyState icon={<Mail />} title="This message is not available" description={describeError(messageQuery.error)} />
      ) : !message ? (
        <div className="space-y-3 p-3 md:p-4"><Skeleton className="h-40 w-full" /><Skeleton className="h-64 w-full" /></div>
      ) : !editable ? (
        <EmptyState
          icon={<Mail />}
          title="This message can no longer be changed"
          description="Only a draft or a scheduled message can be changed."
          action={<Button asChild size="sm" variant="outline"><Link to="/messages/$messageId" params={{ messageId }}>Open the message</Link></Button>}
        />
      ) : (
        // The key starts the form again from the saved record when another message opens here.
        <MessageForm key={message.id} message={message} />
      )}
    </>
  )
}
