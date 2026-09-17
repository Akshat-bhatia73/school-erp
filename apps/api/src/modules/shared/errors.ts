import type { AuthorizationDecision } from '@erp/contracts/server'
import { ApiFailure } from '../../http/errors.ts'

export { ApiFailure }

/**
 * Turns a denial into the failure the boundary already knows how to render.
 * The code is whatever the evaluator returned, so a record in another school
 * still answers RESOURCE_NOT_FOUND and never ACCESS_DENIED.
 */
export function assertAllowed(decision: AuthorizationDecision): void {
  if (!decision.allowed) throw new ApiFailure(decision.code)
}

/** The same for a row a scoped read did not return: it is simply not there. */
export function requireFound<T>(row: T | null | undefined): T {
  if (row === null || row === undefined) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return row
}
