import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AuthInstance } from '../auth/better-auth.ts'
import { studentPlaceholderEmail } from '../auth/student-sign-in.ts'

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

/**
 * A pupil's own identity (Task 23). The address is generated and ends in
 * @student.invalid: nothing is ever sent there and the email door refuses it.
 * The password is the one the school texts to the primary guardian, so the
 * identity starts with must_change_password set. There is no HTTP route: the
 * student login helpers call this before the membership is written, and call
 * removeUnusedStudentIdentity when that write does not commit.
 */
export async function provisionStudentIdentity(
  auth: AuthInstance,
  input: { name: string; password: string },
): Promise<ProvisionedIdentity> {
  const context = await auth.$context
  const email = studentPlaceholderEmail()
  const user = await context.internalAdapter.createUser(
    {
      name: input.name,
      email,
      emailVerified: false,
      mustChangePassword: true,
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
 * A new generated password for a pupil's identity: the office reset it. Every
 * live session ends, the lockout counter clears (the pupil may have locked
 * themselves out), and the pupil must choose their own password again.
 */
export async function replaceStudentPassword(
  auth: AuthInstance,
  authPool: Pool,
  userId: string,
  password: string,
): Promise<void> {
  const context = await auth.$context
  const hash = await context.password.hash(password)
  await context.internalAdapter.updatePassword(userId, hash)
  await authPool.query(
    `UPDATE auth_user
        SET must_change_password = true, failed_sign_ins = 0, locked_until = NULL, updated_at = now()
      WHERE id = $1`,
    [userId],
  )
  await context.internalAdapter.deleteUserSessions(userId)
}

/** Every live session of one identity ends now: a login was switched off or ended. */
export async function endAllSessions(auth: AuthInstance, userId: string): Promise<void> {
  const context = await auth.$context
  await context.internalAdapter.deleteUserSessions(userId)
}

/**
 * A pupil identity whose membership never committed. It has no membership,
 * so nothing else refers to it; removing it leaves no login behind.
 */
export async function removeUnusedStudentIdentity(
  auth: AuthInstance,
  userId: string,
): Promise<void> {
  const context = await auth.$context
  await context.internalAdapter.deleteUser(userId)
}
