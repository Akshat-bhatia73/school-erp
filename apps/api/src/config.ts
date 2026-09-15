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
  return Object.freeze(parsed.data)
}
