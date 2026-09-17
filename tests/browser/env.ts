/**
 * The one place that knows where this suite's API, web app and database live.
 *
 * Everything is on its own port and its own database, so a browser run never
 * meets the development pair on 3001/5173 or the development database `erp`.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

export const API_PORT = Number(process.env.BROWSER_API_PORT ?? 3101)
export const WEB_PORT = Number(process.env.BROWSER_WEB_PORT ?? 5174)

export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`
/** The only origin the API accepts, so every test must open exactly this. */
export const APP_ORIGIN = `http://localhost:${WEB_PORT}`

export const DB_NAME = process.env.BROWSER_DB_NAME ?? 'erp_browser'
const HOST = process.env.BROWSER_DB_HOST ?? '127.0.0.1:54329'

const urlFor = (login: string) =>
  `postgres://${login}:${login}@${HOST}/${DB_NAME}`

export const MIGRATOR_URL = urlFor('erp_migrator')

/**
 * The same shape as apps/api/tests/harness.ts `testEnv()`, pointed at this
 * suite's database and port. The sandbox outbox is on so a test can read a
 * one-time code; it is refused outright when NODE_ENV is production.
 */
export const apiEnv: Record<string, string> = {
  AUTH_DATABASE_URL: urlFor('erp_auth'),
  IDENTITY_DATABASE_URL: urlFor('erp_identity'),
  DATABASE_URL: urlFor('erp_runtime'),
  AUTH_SECRET: 'browser-test-secret-value-for-local-authentication-only',
  APP_ORIGIN,
  API_TRUST_PROXY: 'false',
  DELIVERY_MODE: 'sandbox',
  DEV_SANDBOX_OUTBOX: 'true',
  DOCUMENT_STORAGE_DIR: path.join(ROOT, 'tests/browser/.documents'),
  PORT: String(API_PORT),
  NODE_ENV: 'test',
}
