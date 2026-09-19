import * as Sentry from '@sentry/node'
import type { ApiConfig } from './config.ts'

/**
 * Error reporting. A report carries the error, its stack, the route and our
 * own request id and error code. It never carries a body, a cookie, a header,
 * a query string or an address: a school's records stay in the school's
 * database, not in a third party's issue tracker.
 */
export function initObservability(config: ApiConfig): void {
  if (!config.SENTRY_DSN) return
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    sendDefaultPii: false,
    // Errors only. Traces would record every record id in every URL.
    tracesSampleRate: 0,
    beforeBreadcrumb: () => null,
    beforeSend(event) {
      if (event.request) {
        event.request = {
          method: event.request.method,
          url: event.request.url?.split('?')[0],
        }
      }
      delete event.user
      delete event.server_name
      return event
    },
  })
}

/** An error the API did not expect. Refusals are counted, not reported here. */
export function reportError(error: unknown, context: { requestId: string; route?: string }): void {
  Sentry.captureException(error, {
    tags: { requestId: context.requestId, route: context.route },
  })
}

/**
 * A refused request. Grouped by code alone, so an alert on "ACCESS_DENIED more
 * than 20 times in 5 minutes" is one issue's event frequency.
 */
export function reportDenial(
  code: string,
  context: { requestId: string; route?: string; membershipId?: string },
): void {
  Sentry.captureMessage(`request refused: ${code}`, {
    level: 'warning',
    fingerprint: ['request-refused', code],
    tags: {
      code,
      requestId: context.requestId,
      route: context.route,
      membershipId: context.membershipId,
    },
  })
}

export interface DenialBurst {
  readonly schoolId: string
  readonly membershipId: string
  readonly count: number
}

/** One event per membership per burst, so an alert names who to look at. */
function sendDenialBurst(burst: DenialBurst): void {
  Sentry.captureMessage('denial burst', {
    level: 'error',
    fingerprint: ['denial-burst', burst.membershipId],
    // Ids only: what they tried to read is in the school's own audit trail.
    tags: {
      schoolId: burst.schoolId,
      membershipId: burst.membershipId,
      count: String(burst.count),
    },
  })
}

let denialBurstReporter: (burst: DenialBurst) => void = sendDenialBurst

/**
 * Many refusals from one membership in ten minutes. Tests replace the reporter
 * so the burst can be observed without a Sentry project.
 */
export function reportDenialBurst(burst: DenialBurst): void {
  denialBurstReporter(burst)
}

/** Returns the reporter that was in place, so a test can put it back. */
export function setDenialBurstReporter(
  reporter: (burst: DenialBurst) => void,
): (burst: DenialBurst) => void {
  const previous = denialBurstReporter
  denialBurstReporter = reporter
  return previous
}

export async function flushObservability(): Promise<void> {
  await Sentry.flush(2000)
}
