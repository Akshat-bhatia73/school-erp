/**
 * Checks the hosting configuration the release depends on.
 *
 * The browser talks to one origin: the Vercel site. Everything under /api is
 * rewritten to the backend, so the session cookie stays same-origin. That
 * rewrite must exist and must come before the single-page catch-all, or every
 * API call would be answered with index.html.
 *
 * The repository ships a placeholder destination because vercel.json cannot
 * read environment variables. Replacing it is the first item of the release
 * checklist. Set ALLOW_PLACEHOLDER_API_ORIGIN=true to accept the placeholder
 * (CI does, because the repository has no domain yet).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PLACEHOLDER_API_ORIGIN = 'REPLACE-WITH-YOUR-DOMAIN'

export function checkDeployConfig({
  file = path.join(root, 'vercel.json'),
  allowPlaceholder = process.env.ALLOW_PLACEHOLDER_API_ORIGIN === 'true',
} = {}) {
  const problems = []
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return [`${path.relative(root, file)} is missing.`]
  }

  let config
  try {
    config = JSON.parse(raw)
  } catch (error) {
    return [`vercel.json is not valid JSON: ${error.message}`]
  }

  const rewrites = Array.isArray(config.rewrites) ? config.rewrites : []
  const apiIndex = rewrites.findIndex((rule) =>
    String(rule?.source ?? '').startsWith('/api'),
  )
  const catchAllIndex = rewrites.findIndex(
    (rule) => String(rule?.source ?? '') === '/(.*)',
  )

  if (apiIndex === -1)
    problems.push(
      'vercel.json has no /api rewrite, so API calls would be answered with the single-page app.',
    )
  else if (catchAllIndex !== -1 && apiIndex > catchAllIndex)
    problems.push(
      'the /api rewrite comes after the single-page catch-all in vercel.json; move it first.',
    )

  const destination = String(rewrites[apiIndex]?.destination ?? '')
  if (apiIndex !== -1 && !destination.startsWith('https://'))
    problems.push(
      `the /api rewrite must point at an https backend origin (got "${destination}").`,
    )

  if (raw.includes(PLACEHOLDER_API_ORIGIN) && !allowPlaceholder)
    problems.push(
      `vercel.json still contains ${PLACEHOLDER_API_ORIGIN}. Replace it with the real API host, or set ALLOW_PLACEHOLDER_API_ORIGIN=true when there is no domain yet.`,
    )

  return problems
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = checkDeployConfig()
  if (problems.length > 0) {
    console.error('Deployment configuration check failed:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(
    'Deployment configuration OK: /api is rewritten before the SPA catch-all.',
  )
}
