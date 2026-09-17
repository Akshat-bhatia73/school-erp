/**
 * Shared plumbing for the protected school API client.
 *
 * Every call names its school in the path, because the server takes the school from the URL and
 * decides access against it. Nothing here makes a decision; it only builds a request and hands the
 * contract schema to `request()` so a drifted response fails as UNEXPECTED_RESPONSE instead of
 * reaching a screen as a wrong-shaped object.
 */

/** A query value a route may actually receive. Undefined keys are left out entirely. */
export type QueryValue = string | number | boolean | undefined

/** `/api/schools/:schoolId<suffix>`, with the school id encoded. */
export function schoolPath(schoolId: string, suffix = ''): string {
  return `/api/schools/${encodeURIComponent(schoolId)}${suffix}`
}

/** One path segment, encoded. Never interpolate an id without this. */
export function seg(value: string): string {
  return encodeURIComponent(value)
}

/** `?a=1&b=2`, or '' when nothing is set. Undefined values are dropped. */
export function queryString(params: Record<string, QueryValue> = {}): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

/** A path plus its query string. */
export function withQuery(path: string, params?: Record<string, QueryValue>): string {
  return `${path}${queryString(params)}`
}
