/**
 * One typed function per backend operation. Everything is same-origin under `/api`; the session
 * is a cookie the browser carries for us. Responses that have a published contract are validated
 * with it, so a shape change is a clear failure instead of a half-rendered screen.
 */
import { MeResponse, MemberSummary, SchoolContextResponse } from '@erp/contracts'
import { z } from 'zod'
import { request } from '@/lib/http'

// ---------- shapes the provider routes answer with (no published contract) ----------

const ProviderUser = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
  emailVerified: z.boolean().optional(),
  phoneNumber: z.string().nullish(),
  phoneNumberVerified: z.boolean().optional(),
  twoFactorEnabled: z.boolean().nullish(),
})
const ProviderSession = z.looseObject({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
  mfaVerifiedAt: z.string().nullish(),
  sharedDevice: z.boolean().nullish(),
})
const GetSessionResponse = z.looseObject({ session: ProviderSession, user: ProviderUser }).nullable()
export type GetSessionResponse = z.infer<typeof GetSessionResponse>

/**
 * Either the second factor is still owed, or the session cookie is already set. The signed-in
 * branch carries the user; the session itself lives in the cookie and `session` is not always
 * echoed back, so it stays optional.
 */
const SignInResponse = z.union([
  z.looseObject({ twoFactorRedirect: z.literal(true) }),
  z.looseObject({ user: ProviderUser, session: ProviderSession.optional() }),
])

/** True when the person still owes a second factor before the session can be used. */
export function needsSecondFactor(result: SignInResponse): boolean {
  return 'twoFactorRedirect' in result && result.twoFactorRedirect === true
}
export type SignInResponse = z.infer<typeof SignInResponse>

const AuthConfigResponse = z.looseObject({
  deliveryMode: z.enum(['sandbox', 'provider']),
  studentLoginEnabled: z.boolean(),
  /** A test build: text messages are held for a tester instead of being sent. */
  textMessagesHeld: z.boolean().optional(),
})
export type AuthConfigResponse = z.infer<typeof AuthConfigResponse>

const DeviceSession = z.looseObject({
  id: z.string(),
  current: z.boolean(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  expiresAt: z.string(),
  assurance: z.enum(['single_factor', 'mfa']),
  sharedDevice: z.boolean(),
})
export type DeviceSession = z.infer<typeof DeviceSession>
const SessionListResponse = z.looseObject({ sessions: z.array(DeviceSession) })

const TwoFactorEnableResponse = z.looseObject({ totpURI: z.string(), backupCodes: z.array(z.string()) })
const TotpUriResponse = z.looseObject({ totpURI: z.string() })
const BackupCodesResponse = z.looseObject({ backupCodes: z.array(z.string()) })
const VerifiedResponse = z.looseObject({ user: ProviderUser, session: ProviderSession.optional() })

export type MeResponseData = z.infer<typeof MeResponse>
export type SchoolContextData = z.infer<typeof SchoolContextResponse>

// ---------- unauthenticated ----------

export function authConfig() {
  return request('/api/auth-config', { schema: AuthConfigResponse, expectAnonymous: true })
}

// ---------- session ----------

export function me() {
  return request('/api/me', { schema: MeResponse, expectAnonymous: true })
}

export function schoolContext(schoolId: string) {
  return request(`/api/schools/${encodeURIComponent(schoolId)}/context`, { schema: SchoolContextResponse })
}

export function getSession() {
  return request('/api/auth/get-session', { schema: GetSessionResponse, expectAnonymous: true })
}

// ---------- sign in and out ----------

export function signInWithEmail(input: { email: string; password: string; sharedDevice?: boolean }) {
  return request('/api/auth/sign-in/email', { method: 'POST', body: input, schema: SignInResponse, expectAnonymous: true })
}

export function signOut() {
  return request('/api/auth/sign-out', { method: 'POST', body: {}, expectAnonymous: true })
}

export function revokeAllSessions() {
  return request('/api/auth/revoke-sessions', { method: 'POST', body: {} })
}

export function revokeOtherSessions() {
  return request('/api/auth/revoke-other-sessions', { method: 'POST', body: {} })
}

// ---------- passwords ----------

export function requestPasswordReset(email: string) {
  return request('/api/auth/request-password-reset', {
    method: 'POST',
    body: { email, redirectTo: `${window.location.origin}/reset-password` },
    expectAnonymous: true,
  })
}

export function resetPassword(input: { token: string; newPassword: string }) {
  return request('/api/auth/reset-password', { method: 'POST', body: input, expectAnonymous: true })
}

export function changePassword(input: { currentPassword: string; newPassword: string }) {
  return request('/api/auth/change-password', { method: 'POST', body: input })
}

// ---------- phone one-time code ----------

/** 10 digits, a leading 0, 91 or +91 all mean the same Indian mobile number. */
export function normaliseIndianPhone(input: string): string | null {
  const digits = input.replace(/[\s()-]/g, '').replace(/^\+/, '')
  const ten = digits.startsWith('91') && digits.length === 12 ? digits.slice(2)
    : digits.startsWith('0') && digits.length === 11 ? digits.slice(1)
    : digits
  return /^[6-9]\d{9}$/.test(ten) ? `+91${ten}` : null
}

export function sendPhoneOtp(phoneNumber: string) {
  return request('/api/auth/phone-number/send-otp', { method: 'POST', body: { phoneNumber }, expectAnonymous: true })
}

export function verifyPhoneOtp(input: { phoneNumber: string; code: string; sharedDevice?: boolean }) {
  return request('/api/auth/phone-number/verify', { method: 'POST', body: input, schema: VerifiedResponse, expectAnonymous: true })
}

// ---------- second factor ----------

export function twoFactorEnable(password: string) {
  return request('/api/auth/two-factor/enable', { method: 'POST', body: { password }, schema: TwoFactorEnableResponse })
}

export function twoFactorDisable(password: string) {
  return request('/api/auth/two-factor/disable', { method: 'POST', body: { password } })
}

export function twoFactorGetTotpUri(password: string) {
  return request('/api/auth/two-factor/get-totp-uri', { method: 'POST', body: { password }, schema: TotpUriResponse })
}

export function twoFactorVerifyTotp(input: { code: string; sharedDevice?: boolean }) {
  return request('/api/auth/two-factor/verify-totp', { method: 'POST', body: input, expectAnonymous: true })
}

export function twoFactorVerifyBackupCode(input: { code: string; sharedDevice?: boolean }) {
  return request('/api/auth/two-factor/verify-backup-code', { method: 'POST', body: input, expectAnonymous: true })
}

export function twoFactorGenerateBackupCodes(password: string) {
  return request('/api/auth/two-factor/generate-backup-codes', { method: 'POST', body: { password }, schema: BackupCodesResponse })
}

// ---------- own devices ----------

export function listSessions() {
  return request('/api/sessions', { schema: SessionListResponse })
}

export function revokeSession(sessionId: string) {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/revoke`, { method: 'POST', body: {} })
}

// ---------- invitations ----------

export function acceptInvitation(token: string) {
  return request('/api/invitations/accept', { method: 'POST', body: { token }, schema: MemberSummary })
}
