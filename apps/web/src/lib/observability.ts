import * as Sentry from '@sentry/react'

/**
 * Error reporting for the shipped site. A report carries the error, its stack and the page
 * path. It never carries what was typed, clicked or fetched: breadcrumbs are dropped, and the
 * address loses its query string because a reset or invitation link keeps its token there.
 */
export function initObservability() {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined
  if (!dsn || !import.meta.env.PROD) return
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    // The default set records clicks, requests and console output as breadcrumbs.
    integrations: (defaults) => defaults.filter((integration) => integration.name !== 'Breadcrumbs'),
    beforeBreadcrumb: () => null,
    beforeSend(event) {
      if (event.request?.url) event.request = { url: event.request.url.split('?')[0] }
      delete event.user
      return event
    },
  })
}

/** A no-op until `initObservability` has run with a DSN. */
export function reportError(error: unknown) {
  Sentry.captureException(error)
}
