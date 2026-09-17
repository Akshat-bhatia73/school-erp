import type { Pool } from 'pg'
import { holdSms } from './held-sms.ts'
import type { DeliveryAdapter, DeliveryMessage } from './types.ts'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const SEND_TIMEOUT_MS = 10_000

export interface ProviderDeliveryOptions {
  readonly apiKey: string
  readonly from: string
  /** The site address; links in a message point here and nowhere else. */
  readonly appOrigin: string
  /** Present only when a test build holds text messages. See held-sms.ts. */
  readonly heldSms?: Pool
  readonly fetch?: typeof fetch
}

interface Email {
  readonly subject: string
  readonly text: string
}

function link(appOrigin: string, path: string, token: string): string {
  const url = new URL(path, appOrigin)
  url.searchParams.set('token', token)
  return url.toString()
}

function compose(
  message: Omit<DeliveryMessage, 'sentAt'>,
  appOrigin: string,
): Email {
  switch (message.purpose) {
    case 'invitation':
      return {
        subject: 'You have been invited to your school',
        text: `You have been invited to join your school's account.\n\nOpen this link to accept. It works once and stops working after 48 hours.\n\n${link(appOrigin, '/accept-invite', message.secret)}\n\nIf you were not expecting this, ignore this email.`,
      }
    case 'password_reset':
      return {
        subject: 'Reset your password',
        text: `Open this link to choose a new password. It works once and stops working after 15 minutes.\n\n${link(appOrigin, '/reset-password', message.secret)}\n\nIf you did not ask for this, ignore this email. Your password has not changed.`,
      }
    case 'verification': {
      const url = new URL(link(appOrigin, '/api/auth/verify-email', message.secret))
      url.searchParams.set('callbackURL', '/')
      return {
        subject: 'Confirm your email address',
        text: `Open this link to confirm your email address.\n\n${url.toString()}`,
      }
    }
    case 'otp':
      return {
        subject: 'Your sign-in code',
        text: `Your sign-in code is ${message.secret}. It stops working after a few minutes. Never share it.`,
      }
  }
}

/**
 * Email goes through Resend. A text message has no provider yet: it is held
 * for a tester when the build is configured for that, and fails otherwise, so
 * a caller is never told "sent" about a message nobody will receive.
 *
 * Nothing here logs: the body is a credential and the address is personal.
 */
export function createProviderDelivery(
  options: ProviderDeliveryOptions,
): DeliveryAdapter {
  const send = options.fetch ?? fetch
  return {
    mode: 'provider',
    outbox: [],
    async send(message) {
      if (message.channel === 'sms') {
        if (!options.heldSms) throw new Error('No SMS provider is configured.')
        await holdSms(options.heldSms, message)
        return
      }
      const email = compose(message, options.appOrigin)
      const response = await send(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: `School ERP <${options.from}>`,
          to: [message.to],
          subject: email.subject,
          text: email.text,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      // The provider's words stay out of the error: they can echo the address.
      if (!response.ok)
        throw new Error(`Email provider refused the message (${response.status}).`)
    },
  }
}
