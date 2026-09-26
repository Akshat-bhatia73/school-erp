/**
 * A signed-in person, talking to the app in-process through `app.inject`,
 * with their own cookies: the same session, gate and routes a browser gets.
 */
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import type { AuthInstance } from '../src/auth/better-auth.ts'
import type { DeliveryAdapter } from '../src/delivery/index.ts'
import { decodeBase32 } from '../scripts/totp-secret.ts'

export interface Answer {
  readonly status: number
  readonly body: string
  json<T>(): T
}

export class InjectClient {
  private readonly cookies = new Map<string, string>()

  constructor(
    private readonly app: FastifyInstance,
    private readonly origin: string,
  ) {}

  async send(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<Answer> {
    const headers: Record<string, string> = { origin: this.origin }
    if (this.cookies.size > 0) headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    if (payload !== undefined) headers['content-type'] = 'application/json'
    const response = await this.app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    })
    const setCookie = response.headers['set-cookie']
    for (const line of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      const pair = line.split(';')[0] ?? ''
      const at = pair.indexOf('=')
      if (at <= 0) continue
      const value = pair.slice(at + 1)
      // An expired cookie is how a sign-out or a replaced session says "forget it".
      if (value === '' || /max-age=0/i.test(line)) this.cookies.delete(pair.slice(0, at))
      else this.cookies.set(pair.slice(0, at), value)
    }
    const body = response.body
    return { status: response.statusCode, body, json: <T>() => JSON.parse(body) as T }
  }

  get(url: string): Promise<Answer> {
    return this.send('GET', url)
  }

  post(url: string, payload?: unknown): Promise<Answer> {
    return this.send('POST', url, payload ?? {})
  }
}

/** Signing in is rate limited per address; the eval signs in more than a person would. */
export async function clearSignInLimits(db: pg.Pool): Promise<void> {
  await db.query('DELETE FROM auth_rate_limit')
  await db.query('DELETE FROM auth_throttle')
}

function expectOk(answer: Answer, what: string): void {
  if (answer.status !== 200) throw new Error(`${what} failed with status ${answer.status}: ${answer.body.slice(0, 300)}`)
}

/** Email and password, then the second factor from the seeded TOTP secret when the account has one. */
export async function signInWithEmail(
  client: InjectClient,
  auth: AuthInstance,
  login: { email: string; password: string; totpSecret?: string },
): Promise<void> {
  const signIn = await client.post('/api/auth/sign-in/email', { email: login.email, password: login.password })
  expectOk(signIn, `signing in ${login.email}`)
  if (!signIn.json<{ twoFactorRedirect?: boolean }>().twoFactorRedirect) return
  if (!login.totpSecret) throw new Error(`${login.email} needs a second factor but the seed gave no TOTP secret`)
  const generated = await auth.api.generateTOTP({ body: { secret: decodeBase32(login.totpSecret) } })
  expectOk(await client.post('/api/auth/two-factor/verify-totp', { code: generated.code }), `the second factor for ${login.email}`)
}

/** A one-time code to the phone, read back from the sandbox outbox. */
export async function signInWithPhone(client: InjectClient, delivery: DeliveryAdapter, phone: string): Promise<void> {
  expectOk(await client.post('/api/auth/phone-number/send-otp', { phoneNumber: phone }), `sending a code to ${phone}`)
  const digits = phone.replace(/\D/g, '').slice(-10)
  const message = [...delivery.outbox]
    .reverse()
    .find((sent) => sent.channel === 'sms' && sent.purpose === 'otp' && sent.to.replace(/\D/g, '').endsWith(digits))
  if (!message?.secret) throw new Error(`the sandbox holds no code for ${phone}`)
  expectOk(await client.post('/api/auth/phone-number/verify', { phoneNumber: phone, code: message.secret }), `verifying ${phone}`)
}

/** A pupil: school code, admission number and password. */
export async function signInAsPupil(client: InjectClient, login: { schoolCode: string; admissionNumber: string; password: string }): Promise<void> {
  expectOk(await client.post('/api/student-sign-in', login), `signing in pupil ${login.admissionNumber}`)
}
