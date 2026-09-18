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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Identifiers are opaque in the contract but uuid in storage. Checking the
 * shape here keeps a malformed identifier a plain not-found instead of a
 * database error the boundary would have to answer with 503.
 */
export function assertUuidParam(value: string): string {
  if (!UUID.test(value)) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return value
}
