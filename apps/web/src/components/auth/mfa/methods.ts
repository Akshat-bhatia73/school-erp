import type { SecondStepMethod } from '@erp/contracts'

/** What each second step is called on screen. */
export const METHOD_LABEL: Record<SecondStepMethod, string> = {
  totp: 'Authenticator app',
  sms: 'Text message',
  email: 'Email',
}

export const METHOD_HINT: Record<SecondStepMethod, string> = {
  totp: 'A code from an app such as Google Authenticator. Works without signal.',
  sms: 'A code sent to your mobile number each time you sign in.',
  email: 'A code sent to your email address each time you sign in.',
}

/** "••••••3210", the same form the server uses for a sign-in challenge. */
export function maskPhone(phone: string): string {
  return `••••••${phone.replace(/\D/g, '').slice(-4)}`
}

/** "p•••@school.in". */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  return at <= 0 ? '•••' : `${email.slice(0, 1)}•••${email.slice(at)}`
}

/** Where a code for this step goes, from the account the server described. */
export function destinationFor(
  method: SecondStepMethod,
  account: { email?: string | null; phoneNumber?: string | null; phoneNumberVerified?: boolean } | null | undefined,
): string | undefined {
  if (!account) return undefined
  if (method === 'sms') return account.phoneNumber && account.phoneNumberVerified ? maskPhone(account.phoneNumber) : undefined
  if (method === 'email') return account.email ? maskEmail(account.email) : undefined
  return undefined
}

export function isCodeMethod(method: SecondStepMethod): method is 'sms' | 'email' {
  return method === 'sms' || method === 'email'
}
