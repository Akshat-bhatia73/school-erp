/**
 * Runs once before the suite. It migrates nothing — the database is prepared
 * by `pnpm db:test:prepare` — and only seeds the people and records the tests
 * sign in as.
 *
 * The seed runs as a separate tsx process because it uses the API's own
 * configuration, pools and authentication instance to hash a password, and
 * those must not be loaded into the Playwright runner.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { APP_ORIGIN, MIGRATOR_URL, ROOT, apiEnv } from './env.ts'

export default function globalSetup(): void {
  const tsx = path.join(ROOT, 'tests/browser/node_modules/.bin/tsx')

  execFileSync(tsx, [path.join(ROOT, 'tests/browser/setup/seed.ts')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...apiEnv, BROWSER_MIGRATOR_URL: MIGRATOR_URL, APP_ORIGIN },
  })
}
