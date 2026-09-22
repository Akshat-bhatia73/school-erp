/**
 * Reads every file the site would ship and refuses anything that belongs to a
 * developer machine: fixture people, sandbox outbox routes, database logins,
 * the signing secret, a local API address or the old mock store.
 *
 * Run it after pnpm build, which copies apps/web/dist to dist/.
 *
 *   pnpm build && pnpm check:assets
 *
 * Source maps are excluded as well: they carry the original source, including
 * comments. Set SOURCE_MAPS=true if a release deliberately ships them.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { checkDeployConfig } from './check-deploy-config.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')

/** Plain strings that must never appear in a shipped file. */
const FORBIDDEN_TEXT = [
  // Development credentials and seeds.
  'fixture-password',
  'sunrise-password',
  'AUTH_SECRET',
  // Database logins. The browser must never learn one.
  'erp_runtime',
  'erp_migrator',
  // The sandbox outbox hands out one-time codes in clear.
  '/api/dev/outbox',
  'DEV_SANDBOX_OUTBOX',
  // The Phase 1 mock role switcher is gone; its store imports are still refused
  // below. "Viewing as" is now the real dashboard view switcher in the account
  // menu, which only picks between homes the server says the roles earn, so
  // the phrase itself is no longer a sign of the mock.
  // A direct API address bypasses the same-origin /api rewrite.
  'localhost:3001',
  '127.0.0.1:3001',
  // Fixture school names from packages/db/scripts/fixtures.mjs.
  'Fixture A',
  'Fixture B',
  'fixture-a',
  'fixture-b',
]

/**
 * A base32 secret of the shape apps/api/scripts/totp-secret.ts decodes: 32
 * characters of A-Z and 2-7. Built asset names are lowercase hex, so this does
 * not match them. Any 32-character uppercase token has the same shape, so a
 * minified constant can match by accident: set SKIP_TOTP_SCAN=true to turn the
 * scan off, or list accepted values in ALLOW_TOTP_SHAPED (comma separated).
 */
const TOTP_SECRET = /\b[A-Z2-7]{32}\b/
const SKIP_TOTP_SCAN = process.env.SKIP_TOTP_SCAN === 'true'
const ALLOWED_TOTP_SHAPED = new Set(
  (process.env.ALLOW_TOTP_SHAPED ?? '').split(',').map((v) => v.trim()).filter(Boolean),
)
/** Only a script or a page can carry a secret worth reading; CSS and fonts cannot. */
const TOTP_SCANNED = new Set(['.js', '.mjs', '.cjs', '.html'])

/** The mock API modules that must not be imported by a shipped bundle. */
const MOCK_IMPORT = /(from|import)\s*\(?\s*['"][^'"]*\/api\/(seed|store)[^'"]*['"]/

const TEXT_LIKE = new Set([
  '.js', '.mjs', '.cjs', '.css', '.html', '.json', '.svg', '.txt', '.webmanifest', '.map',
])

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else files.push(full)
  }
  return files
}

function findingsFor(file, contents) {
  const findings = []
  for (const needle of FORBIDDEN_TEXT)
    if (contents.includes(needle)) findings.push(`contains "${needle}"`)
  if (!SKIP_TOTP_SCAN && TOTP_SCANNED.has(path.extname(file))) {
    const totp = TOTP_SECRET.exec(contents)
    if (totp && !ALLOWED_TOTP_SHAPED.has(totp[0]))
      findings.push(
        `contains something shaped like a TOTP secret ("${totp[0]}"). If it is not one, ` +
          'add it to ALLOW_TOTP_SHAPED.',
      )
  }
  if (MOCK_IMPORT.test(contents)) findings.push('imports the mock api/seed or api/store module')
  return findings
}

function main() {
  const problems = []

  if (!existsSync(distDir)) {
    console.error('dist/ does not exist. Run pnpm build first.')
    process.exit(1)
  }
  if (!existsSync(path.join(distDir, 'index.html')))
    problems.push('dist/index.html is missing: the build did not produce a site.')

  const files = walk(distDir)
  const shipSourceMaps = process.env.SOURCE_MAPS === 'true'
  let scanned = 0

  for (const file of files) {
    const relative = path.relative(root, file)
    const extension = path.extname(file).toLowerCase()
    if (extension === '.map' && !shipSourceMaps) {
      problems.push(`${relative} is a source map. Do not ship it, or set SOURCE_MAPS=true.`)
      continue
    }
    if (!TEXT_LIKE.has(extension)) continue
    scanned += 1
    const contents = readFileSync(file, 'utf8')
    for (const finding of findingsFor(file, contents))
      problems.push(`${relative} ${finding}`)
  }

  problems.push(...checkDeployConfig())

  if (problems.length > 0) {
    console.error(`Production asset check failed (${problems.length} problem(s)):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }

  console.log(
    `Production assets OK: ${scanned} file(s) scanned in dist/, no development or test material, /api rewrite in place.`,
  )
}

main()
