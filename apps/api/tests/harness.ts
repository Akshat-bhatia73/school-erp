import net from 'node:net'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { seedFixtures } from '@erp/db/fixtures'
import { loadConfig, type ApiConfig } from '../src/config.ts'
import { createPools, type ApiPools } from '../src/db.ts'
import { createSandboxDelivery } from '../src/delivery/index.ts'
import type { DeliveryAdapter } from '../src/delivery/index.ts'
import { createAuthorizationService } from '@erp/authz'
import { createAuth, type AuthInstance } from '../src/auth/better-auth.ts'
import {
  createMemoryDocumentStorage,
  type MemoryDocumentStorage,
} from '../src/files/storage.ts'
import { buildApp } from '../src/app.ts'
import type { ModuleDependencies } from '../src/modules/shared/route.ts'

/**
 * Every pool in the tests points at the database named by TEST_DATABASE_URL,
 * which must be a disposable copy: the suite seeds fixtures and rewrites rows.
 * ERP_TEST_DB is a convenience that swaps only the database name, so one module
 * can be run against a private migrated copy without a second URL.
 */
const migratorUrl = process.env.TEST_DATABASE_URL
if (!migratorUrl)
  throw new Error(
    'TEST_DATABASE_URL must name a disposable PostgreSQL database (for example ' +
      'postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp_test). ' +
      'Create it with: pnpm db:test:prepare',
  )

const parsed = new URL(migratorUrl)
if (process.env.ERP_TEST_DB) parsed.pathname = `/${process.env.ERP_TEST_DB}`
const DB_NAME = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
if (DB_NAME === 'erp')
  throw new Error(
    'The API tests refuse to run against "erp", the development database. ' +
      'Point TEST_DATABASE_URL at a disposable database such as erp_test ' +
      '(pnpm db:test:prepare), or set ERP_TEST_DB to a private copy.',
  )

/** Builds the same host and port with a different login and database. */
function urlFor(login: string): string {
  const url = new URL(parsed.toString())
  url.username = login
  url.password = login
  return url.toString()
}

export const MIGRATOR_URL = parsed.toString()
export const DB_URLS = {
  AUTH_DATABASE_URL: urlFor('erp_auth'),
  IDENTITY_DATABASE_URL: urlFor('erp_identity'),
  DATABASE_URL: urlFor('erp_runtime'),
}

export async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  )
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

export function testEnv(port: number, overrides: Record<string, string> = {}) {
  return {
    ...DB_URLS,
    AUTH_SECRET: 'test-secret-value-for-local-authentication-only',
    // Base64 of 32 bytes; a test value, not the example the production check refuses.
    DATA_ENCRYPTION_KEY: 'dGVzdC1vbmx5LWRhdGEtZW5jcnlwdGlvbi1rZXktMDA=',
    APP_ORIGIN: `http://127.0.0.1:${port}`,
    API_TRUST_PROXY: 'false',
    DELIVERY_MODE: 'sandbox',
    PORT: String(port),
    NODE_ENV: 'test',
    ...overrides,
  } as NodeJS.ProcessEnv
}

export interface TestServer {
  config: ApiConfig
  auth: AuthInstance
  delivery: DeliveryAdapter
  pools: ApiPools
  /** In-memory document bytes, so a test can put a file without a disk. */
  documents: MemoryDocumentStorage
  origin: string
  fetch(path: string, init?: RequestInit): Promise<Response>
  jar: CookieJar
  close(): Promise<void>
}

export class CookieJar {
  private readonly cookies = new Map<string, string>()
  readonly rawSetCookies: string[] = []

  capture(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      this.rawSetCookies.push(line)
      const [pair] = line.split(';')
      const index = pair?.indexOf('=') ?? -1
      if (!pair || index < 0) continue
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
  }

  header(): string | undefined {
    if (this.cookies.size === 0) return undefined
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
  }
}

/**
 * Extra routes a test may register before the server listens. It exists so a
 * test can exercise the shared route helper without any test-only route ever
 * existing in the running application.
 */
export type TestRouteExtension = (
  app: FastifyInstance,
  deps: ModuleDependencies,
) => void

export async function startTestServer(
  overrides: Record<string, string> = {},
  extend?: TestRouteExtension,
): Promise<TestServer> {
  const port = await freePort()
  const config = loadConfig(testEnv(port, overrides))
  const pools = await createPools(config)
  const delivery = createSandboxDelivery(() => {})
  const auth = createAuth(config, pools.auth, delivery, pools.identity)
  const documents = createMemoryDocumentStorage()
  const app = buildApp({ config, auth, delivery, pools, documents })
  if (extend) {
    extend(app, {
      config,
      auth,
      pools,
      delivery,
      documents,
      authz: createAuthorizationService({ pool: pools.runtime }),
    })
  }
  await app.listen({ port: config.PORT, host: '127.0.0.1' })
  const origin = `http://127.0.0.1:${config.PORT}`
  const jar = new CookieJar()
  return {
    config,
    auth,
    delivery,
    pools,
    documents,
    origin,
    jar,
    async fetch(path, init = {}) {
      const headers = new Headers(init.headers)
      const cookie = jar.header()
      if (cookie && !headers.has('cookie')) headers.set('cookie', cookie)
      if (!headers.has('origin')) headers.set('origin', origin)
      const response = await fetch(`${origin}${path}`, { ...init, headers })
      jar.capture(response)
      return response
    },
    async close() {
      await app.close()
      await pools.close()
      await closeRateLimitPool()
    },
  }
}

/** Seeds the shared packages/db fixtures using the migrator connection. */
export async function seedDatabaseFixtures(): Promise<void> {
  const pool = new pg.Pool({ connectionString: MIGRATOR_URL })
  try {
    await seedFixtures(pool)
  } finally {
    await pool.end()
  }
}

export function uniqueEmail(): string {
  return `api-test-${randomUUID()}@example.test`
}

/**
 * Give an existing fixture identity a password. There is no HTTP route for
 * this: provisioning stays server-side and tests must not invent one.
 */
export async function setFixturePassword(
  server: TestServer,
  userId: string,
  password: string,
): Promise<void> {
  const context = await server.auth.$context
  const hash = await context.password.hash(password)
  const existing = await context.internalAdapter.findCredentialAccount(userId)
  if (existing) {
    await context.internalAdapter.updatePassword(userId, hash)
    return
  }
  await context.internalAdapter.createAccount({
    userId,
    providerId: 'credential',
    accountId: userId,
    password: hash,
  })
}

let ratePool: pg.Pool | undefined

/**
 * Tests sign in far more often than a person would. The shared rate limit
 * store is real, so clear it instead of weakening the configuration.
 */
export async function resetRateLimits(): Promise<void> {
  ratePool ??= new pg.Pool({ connectionString: MIGRATOR_URL })
  await ratePool.query('DELETE FROM auth_rate_limit')
  await ratePool.query('DELETE FROM auth_throttle')
}

/** Clear only the provider's own table, leaving our durable budgets alone. */
export async function resetProviderRateLimits(): Promise<void> {
  ratePool ??= new pg.Pool({ connectionString: MIGRATOR_URL })
  await ratePool.query('DELETE FROM auth_rate_limit')
}

export async function closeRateLimitPool(): Promise<void> {
  await ratePool?.end()
  ratePool = undefined
}

/** An isolated cookie jar so two sessions can be held at once. */
/** Direct access to the throttle table so budgets can be seeded or read. */
export async function throttleQuery<T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  ratePool ??= new pg.Pool({ connectionString: MIGRATOR_URL })
  return ratePool.query<T>(sql, params)
}

export function clientFor(server: TestServer) {
  const jar = new CookieJar()
  return {
    jar,
    async fetch(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers)
      const cookie = jar.header()
      if (cookie) headers.set('cookie', cookie)
      if (!headers.has('origin')) headers.set('origin', server.origin)
      const response = await fetch(`${server.origin}${path}`, {
        ...init,
        headers,
      })
      jar.capture(response)
      return response
    },
    async signIn(email: string, password: string) {
      await resetRateLimits()
      const response = await this.fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      return response
    },
  }
}

let adminPoolInstance: pg.Pool | undefined

/** The migrator connection, for fixture setup only. Never used by the app. */
export function adminPool(): pg.Pool {
  adminPoolInstance ??= new pg.Pool({ connectionString: MIGRATOR_URL })
  return adminPoolInstance
}

/**
 * The bytes an export job produced. The storage key never leaves the API, so a
 * test reads it from the row with the migrator connection and then asks the
 * same in-memory store the server wrote to.
 */
export async function readExportFileBytes(
  server: TestServer,
  jobId: string,
): Promise<Uint8Array> {
  const found = await adminPool().query<{ storage_key: string | null }>(
    'SELECT storage_key FROM export_jobs WHERE id = $1',
    [jobId],
  )
  const key = found.rows[0]?.storage_key
  if (!key) throw new Error('the job holds no storage key')
  const file = await server.documents.read(key)
  if (!file) throw new Error('no bytes are stored under the job key')
  const chunks: Uint8Array[] = []
  for await (const chunk of file.stream as ReadableStream<Uint8Array>) chunks.push(chunk)
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
}

export async function closeAdminPool(): Promise<void> {
  await adminPoolInstance?.end()
  adminPoolInstance = undefined
}

type TestClient = ReturnType<typeof clientFor>

export async function signInWithPassword(
  server: TestServer,
  email: string,
  password: string,
): Promise<TestClient> {
  const client = clientFor(server)
  const response = await client.signIn(email, password)
  if (response.status !== 200) {
    throw new Error(`sign-in failed with status ${response.status}`)
  }
  return client
}

/** The provider's own TOTP generator, given the secret it just published. */
function secretFromTotpUri(totpURI: string): string {
  const secret = new URL(totpURI).searchParams.get('secret')
  if (!secret) throw new Error('the enrolment response carried no TOTP secret')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  let out = ''
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char)
    if (index < 0) continue
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out += String.fromCharCode((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return out
}

/**
 * A session that has actually completed the second factor, which is what an
 * owner, principal, admin or accountant needs to enter a school route. The
 * enrolment is always fresh, so a run after an earlier test still works.
 */
export async function signInWithMfa(
  server: TestServer,
  opts: { userId: string; email: string; password: string },
): Promise<TestClient> {
  const pool = adminPool()
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [
    opts.userId,
  ])
  await pool.query(
    'UPDATE auth_user SET two_factor_enabled = false WHERE id = $1',
    [opts.userId],
  )
  await setFixturePassword(server, opts.userId, opts.password)

  const client = await signInWithPassword(server, opts.email, opts.password)

  await resetRateLimits()
  const enable = await client.fetch('/api/auth/two-factor/enable', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: opts.password }),
  })
  if (enable.status !== 200) {
    throw new Error(`two-factor enrolment failed with status ${enable.status}`)
  }
  const body = (await enable.json()) as { totpURI: string }
  const secret = secretFromTotpUri(body.totpURI)

  await resetRateLimits()
  const generated = await server.auth.api.generateTOTP({ body: { secret } })
  const verify = await client.fetch('/api/auth/two-factor/verify-totp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: generated.code }),
  })
  if (verify.status !== 200) {
    throw new Error(`two-factor verification failed with status ${verify.status}`)
  }
  return client
}
