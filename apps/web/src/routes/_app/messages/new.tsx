/** Write a message: audience, words, files, send now or later. */
import { createFileRoute } from '@tanstack/react-router'
import { Mail } from 'lucide-react'
import { MessageForm } from '@/components/messages/message-form'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { useSchoolContext } from '@/lib/session'

export const Route = createFileRoute('/_app/messages/new')({ component: Page })

function Page() {
  const { hasPermission } = useSchoolContext()
  return (
    <>
      <PageHeader crumbs={[{ label: 'Messages', to: '/messages', icon: <Mail /> }, { label: 'New message' }]} />
      {hasPermission('communication.send')
        ? <MessageForm />
        : <EmptyState icon={<Mail />} title="You cannot send messages" description="Ask the school office if you need to send one." />}
    </>
  )
}
