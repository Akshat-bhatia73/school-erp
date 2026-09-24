import type { DeliveryAdapter, DeliveryMessage } from './types.ts'

/**
 * Keeps messages in memory so tests can read them. Nothing leaves the process,
 * so callers must never tell a user the message was really sent.
 */
export function createSandboxDelivery(
  log: (line: string) => void = console.info,
): DeliveryAdapter {
  const outbox: DeliveryMessage[] = []
  return {
    mode: 'sandbox',
    outbox,
    async send(message) {
      outbox.push({ ...message, sentAt: new Date().toISOString() })
      log(
        `[SANDBOX DELIVERY] nothing was sent: channel=${message.channel} purpose=${message.purpose} recipientLength=${message.to.length}`,
      )
    },
    async sendMessage(message) {
      outbox.push({
        channel: 'email',
        to: message.to,
        purpose: 'message',
        secret: '',
        subject: message.subject,
        sentAt: new Date().toISOString(),
      })
      log(`[SANDBOX DELIVERY] nothing was sent: channel=email purpose=message attachments=${message.attachments.length}`)
    },
  }
}
