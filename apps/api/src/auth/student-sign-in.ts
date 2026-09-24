import { AsyncLocalStorage } from 'node:async_hooks'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { studentSignInUser } from '@erp/db'
import {
  STUDENT_PLACEHOLDER_EMAIL_DOMAIN,
  StudentSignInRequest,
  StudentSignInResponse,
} from '@erp/contracts'
import type { ApiConfig } from '../config.ts'
import type { ApiPools } from '../db.ts'
import { CLIENT_IP_HEADER } from '../app.ts'
import { ApiFailure } from '../http/errors.ts'
import type { AuthInstance } from './better-auth.ts'
import { markSharedDevice } from './mfa.ts'

/**
 * A pupil's own login (Task 23).
 *
 * A pupil in Class 9 to 12 types the school's login code, their admission
 * number and a password. Their identity is an ordinary auth_user whose address
 * is generated and ends in @student.invalid, so nothing is ever sent there and
 * nobody knows it. The email sign-in door refuses such an address unless the
 * call comes from the route below, which finds the address from the school
 * code and admission number and then signs in through the provider exactly
 * as the email door does: the same password check, the same lockout after ten
 * failures, the same session cookie.
 */

/** The address suffix every pupil identity carries. */
export const STUDENT_EMAIL_SUFFIX = `@${STUDENT_PLACEHOLDER_EMAIL_DOMAIN}`

export function isStudentEmail(email: string): boolean {
  return email.toLowerCase().endsWith(STUDENT_EMAIL_SUFFIX)
}

/** A fresh, never-deliverable address for a new pupil identity. */
export function studentPlaceholderEmail(): string {
  return `${randomUUID()}${STUDENT_EMAIL_SUFFIX}`
}

/**
 * Set only while the student route below is signing a pupil in. The
 * provider's email door looks at it to tell that call apart from somebody
 * typing a pupil's generated address into the staff form.
 */
export const studentSignInScope = new AsyncLocalStorage<true>()

/**
 * Letters and digits a child can read off a phone and type without
 * confusion: no 0/o, 1/l/i.
 */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/**
 * A generated password such as "k7m3-p9xq-4tad": three groups of four from a
 * 31 symbol alphabet, about 59 bits. It travels by text message, so the pupil
 * must replace it at first sign-in.
 */
export function generateStudentPassword(): string {
  const groups: string[] = []
  for (let group = 0; group < 3; group += 1) {
    let part = ''
    for (let index = 0; index < 4; index += 1)
      part += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]
    groups.push(part)
  }
  return groups.join('-')
}

export interface StudentSignInDependencies {
  readonly config: ApiConfig
  readonly auth: AuthInstance
  readonly pools: ApiPools
}

export function registerStudentSignInRoute(
  app: FastifyInstance,
  deps: StudentSignInDependencies,
): void {
  app.post('/api/student-sign-in', async (request, reply) => {
    const parsed = StudentSignInRequest.safeParse(request.body)
    if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
    const input = parsed.data

    // An unknown school code or admission number still goes through the
    // provider with an address nobody holds, so the answer and its timing
    // match a wrong password.
    const userId = await studentSignInUser(
      deps.pools.identity,
      input.schoolCode,
      input.admissionNumber,
    )
    const email =
      (userId === null ? null : await studentEmailOf(deps.pools, userId)) ??
      studentPlaceholderEmail()

    const headers = new Headers({ 'content-type': 'application/json' })
    const origin = request.headers.origin
    if (typeof origin === 'string') headers.set('origin', origin)
    const userAgent = request.headers['user-agent']
    if (typeof userAgent === 'string') headers.set('user-agent', userAgent)
    headers.set(CLIENT_IP_HEADER, request.ip)
    const response = await studentSignInScope.run(true, () =>
      deps.auth.handler(
        new Request(new URL('/api/auth/sign-in/email', deps.config.APP_ORIGIN), {
          method: 'POST',
          headers,
          body: JSON.stringify({ email, password: input.password, rememberMe: true }),
        }),
      ),
    )

    const setCookie = response.headers.getSetCookie()
    if (response.status >= 400) {
      request.log.warn(
        { requestId: request.id, status: response.status },
        'student sign-in refused',
      )
      if (response.status === 429) throw new ApiFailure('RATE_LIMITED')
      throw new ApiFailure(
        response.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'AUTHENTICATION_REQUIRED',
      )
    }

    const body = (await response.json().catch(() => null)) as {
      token?: unknown
      user?: { id?: unknown }
    } | null
    const token = typeof body?.token === 'string' ? body.token : undefined
    if (input.sharedDevice === true && token) await markSharedDevice(deps.pools.auth, token)

    const signedInId = typeof body?.user?.id === 'string' ? body.user.id : userId
    const passwordChangeRequired =
      signedInId !== null && (await mustChangePassword(deps.pools, signedInId))

    // Each cookie on its own header line; no token ever reaches the browser body.
    if (setCookie.length > 0) reply.header('set-cookie', setCookie)
    return StudentSignInResponse.parse({ signedIn: true, passwordChangeRequired })
  })
}

async function studentEmailOf(pools: ApiPools, userId: string): Promise<string | null> {
  const { rows } = await pools.auth.query<{ email: string }>(
    'SELECT email FROM auth_user WHERE id = $1',
    [userId],
  )
  const email = rows[0]?.email
  return email !== undefined && isStudentEmail(email) ? email : null
}

async function mustChangePassword(pools: ApiPools, userId: string): Promise<boolean> {
  const { rows } = await pools.auth.query<{ must: boolean }>(
    'SELECT must_change_password AS must FROM auth_user WHERE id = $1',
    [userId],
  )
  return rows[0]?.must === true
}
