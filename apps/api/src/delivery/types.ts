export type DeliveryChannel = 'email' | 'sms'

export interface DeliveryMessage {
  readonly channel: DeliveryChannel
  readonly to: string
  readonly purpose: 'otp' | 'password_reset' | 'verification'
  /** The OTP, token or link. Never log or return this to a browser. */
  readonly secret: string
  readonly sentAt: string
}

export interface DeliveryAdapter {
  readonly mode: 'sandbox' | 'provider'
  send(message: Omit<DeliveryMessage, 'sentAt'>): Promise<void>
  /** Test-only view of what was "delivered". Empty for real providers. */
  readonly outbox: readonly DeliveryMessage[]
}
