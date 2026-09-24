export type DeliveryChannel = 'email' | 'sms'

export interface DeliveryMessage {
  readonly channel: DeliveryChannel
  readonly to: string
  readonly purpose:
    | 'otp'
    | 'password_reset'
    | 'verification'
    | 'invitation'
    | 'message'
    | 'student_password'
  /**
   * The OTP, token, link or a pupil's generated password. Never log or return
   * this to a browser. Empty for a school message.
   */
  readonly secret: string
  /**
   * A pupil's password text (Task 23) names the school code and the admission
   * number the pupil types with the password. Neither is secret; the text is.
   */
  readonly studentLogin?: { readonly schoolCode: string; readonly admissionNumber: string }
  /** A school message's subject, kept only by the sandbox so a developer can see what went. */
  readonly subject?: string
  readonly sentAt: string
}

/** A file that travels with a school message. */
export interface OutgoingAttachment {
  readonly fileName: string
  readonly contentType: string
  readonly bytes: Uint8Array
}

/**
 * One school message by email (Task 22). The words are the school's and are
 * about children: an adapter sends them and never logs them.
 */
export interface OutgoingMessage {
  readonly to: string
  /** Shown as the sender's name, such as the school's name. */
  readonly fromName: string
  readonly subject: string
  readonly text: string
  readonly attachments: readonly OutgoingAttachment[]
}

export interface DeliveryAdapter {
  readonly mode: 'sandbox' | 'provider'
  send(message: Omit<DeliveryMessage, 'sentAt' | 'subject'>): Promise<void>
  /** Throws when the message was not accepted, so a caller never records a false "sent". */
  sendMessage(message: OutgoingMessage): Promise<void>
  /** Test-only view of what was "delivered". Empty for real providers. */
  readonly outbox: readonly DeliveryMessage[]
}
