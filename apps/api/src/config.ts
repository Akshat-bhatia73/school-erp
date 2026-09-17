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
  /** Provider mode sends email through Resend. Both are required with it. */
  RESEND_API_KEY: z.string().min(1).optional(),
  /** A bare address on a domain verified with the provider. */
  EMAIL_FROM: z.email().optional(),
  /**
   * Test environments only. There is no SMS provider yet, so in provider mode
   * a text message is held in the database instead of being sent, and whoever
   * presents this token may read the held codes at GET /api/held-codes. With
   * it unset an SMS fails, which is the honest answer. Never set it for a
   * real school: the token reads every parent's one-time code.
   */
  HELD_SMS_TOKEN: z.string().min(32).optional(),
  /** Where private student documents live when DOCUMENT_STORAGE=local. */
  DOCUMENT_STORAGE_DIR: z.string().min(1).default('.documents'),
  /** `blob` reads from a private Vercel Blob store; a function has no disk. */
  DOCUMENT_STORAGE: z.enum(['local', 'blob']).default('local'),
  BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),
  /** Error reporting. Absent means nothing leaves the process. */
  SENTRY_DSN: z.url().optional(),
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
  if (
    parsed.data.DELIVERY_MODE === 'provider' &&
    (!parsed.data.RESEND_API_KEY || !parsed.data.EMAIL_FROM)
  ) {
    throw new ConfigurationError(
      'DELIVERY_MODE=provider needs RESEND_API_KEY and EMAIL_FROM.',
    )
  }
  if (parsed.data.HELD_SMS_TOKEN && parsed.data.DELIVERY_MODE !== 'provider') {
    throw new ConfigurationError(
      'HELD_SMS_TOKEN only applies to DELIVERY_MODE=provider; sandbox delivery sends nothing at all.',
    )
  }
  if (parsed.data.DOCUMENT_STORAGE === 'blob' && !parsed.data.BLOB_READ_WRITE_TOKEN) {
    throw new ConfigurationError('DOCUMENT_STORAGE=blob needs BLOB_READ_WRITE_TOKEN.')
  }
  if (parsed.data.DEV_SANDBOX_OUTBOX && parsed.data.NODE_ENV === 'production') {
    throw new ConfigurationError(
      'DEV_SANDBOX_OUTBOX=true exposes one-time codes and is refused when NODE_ENV=production.',
    )
  }
  if (parsed.data.NODE_ENV === 'production') assertProductionSafe(parsed.data)
  return Object.freeze(parsed.data)
}
