/**
 * The fixture the eval runs against: a disposable database, migrated by
 * `pnpm db:test:prepare`, holding the Sunrise school the dev seed builds.
 * Never the development database `erp`.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export const EVALS_DIR = import.meta.dirname
const API_DIR = path.resolve(EVALS_DIR, '..')
/** Seed output (logins with working passwords and TOTP secrets). Gitignored. */
export const WORK_DIR = path.join(EVALS_DIR, '.work')
const LOGINS_FILE = path.join(WORK_DIR, 'logins.csv')

/**
 * Fixed values for the fixture only. The seed seals second-factor secrets
 * with AUTH_SECRET, so the seed and the app must share it.
 */
const EVAL_AUTH_SECRET = 'eval-only-secret-for-the-assistant-evaluation-set'
const EVAL_DATA_KEY = Buffer.from('eval-only-data-encryption-key-00').toString('base64')
export const EVAL_ORIGIN = 'http://127.0.0.1:3999'

export interface FixtureUrls {
  readonly migrator: string
  readonly runtime: string
  readonly auth: string
  readonly identity: string
  readonly name: string
}

/** The login URLs from the migrator URL, the way the API tests build them (tests/harness.ts). */
export function fixtureUrls(migratorUrl: string | undefined): FixtureUrls {
  if (!migratorUrl) {
    throw new Error(
      'Set EVAL_DATABASE_URL to a disposable database prepared for the eval, for example\n' +
        '  postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp_evals\n' +
        'See docs/assistant/EVALS.md for the commands that create it.',
    )
  }
  const parsed = new URL(migratorUrl)
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  if (name === 'erp' || name === '') throw new Error('The eval refuses to run against "erp", the development database. Use a disposable one.')
  const as = (login: string) => {
    const url = new URL(parsed.toString())
    url.username = login
    url.password = login
    return url.toString()
  }
  return { migrator: parsed.toString(), runtime: as('erp_runtime'), auth: as('erp_auth'), identity: as('erp_identity'), name }
}

/**
 * The environment the seed and the app share. Everything that points at a
 * database or sends a message is set here, so values loaded from apps/api/.env
 * (the development database) can never leak in.
 */
export function fixtureEnv(urls: FixtureUrls, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: urls.runtime,
    AUTH_DATABASE_URL: urls.auth,
    IDENTITY_DATABASE_URL: urls.identity,
    MIGRATION_DATABASE_URL: urls.migrator,
    DEV_MIGRATOR_DATABASE_URL: urls.migrator,
    AUTH_SECRET: EVAL_AUTH_SECRET,
    DATA_ENCRYPTION_KEY: EVAL_DATA_KEY,
    APP_ORIGIN: EVAL_ORIGIN,
    API_TRUST_PROXY: 'false',
    DELIVERY_MODE: 'sandbox',
    DEV_SANDBOX_OUTBOX: 'false',
    DOCUMENT_STORAGE: 'local',
    DOCUMENT_STORAGE_DIR: path.join(WORK_DIR, 'documents'),
    SENTRY_DSN: undefined,
    NODE_ENV: 'development',
    SEED_PASSWORD: undefined,
    SEED_PUPIL_PASSWORD: undefined,
    // Relative to apps/api/.dev, where the seed writes; lands in evals/.work.
    SEED_LOGINS_FILE: path.relative(path.join(API_DIR, '.dev'), LOGINS_FILE),
    ...extra,
  }
}

/** Build the Sunrise school afresh with the dev seed, in its own process, as `pnpm dev:seed` does. */
export async function runDevSeed(urls: FixtureUrls): Promise<void> {
  await mkdir(WORK_DIR, { recursive: true, mode: 0o700 })
  const tsx = path.join(API_DIR, 'node_modules', '.bin', 'tsx')
  const result = spawnSync(tsx, [path.join(API_DIR, 'scripts', 'dev-seed.ts')], {
    cwd: API_DIR,
    env: fixtureEnv(urls),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`The dev seed failed:\n${(result.stderr || result.stdout).slice(-2000)}`)
  }
}

export interface SeededLogin {
  readonly name: string
  readonly email: string
  readonly phone: string
  readonly password: string
  readonly totpSecret: string
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"') quoted = true
    else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += char
  }
  if (cell !== '' || row.length > 0) rows.push([...row, cell])
  return rows
}

/** The logins the seed wrote for this fixture, by email (or admission number for a pupil). */
export async function seededLogins(): Promise<Map<string, SeededLogin>> {
  let text: string
  try {
    text = await readFile(LOGINS_FILE, 'utf8')
  } catch {
    throw new Error(`No seeded logins at ${LOGINS_FILE}. Run the eval without --no-seed once to build the fixture.`)
  }
  const [header, ...rows] = parseCsv(text)
  const at = (name: string) => header!.indexOf(name)
  const map = new Map<string, SeededLogin>()
  for (const row of rows) {
    const login = {
      name: row[at('name')] ?? '',
      email: row[at('email')] ?? '',
      phone: row[at('phone')] ?? '',
      password: row[at('password')] ?? '',
      totpSecret: row[at('totp_secret')] ?? '',
    }
    map.set(login.email, login)
  }
  return map
}
