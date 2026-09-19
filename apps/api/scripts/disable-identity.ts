/**
 * Operator action on one identity, outside any school.
 *
 *   pnpm --filter @erp/api ops:identity -- --email <address> --disable
 *   pnpm --filter @erp/api ops:identity -- --email <address> --enable
 *   pnpm --filter @erp/api ops:identity -- --email <address> --unlock
 *
 * No school owns a cross-school identity, so this is not an API route. It
 * connects with AUTH_DATABASE_URL, the only login that may write auth_user.
 * Disabling also ends every live session, which is the containment step the
 * incident runbook calls for. Nothing here prints the address or a secret.
 */
import pg from 'pg'

type Action = 'disable' | 'enable' | 'unlock'

const USAGE =
  'Usage: pnpm --filter @erp/api ops:identity -- --email <address> --disable|--enable|--unlock'

function parseArguments(argv: readonly string[]): {
  email: string
  action: Action
} {
  let email: string | null = null
  const actions: Action[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--email') {
      email = argv[index + 1] ?? null
      index += 1
      continue
    }
    if (argument?.startsWith('--email=')) {
      email = argument.slice('--email='.length)
      continue
    }
    if (argument === '--disable' || argument === '--enable' || argument === '--unlock') {
      actions.push(argument.slice(2) as Action)
      continue
    }
    fail(`Unknown argument: ${argument}`)
  }
  if (!email || email.length === 0) fail('An --email is required.')
  if (actions.length !== 1)
    fail('Exactly one of --disable, --enable or --unlock is required.')
  return { email: email as string, action: actions[0] as Action }
}

function fail(message: string): never {
  console.error(`${message}\n${USAGE}`)
  process.exit(2)
}

const { email, action } = parseArguments(process.argv.slice(2))

const connectionString = process.env.AUTH_DATABASE_URL
if (!connectionString) {
  console.error('AUTH_DATABASE_URL is not set.')
  process.exit(2)
}

const pool = new pg.Pool({ connectionString, max: 1 })
try {
  // One statement per action, so --unlock can never re-enable a disabled
  // identity and --enable can never be read as a lock-only change.
  const statement =
    action === 'disable'
      ? `UPDATE auth_user SET disabled_at = now()
          WHERE lower(email) = lower($1) RETURNING id`
      : action === 'enable'
        ? // Enabling also clears the lock: an operator re-admitting someone
          // does not mean them to wait out a fifteen minute lockout.
          `UPDATE auth_user SET disabled_at = NULL, locked_until = NULL, failed_sign_ins = 0
            WHERE lower(email) = lower($1) RETURNING id`
        : `UPDATE auth_user SET locked_until = NULL, failed_sign_ins = 0
            WHERE lower(email) = lower($1) RETURNING id`
  const { rows } = await pool.query<{ id: string }>(statement, [email])
  if (rows.length === 0) {
    // Never echo the address: this output may end up in an incident record.
    console.error('no identity matched that email')
    process.exit(1)
  }
  let sessions: number | null = null
  if (action === 'disable') {
    const ended = await pool.query(
      `DELETE FROM auth_session WHERE user_id = ANY($1::uuid[])`,
      [rows.map((row) => row.id)],
    )
    sessions = ended.rowCount ?? 0
  }
  const verb =
    action === 'disable' ? 'disabled' : action === 'enable' ? 'enabled' : 'unlocked'
  console.info(
    `${verb} ${rows.length} identity` +
      (sessions === null ? '' : `, ended ${sessions} sessions`),
  )
} finally {
  await pool.end()
}
