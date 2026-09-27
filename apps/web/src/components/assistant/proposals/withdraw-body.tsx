/**
 * Taking back a sent message, inside a change card: which message, who it went to, when, and how
 * many it reached. The reason the route needs is asked under this, as a correction's is.
 */
import type { MessageWithdrawPreview } from '@erp/contracts'
import { formatDateTime } from '@/components/messages/labels'
import { Facts } from '@/components/shared/page'

export function WithdrawBody({ preview }: { preview: MessageWithdrawPreview }) {
  return (
    <div className="px-3.5 py-3">
      <Facts
        items={[
          { label: 'Message', value: preview.title },
          { label: 'Sent to', value: preview.audienceLabel },
          { label: 'Sent', value: formatDateTime(preview.sentAt) },
        ]}
      />
      <p className="mt-3 text-[13px] text-muted-foreground">Reached {preview.recipients} {preview.recipients === 1 ? 'person' : 'people'}.</p>
    </div>
  )
}
