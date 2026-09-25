import type { AssistantUnavailableReason, RoleKey } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import type { ApiConfig } from '../config.ts'
import type { TenantConnection } from '../modules/shared/audit.ts'
import { loadAssistantSettings, type StoredAssistantSettings } from './settings.ts'

/**
 * Can this person ask a question right now. One function, used by the status
 * route and again at the start of every turn, so the screen and the turn can
 * never disagree. The switches are checked in a fixed order and the first one
 * that says no is the reason given.
 *
 * A person an owner or principal restricted never gets here: the route gate
 * refuses ai_assistant.use with ACCESS_DENIED before any handler runs.
 */

/** Parents and pupils share the family limit; anyone holding a staff role has the staff one. */
const FAMILY_ROLES: ReadonlySet<RoleKey> = new Set(['parent', 'student'])

export function isFamilyOnly(roleKeys: readonly RoleKey[]): boolean {
  return roleKeys.length > 0 && roleKeys.every((role) => FAMILY_ROLES.has(role))
}

/**
 * The service is on when this deployment switched it on and can reach the
 * gateway: a key off Vercel, or the project's OIDC token on Vercel, which the
 * gateway provider reads from the environment or from the function's request
 * context.
 */
export function serviceOn(config: ApiConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!config.ASSISTANT_ENABLED) return false
  return (
    config.AI_GATEWAY_API_KEY !== undefined ||
    (env.VERCEL_OIDC_TOKEN ?? '') !== '' ||
    env.VERCEL === '1'
  )
}

export interface Availability {
  readonly available: boolean
  readonly reason?: AssistantUnavailableReason
  readonly questionsLeftToday: number
  readonly settings: StoredAssistantSettings
  /** The day in the school's timezone the next question counts against. */
  readonly schoolDay: string
}

/** Today as YYYY-MM-DD in the school's timezone, by the database clock. */
export async function schoolDayOf(conn: Pick<TenantConnection, 'client'>, schoolId: string): Promise<string> {
  const found = await conn.client.query<{ today: string }>(
    `SELECT to_char((now() AT TIME ZONE COALESCE(NULLIF(timezone, ''), 'Asia/Kolkata'))::date, 'YYYY-MM-DD') AS today
       FROM schools WHERE id = $1`,
    [schoolId],
  )
  const today = found.rows[0]?.today
  if (!today) throw new Error('school not found')
  return today
}

/**
 * A pupil may ask when the newest ai_assistant answer for them, from any of
 * their guardians, is `given`. A pupil login names its pupil through
 * membership_student_links; without one there is nobody to have agreed.
 */
async function pupilConsented(conn: TenantConnection, context: RequestContext): Promise<boolean> {
  const found = await conn.client.query<{ status: string }>(
    `SELECT gc.status
       FROM membership_student_links link
       JOIN guardian_consents gc ON gc.school_id = link.school_id AND gc.student_id = link.student_id
      WHERE link.school_id = $1 AND link.membership_id = $2 AND gc.purpose = 'ai_assistant'
      ORDER BY gc.recorded_at DESC, gc.created_at DESC, gc.id DESC
      LIMIT 1`,
    [context.schoolId, context.membershipId],
  )
  return found.rows[0]?.status === 'given'
}

async function countToday(conn: TenantConnection, context: RequestContext, day: string): Promise<number> {
  const found = await conn.client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM assistant_usage
      WHERE school_id = $1 AND membership_id = $2 AND school_day = $3::date`,
    [context.schoolId, context.membershipId, day],
  )
  return Number(found.rows[0]?.count ?? '0')
}

async function countMonth(conn: TenantConnection, schoolId: string, day: string): Promise<number> {
  const found = await conn.client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM assistant_usage
      WHERE school_id = $1 AND school_day >= date_trunc('month', $2::date)::date AND school_day <= $2::date`,
    [schoolId, day],
  )
  return Number(found.rows[0]?.count ?? '0')
}

export async function availability(
  conn: TenantConnection,
  context: RequestContext,
  config: ApiConfig,
): Promise<Availability> {
  const settings = await loadAssistantSettings(conn, context.schoolId)
  const schoolDay = await schoolDayOf(conn, context.schoolId)
  const dailyLimit = isFamilyOnly(context.roleKeys) ? settings.dailyQuestionsFamily : settings.dailyQuestionsStaff
  const askedToday = await countToday(conn, context, schoolDay)
  const questionsLeftToday = Math.max(0, dailyLimit - askedToday)
  const no = (reason: AssistantUnavailableReason): Availability => ({
    available: false,
    reason,
    questionsLeftToday,
    settings,
    schoolDay,
  })

  if (!serviceOn(config)) return no('service_off')
  if (!settings.enabled) return no('school_off')
  if (context.membershipKind === 'student' && !(await pupilConsented(conn, context))) return no('no_consent')
  if (questionsLeftToday === 0) return no('daily_limit')
  if ((await countMonth(conn, context.schoolId, schoolDay)) >= settings.monthlyQuestions) return no('monthly_limit')
  return { available: true, questionsLeftToday, settings, schoolDay }
}
