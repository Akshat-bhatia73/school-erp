import { z } from 'zod'

/** Read once at startup. A missing or unsupported value must stop the process. */
const EnvSchema = z.object({
  AUTH_DATABASE_URL: z.string().min(1),
  IDENTITY_DATABASE_URL: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(32),
  APP_ORIGIN: z.url(),
  API_TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  DELIVERY_MODE: z.enum(['sandbox', 'provider']).default('sandbox'),
  /**
   * Sandbox delivery logs codes instead of sending them; never in real use.
   * Production refuses DELIVERY_MODE=sandbox unless this says true, so a
   * deployment cannot quietly hand out one-time codes to its own log.
   */
  ALLOW_SANDBOX_DELIVERY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * Development only. Publishes GET /api/dev/outbox, which hands out the
   * one-time codes and reset tokens the sandbox "delivered". Never true
   * anywhere but a developer machine.
   */
  DEV_SANDBOX_OUTBOX: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** Where private student documents live. Only server.ts reads it. */
  DOCUMENT_STORAGE_DIR: z.string().min(1).default('.documents'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3001),
  /**
   * The interface to listen on. Loopback by default so a developer machine
   * never exposes the API; the container sets 0.0.0.0 so the proxy in front
   * of it can reach it. Never publish that port to the internet.
   */
  HOST: z.string().min(1).default('127.0.0.1'),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
})

export type ApiConfig = Readonly<z.infer<typeof EnvSchema>>

export class ConfigurationError extends Error {}

/** The value shipped in apps/api/.env.example. It is public, so it is not a secret. */
const EXAMPLE_AUTH_SECRET = 'development-only-secret-change-me-0000000000'

/** Postgres login that owns the schema. The running API must never use it. */
const MIGRATOR_LOGIN = 'erp_migrator'

function loginOf(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).username)
  } catch {
    return undefined
  }
}

/**
 * Extra rules that only apply to a real deployment. Each one refuses a
 * configuration that would look like it works while leaving the school's data
 * or its one-time codes exposed.
 */
function assertProductionSafe(config: z.infer<typeof EnvSchema>): void {
  if (config.AUTH_SECRET === EXAMPLE_AUTH_SECRET)
    throw new ConfigurationError(
      'AUTH_SECRET is still the example value from apps/api/.env.example. Generate a new one: openssl rand -base64 32',
    )
  if (config.AUTH_SECRET.length < 32)
    throw new ConfigurationError(
      'AUTH_SECRET must be at least 32 characters in production.',
    )

  const origin = new URL(config.APP_ORIGIN)
  const isLocal = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1'
  if (origin.protocol !== 'https:' && !isLocal)
    throw new ConfigurationError(
      `APP_ORIGIN must be https in production (got ${origin.protocol}//${origin.hostname}).`,
    )

  if (config.DELIVERY_MODE === 'sandbox' && !config.ALLOW_SANDBOX_DELIVERY)
    throw new ConfigurationError(
      'DELIVERY_MODE=sandbox logs one-time codes instead of sending them. Set ALLOW_SANDBOX_DELIVERY=true only for a controlled staging run.',
    )

  for (const name of [
    'DATABASE_URL',
    'AUTH_DATABASE_URL',
    'IDENTITY_DATABASE_URL',
  ] as const) {
    if (loginOf(config[name]) === MIGRATOR_LOGIN)
      throw new ConfigurationError(
        `${name} signs in as ${MIGRATOR_LOGIN}, which owns the schema. Production must use the least-privilege runtime logins.`,
      )
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    // Never print the values: they contain database passwords and the secret.
    const fields = parsed.error.issues
      .map((issue) => issue.path.join('.'))
      .join(', ')
    throw new ConfigurationError(`Invalid API configuration: ${fields}`)
  }
  if (parsed.data.DELIVERY_MODE === 'provider') {
    throw new ConfigurationError(
      'DELIVERY_MODE=provider is not supported yet: no email or SMS provider is configured.',
    )
  }
  if (parsed.data.DEV_SANDBOX_OUTBOX && parsed.data.NODE_ENV === 'production') {
    throw new ConfigurationError(
      'DEV_SANDBOX_OUTBOX=true exposes one-time codes and is refused when NODE_ENV=production.',
    )
  }
  if (parsed.data.NODE_ENV === 'production') assertProductionSafe(parsed.data)
  return Object.freeze(parsed.data)
}
