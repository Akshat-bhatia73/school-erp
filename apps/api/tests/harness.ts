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
 * The disposable database name. Parallel test runs (one per module while the
 * suites are being written) each point at their own migrated copy so fixture
 * rewrites in one run cannot break sign-in in another.
 */
const DB_NAME = process.env.ERP_TEST_DB ?? 'erp'
export const MIGRATOR_URL = `postgres://erp_migrator:erp_migrator@127.0.0.1:54329/${DB_NAME}`
export const DB_URLS = {
  AUTH_DATABASE_URL: `postgres://erp_auth:erp_auth@127.0.0.1:54329/${DB_NAME}`,
  IDENTITY_DATABASE_URL: `postgres://erp_identity:erp_identity@127.0.0.1:54329/${DB_NAME}`,
  DATABASE_URL: `postgres://erp_runtime:erp_runtime@127.0.0.1:54329/${DB_NAME}`,
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
