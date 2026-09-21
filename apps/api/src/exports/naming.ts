/**
 * The name a file is delivered under. It is built from server state, never
 * from a request, and it is reduced to plain ASCII words: a file name travels
 * through a response header and a dozen operating systems, and the record it
 * describes is already named inside the file itself.
 */
export function exportFileName(parts: readonly string[], extension: string): string {
  const slug = parts
    .map((part) =>
      part
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .filter((part) => part !== '')
    .join('-')
    .slice(0, 80)
  return `${slug === '' ? 'export' : slug}.${extension}`
}

/** Today as YYYY-MM-DD, the part of a file name that sorts. */
export function fileNameDate(now: string): string {
  const date = new Date(now)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}
