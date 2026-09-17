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
export function reportDenial(code: string, context: { requestId: string; route?: string }): void {
  Sentry.captureMessage(`request refused: ${code}`, {
    level: 'warning',
    fingerprint: ['request-refused', code],
    tags: { code, requestId: context.requestId, route: context.route },
  })
}

export async function flushObservability(): Promise<void> {
  await Sentry.flush(2000)
}
