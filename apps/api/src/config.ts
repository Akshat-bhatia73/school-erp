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
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
})

export type ApiConfig = Readonly<z.infer<typeof EnvSchema>>

export class ConfigurationError extends Error {}

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
  return Object.freeze(parsed.data)
}
