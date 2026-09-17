/**
 * Prints the second-factor code for a seeded development account.
 *
 *   pnpm --filter @erp/api dev:totp <base32 secret>
 *
 * The secret is the totp_secret column of apps/api/.dev/sunrise-logins.csv.
 * The code comes from the authentication provider's own generator, so it is
 * always the one the sign-in route is about to expect. Development only.
 */
import { loadConfig } from '../src/config.ts'
import { createPools } from '../src/db.ts'
import { createSandboxDelivery } from '../src/delivery/index.ts'
import { createAuth } from '../src/auth/better-auth.ts'
import { decodeBase32 } from './totp-secret.ts'

const secret = process.argv[2]?.trim()
if (!secret) {
  console.error('Usage: pnpm --filter @erp/api dev:totp <base32 secret>')
  process.exit(1)
}

const config = loadConfig()
if (config.NODE_ENV === 'production') {
  console.error('dev:totp refused to run: NODE_ENV=production.')
  process.exit(1)
}

const pools = await createPools(config)
const auth = createAuth(config, pools.auth, createSandboxDelivery(() => {}), pools.identity)
try {
  const generated = await auth.api.generateTOTP({ body: { secret: decodeBase32(secret) } })
  console.info(generated.code)
} finally {
  await pools.close()
}
