import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { ApiFailure } from '../http/errors.ts'
import type { DispatchDependencies } from '../modules/communication/common.ts'
import { runMessagePump } from '../modules/communication/pump.ts'

/** A run stops starting new schools after this long, so the function finishes inside its limit. */
const PUMP_BUDGET_MS = 45_000

/** Compare two secrets in constant time, lengths included (as maintenance/routes.ts does). */
function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * The daily message run (Task 22): the message pump for every school in turn,
 * so birthdays and fee reminders go out on a day nobody signs in. Registered
 * only when CRON_SECRET is configured. The answer and the log line carry
 * counts only.
 */
export function registerMessageMaintenanceRoutes(app: FastifyInstance, deps: DispatchDependencies): void {
  const secret = deps.config.CRON_SECRET
  if (secret === undefined) return

  app.get('/api/maintenance/messages', async (request) => {
    const header = request.headers.authorization
    if (!header || !secretsMatch(header, `Bearer ${secret}`)) throw new ApiFailure('AUTHENTICATION_REQUIRED')

    const started = Date.now()
    const schools = await deps.pools.runtime.query<{ school_id: string }>(
      'SELECT school_id FROM list_message_schools()',
    )
    const pumped: Record<string, number> = { schools: 0, schools_failed: 0, schools_left: 0 }
    for (const [index, school] of schools.rows.entries()) {
      if (Date.now() - started > PUMP_BUDGET_MS) {
        // The rest wait for the next trigger, and the count says so.
        pumped.schools_left = schools.rows.length - index
        break
      }
      try {
        const counts = await runMessagePump(deps, school.school_id, request.id)
        for (const [key, value] of Object.entries(counts)) pumped[key] = (pumped[key] ?? 0) + value
        pumped.schools = (pumped.schools ?? 0) + 1
      } catch {
        // One school's trouble is not every school's: it is counted and the
        // next school runs.
        pumped.schools_failed = (pumped.schools_failed ?? 0) + 1
      }
    }
    request.log.info({ pumped }, 'message pump complete')
    return { pumped }
  })
}
