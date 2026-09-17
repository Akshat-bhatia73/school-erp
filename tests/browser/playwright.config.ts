import { defineConfig, devices } from '@playwright/test'
import { API_ORIGIN, APP_ORIGIN, ROOT, WEB_PORT, apiEnv } from './env.ts'

/**
 * Browser tests for session transitions: sign out, school switch, suspension
 * and tampering. They run against the real API and the real Vite dev server,
 * on their own ports and their own database, so nothing here can touch the
 * development pair or the development data.
 *
 * The database must already be migrated:
 *   TEST_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp_browser pnpm db:test:prepare
 *
 * Fixtures are seeded by global-setup.ts on every run.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  // One worker: the suite suspends a membership and switches schools, which
  // are school-wide facts. Parallel workers would watch each other's writes.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: APP_ORIGIN,
    trace: 'on-first-retry',
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'chromium' }],
  webServer: [
    {
      command: 'tests/browser/node_modules/.bin/tsx apps/api/src/server.ts',
      cwd: ROOT,
      url: `${API_ORIGIN}/api/health`,
      env: apiEnv,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @erp/web dev',
      cwd: ROOT,
      url: APP_ORIGIN,
      env: {
        WEB_PORT: String(WEB_PORT),
        API_PROXY_TARGET: API_ORIGIN,
      },
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000,
    },
  ],
})
