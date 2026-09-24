import type { Pool } from 'pg'
import { holdSms } from './held-sms.ts'
import type { DeliveryAdapter, DeliveryMessage } from './types.ts'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const SEND_TIMEOUT_MS = 10_000
/** A school message may carry files, so it gets longer. */
const MESSAGE_TIMEOUT_MS = 20_000

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

/**
 * The text a pupil's primary guardian receives (Task 23). It carries the
 * password, so it is composed only at the moment of sending and never logged.
 */
export function studentPasswordText(
  message: Pick<DeliveryMessage, 'secret' | 'studentLogin'>,
): string {
  const login = message.studentLogin
  if (!login) throw new Error('A student password text needs the school code and admission number.')
  return `${login.schoolCode}: sign-in for admission no. ${login.admissionNumber}. Password: ${message.secret}. Choose a new one at first sign-in.`
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
    case 'student_password':
      return {
        subject: 'Your sign-in details',
        text: studentPasswordText(message),
      }
    case 'message':
      // A school message has its own words and goes through sendMessage.
      throw new Error('A school message is sent with sendMessage.')
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
    async sendMessage(message) {
      // The display name is the school's; quotes and angle brackets would
      // break the header, so they are taken out.
      const fromName = message.fromName.replace(/["<>\\\r\n]/g, '').trim() || 'School ERP'
      const response = await send(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: `${fromName} <${options.from}>`,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.attachments.length === 0
            ? {}
            : {
                attachments: message.attachments.map((file) => ({
                  filename: file.fileName,
                  content: Buffer.from(file.bytes).toString('base64'),
                  content_type: file.contentType,
                })),
              }),
        }),
        signal: AbortSignal.timeout(MESSAGE_TIMEOUT_MS),
      })
      // The provider's words stay out of the error: they can echo the address.
      if (!response.ok)
        throw new Error(`Email provider refused the message (${response.status}).`)
    },
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
