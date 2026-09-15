import net from 'node:net'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { seedFixtures } from '@erp/db/fixtures'
import { loadConfig, type ApiConfig } from '../src/config.ts'
import { createPools, type ApiPools } from '../src/db.ts'
import { createSandboxDelivery } from '../src/delivery/index.ts'
import type { DeliveryAdapter } from '../src/delivery/index.ts'
import { createAuth, type AuthInstance } from '../src/auth/better-auth.ts'
import { buildApp } from '../src/app.ts'

export const MIGRATOR_URL =
  'postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp'
export const DB_URLS = {
  AUTH_DATABASE_URL: 'postgres://erp_auth:erp_auth@127.0.0.1:54329/erp',
  IDENTITY_DATABASE_URL:
    'postgres://erp_identity:erp_identity@127.0.0.1:54329/erp',
  DATABASE_URL: 'postgres://erp_runtime:erp_runtime@127.0.0.1:54329/erp',
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

export async function startTestServer(
  overrides: Record<string, string> = {},
): Promise<TestServer> {
  const port = await freePort()
  const config = loadConfig(testEnv(port, overrides))
  const pools = await createPools(config)
  const delivery = createSandboxDelivery(() => {})
  const auth = createAuth(config, pools.auth, delivery, pools.identity)
  const app = buildApp({ config, auth, delivery, pools })
  await app.listen({ port: config.PORT, host: '127.0.0.1' })
  const origin = `http://127.0.0.1:${config.PORT}`
  const jar = new CookieJar()
  return {
    config,
    auth,
    delivery,
    pools,
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
