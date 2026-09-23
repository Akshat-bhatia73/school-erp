import type { TenantConnection } from '../shared/index.ts'
import type { DispatchDependencies } from './common.ts'

/** Stub: built by the dispatch agent. */
export async function materialiseMessage(
  _conn: TenantConnection,
  _deps: DispatchDependencies,
  _schoolId: string,
  _messageId: string,
): Promise<{ recipients: number; delivered: number }> {
  throw new Error('materialiseMessage is not built yet')
}
