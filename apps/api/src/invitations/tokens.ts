import { createHash, randomBytes } from 'node:crypto'

/** An unused invitation stops working two days after it was sent. */
export const INVITATION_TTL_HOURS = 48

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface InvitationToken {
  readonly token: string
  readonly digest: string
}

function digestOf(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/**
 * The accept request carries only the token, but the tenant transaction needs
 * a school before row level security lets it read anything. So the school id
 * travels with the token as routing information. It proves nothing on its own:
 * the row is always found by the digest of the secret half.
 */
export function createInvitationToken(schoolId: string): InvitationToken {
  const secret = randomBytes(32).toString('base64url')
  return { token: `${schoolId}.${secret}`, digest: digestOf(secret) }
}

export function parseInvitationToken(
  token: string,
): { schoolId: string; digest: string } | null {
  const separator = token.indexOf('.')
  if (separator < 0) return null
  const schoolId = token.slice(0, separator)
  const secret = token.slice(separator + 1)
  if (!UUID.test(schoolId) || secret.length < 32) return null
  return { schoolId, digest: digestOf(secret) }
}

/**
 * What a person may safely be shown about where an invitation went. Enough to
 * recognise their own address, not enough to learn somebody else's.
 */
export function maskDestination(kind: 'email' | 'phone', value: string): string {
  if (kind === 'email') {
    const at = value.indexOf('@')
    if (at <= 0) return '***'
    return `${value.slice(0, 1)}***@${value.slice(at + 1)}`
  }
  const country = value.slice(0, 3)
  return `${country}******${value.slice(-2)}`
}
