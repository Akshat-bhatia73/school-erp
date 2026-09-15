import type { ApiConfig } from '../config.ts'
import { createSandboxDelivery } from './sandbox.ts'
import type { DeliveryAdapter } from './types.ts'

export type { DeliveryAdapter, DeliveryMessage } from './types.ts'
export { createSandboxDelivery } from './sandbox.ts'

export function createDelivery(config: ApiConfig): DeliveryAdapter {
  if (config.DELIVERY_MODE === 'sandbox') return createSandboxDelivery()
  // loadConfig already rejects this; keep the failure explicit here too.
  throw new Error('No delivery provider is configured.')
}
