import type { Pool } from 'pg'
import type { ApiConfig } from '../config.ts'
import { createProviderDelivery } from './resend.ts'
import { createSandboxDelivery } from './sandbox.ts'
import type { DeliveryAdapter } from './types.ts'

export type { DeliveryAdapter, DeliveryMessage } from './types.ts'
export { createSandboxDelivery } from './sandbox.ts'
export { createProviderDelivery } from './resend.ts'

/** `authPool` is only used to hold text messages in a test build. */
export function createDelivery(config: ApiConfig, authPool: Pool): DeliveryAdapter {
  if (config.DELIVERY_MODE === 'sandbox') return createSandboxDelivery()
  // loadConfig already requires both; keep the failure explicit here too.
  if (!config.RESEND_API_KEY || !config.EMAIL_FROM)
    throw new Error('No delivery provider is configured.')
  return createProviderDelivery({
    apiKey: config.RESEND_API_KEY,
    from: config.EMAIL_FROM,
    appOrigin: config.APP_ORIGIN,
    heldSms: config.HELD_SMS_TOKEN ? authPool : undefined,
  })
}
