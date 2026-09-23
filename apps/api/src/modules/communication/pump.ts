import type { DispatchDependencies } from './common.ts'

/** Stub: built by the dispatch agent. */
export function kickMessagePump(_deps: DispatchDependencies, _schoolId: string): void {}

/** Stub: built by the dispatch agent. */
export async function runMessagePump(
  _deps: DispatchDependencies,
  _schoolId: string,
  _requestId: string,
): Promise<Record<string, number>> {
  throw new Error('runMessagePump is not built yet')
}
