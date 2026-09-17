import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.MIGRATION_DATABASE_URL ??
      (() => {
        throw new Error('MIGRATION_DATABASE_URL is required')
      })(),
  },
  strict: true,
  verbose: true,
})
