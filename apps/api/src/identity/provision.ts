import { randomUUID } from 'node:crypto'
import type { AuthInstance } from '../auth/better-auth.ts'

/**
 * Server-side identity provisioning for later invitation flows. There is no
 * HTTP route: self-registration stays closed.
 */
export interface ProvisionedIdentity {
  readonly userId: string
  readonly email: string
}

export async function provisionEmailIdentity(
  auth: AuthInstance,
  input: { name: string; email: string; password: string },
): Promise<ProvisionedIdentity> {
  const context = await auth.$context
  const user = await context.internalAdapter.createUser(
    {
      name: input.name,
      email: input.email.toLowerCase(),
      emailVerified: false,
    },
    { method: 'email-password' },
  )
  const hash = await context.password.hash(input.password)
  await context.internalAdapter.createAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: hash,
  })
  return { userId: user.id, email: user.email }
}

/**
 * A phone-only adult has no usable email. Store a generated, non-deliverable
 * identifier so the adapter keeps its unique email column, and never mark it
 * verified: email login and reset must not work for this identity.
 */
export async function provisionPhoneIdentity(
  auth: AuthInstance,
  input: { name: string; phone: string },
): Promise<ProvisionedIdentity> {
  const context = await auth.$context
  const placeholder = `${randomUUID()}@phone-only.invalid`
  const user = await context.internalAdapter.createUser(
    {
      name: input.name,
      email: placeholder,
      emailVerified: false,
      phoneNumber: input.phone,
      phoneNumberVerified: true,
    },
    { method: 'phone-number' },
  )
  // No credential account: this identity signs in with a phone OTP only.
  return { userId: user.id, email: placeholder }
}
