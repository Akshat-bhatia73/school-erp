/**
 * Gives the frozen database fixtures something a person can actually sign in
 * with: provider-valid emails, verified parent phone numbers and one shared
 * development password. Development only, and safe to run twice.
 *
 *   pnpm --filter @erp/api dev:logins
 */
import pg from 'pg'
import { fixtureIds } from '@erp/db/fixtures'
import { loadConfig } from '../src/config.ts'
import { createPools } from '../src/db.ts'
import { createSandboxDelivery } from '../src/delivery/index.ts'
import { createAuth, type AuthInstance } from '../src/auth/better-auth.ts'

/** Documented in docs/auth/WEB_SESSION.md. Development fixtures only. */
const DEV_PASSWORD = 'fixture-password-1'

const MIGRATOR_URL =
  process.env.MIGRATION_DATABASE_URL ??
  process.env.DEV_MIGRATOR_DATABASE_URL ??
  'postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp'

/** The fixture module is plain JavaScript; its ids are always strings. */
const id = (key: keyof typeof fixtureIds): string => String(fixtureIds[key])

interface Account {
  name: string
  school: string
  roles: string
  method: string
  identifier: string
  note: string
}

/** Email identities: provider-valid address, verified, with a password. */
const EMAIL_IDENTITIES = [
  {
    userId: id('ownerAUser'),
    email: 'fixture-owner-a@example.test',
    name: 'Owner A',
    school: 'Fixture A',
    roles: 'owner',
    note: 'second factor required for the school context',
  },
  {
    userId: id('ownerBUser'),
    email: 'fixture-owner-b@example.test',
    name: 'Owner B',
    school: 'Fixture B',
    roles: 'owner',
    note: 'second factor required; use to prove cross-school refusal',
  },
  {
    userId: id('adultUser'),
    email: 'fixture-adult@example.test',
    name: 'Fixture Adult',
    school: 'Fixture A',
    roles: 'teacher, parent',
    note: 'signs in and reaches the school straight away',
  },
  {
    userId: id('suspendedUser'),
    email: 'fixture-suspended@example.test',
    name: 'Suspended',
    school: 'Fixture A',
    roles: 'teacher (suspended)',
    note: 'signs in; the school context answers SCHOOL_ACCESS_UNAVAILABLE',
  },
  {
    userId: id('studentUser'),
    email: 'fixture-student@example.test',
    name: 'Student',
    school: 'Fixture A',
    roles: 'student',
    note: 'student sign-in is disabled: every attempt is refused',
  },
] as const

/** Phone identities: verified number, no password, one-time code only. */
const PHONE_IDENTITIES = [
  {
    userId: id('parentA2User'),
    phone: '+919876543210',
    name: 'Parent A2',
    school: 'Fixture A',
    roles: 'parent',
    note: 'read the code from GET /api/dev/outbox',
  },
  {
    userId: id('parentBUser'),
    phone: '+919876543211',
    name: 'Parent B',
    school: 'Fixture B',
    roles: 'parent',
    note: 'second school, for context switching',
  },
] as const

function refuse(reason: string): never {
  console.error(`dev:logins refused to run: ${reason}`)
  process.exit(1)
}

/** The same steps the test harness uses, so both agree on one credential. */
async function setPassword(
  auth: AuthInstance,
  userId: string,
  password: string,
): Promise<void> {
  const context = await auth.$context
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

function table(rows: readonly Account[]): string {
  const headers: Account = {
    name: 'Name',
    school: 'School',
    roles: 'Roles',
    method: 'Sign-in',
    identifier: 'Identifier',
    note: 'What to expect',
  }
  const keys = Object.keys(headers) as (keyof Account)[]
  const all = [headers, ...rows]
  const widths = keys.map((key) =>
    Math.max(...all.map((row) => row[key].length)),
  )
  const line = (row: Account) =>
    keys.map((key, i) => row[key].padEnd(widths[i] ?? 0)).join('  ')
  const rule = widths.map((width) => '-'.repeat(width)).join('  ')
  return [line(headers), rule, ...rows.map(line)].join('\n')
}

async function main(): Promise<void> {
  const config = loadConfig()
  if (config.NODE_ENV === 'production')
    refuse('NODE_ENV=production. These are development fixtures only.')
  if (config.DELIVERY_MODE !== 'sandbox')
    refuse(
      `DELIVERY_MODE=${config.DELIVERY_MODE}. Real messages would be sent to fixture recipients.`,
    )

  const pools = await createPools(config)
  // Identity rows belong to the migrator: the runtime roles cannot write them.
  const migrator = new pg.Pool({ connectionString: MIGRATOR_URL })
  const auth = createAuth(
    config,
    pools.auth,
    createSandboxDelivery(() => {}),
    pools.identity,
  )

  try {
    for (const identity of EMAIL_IDENTITIES) {
      await migrator.query(
        `UPDATE auth_user
            SET email = $2, email_verified = true, updated_at = now()
          WHERE id = $1`,
        [identity.userId, identity.email],
      )
      await setPassword(auth, identity.userId, DEV_PASSWORD)
    }
    for (const identity of PHONE_IDENTITIES) {
      await migrator.query(
        `UPDATE auth_user
            SET phone_number = $2, phone_number_verified = true, updated_at = now()
          WHERE id = $1`,
        [identity.userId, identity.phone],
      )
    }

    const accounts: Account[] = [
      ...EMAIL_IDENTITIES.map((identity) => ({
        name: identity.name,
        school: identity.school,
        roles: identity.roles,
        method: 'email + password',
        identifier: identity.email,
        note: identity.note,
      })),
      ...PHONE_IDENTITIES.map((identity) => ({
        name: identity.name,
        school: identity.school,
        roles: identity.roles,
        method: 'phone one-time code',
        identifier: identity.phone,
        note: identity.note,
      })),
    ]

    console.info('Development logins are ready.\n')
    console.info(table(accounts))
    console.info(
      `\nPassword for every email account: ${DEV_PASSWORD}` +
        '\nOne-time codes and reset tokens: GET /api/dev/outbox (needs DEV_SANDBOX_OUTBOX=true).' +
        '\nThese identities exist only in the local fixture database.',
    )
  } finally {
    await migrator.end()
    await pools.close()
  }
}

await main()
