import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  AssistantSettings,
  AssistantUsage,
  DEFAULT_ASSISTANT_SETTINGS,
  RoleKey,
  UpdateAssistantSettingsRequest,
  type AssistantSettingsValues,
  type PermissionKey,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import type { AuthzConnection } from '@erp/authz'
import { withTenantTransaction } from '@erp/db'
import { ApiFailure } from '../http/errors.ts'
import { authorizeSchoolAction, decideSchoolAction } from '../modules/shared/authorize.ts'
import { lockSchool, writeAudit, type TenantConnection } from '../modules/shared/audit.ts'
import { protectedRoute, type ModuleDependencies } from '../modules/shared/route.ts'

/**
 * The school's switch and limits. While the school has never saved them the
 * answer is the defaults at version 1; the first save writes the row, exactly
 * as the automatic message settings do.
 */
export interface StoredAssistantSettings extends AssistantSettingsValues {
  readonly version: number
  readonly exists: boolean
}

const COLUMNS: Readonly<Record<keyof AssistantSettingsValues, string>> = {
  enabled: 'enabled',
  dailyQuestionsStaff: 'daily_questions_staff',
  dailyQuestionsFamily: 'daily_questions_family',
  monthlyQuestions: 'monthly_questions',
}

const FIELDS = Object.keys(COLUMNS) as (keyof AssistantSettingsValues)[]

export async function loadAssistantSettings(
  conn: Pick<TenantConnection, 'client'>,
  schoolId: string,
): Promise<StoredAssistantSettings> {
  const found = await conn.client.query<{
    enabled: boolean
    daily_questions_staff: number
    daily_questions_family: number
    monthly_questions: number
    version: number
  }>(
    `SELECT enabled, daily_questions_staff, daily_questions_family, monthly_questions, version
       FROM assistant_settings WHERE school_id = $1`,
    [schoolId],
  )
  const row = found.rows[0]
  if (!row) return { ...DEFAULT_ASSISTANT_SETTINGS, version: 1, exists: false }
  return {
    enabled: row.enabled,
    dailyQuestionsStaff: Number(row.daily_questions_staff),
    dailyQuestionsFamily: Number(row.daily_questions_family),
    monthlyQuestions: Number(row.monthly_questions),
    version: Number(row.version),
    exists: true,
  }
}

/** The ai_assistant keys the caller holds for the school; conversations are not a record here. */
async function assistantActions(conn: AuthzConnection, context: RequestContext): Promise<PermissionKey[]> {
  const keys: PermissionKey[] = []
  for (const key of ['ai_assistant.use', 'ai_assistant.manage'] as const) {
    if ((await decideSchoolAction(conn, context, key)).allowed) keys.push(key)
  }
  return keys
}

async function readSettings(conn: AuthzConnection, context: RequestContext): Promise<AssistantSettings> {
  const stored = await loadAssistantSettings(conn, context.schoolId)
  return {
    enabled: stored.enabled,
    dailyQuestionsStaff: stored.dailyQuestionsStaff,
    dailyQuestionsFamily: stored.dailyQuestionsFamily,
    monthlyQuestions: stored.monthlyQuestions,
    version: stored.version,
    allowedActions: await assistantActions(conn, context),
  }
}

/** The calendar month in the school's timezone, YYYY-MM, by the database clock. */
async function schoolMonth(conn: TenantConnection, schoolId: string): Promise<string> {
  const found = await conn.client.query<{ month: string }>(
    `SELECT to_char((now() AT TIME ZONE COALESCE(NULLIF(timezone, ''), 'Asia/Kolkata'))::date, 'YYYY-MM') AS month
       FROM schools WHERE id = $1`,
    [schoolId],
  )
  const month = found.rows[0]?.month
  if (!month) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return month
}

const UsageQuery = z.strictObject({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
})

export function registerAssistantSettingsRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/assistant/settings',
    permission: 'ai_assistant.manage',
    response: AssistantSettings,
    handler: async ({ context }) =>
      withTenantTransaction(deps.pools.runtime, context, (conn) => readSettings(conn, context)),
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/assistant/settings',
    permission: 'ai_assistant.manage',
    body: UpdateAssistantSettingsRequest,
    response: AssistantSettings,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'ai_assistant.manage')
        const current = await loadAssistantSettings(conn, context.schoolId)
        const changed = FIELDS.filter((field) => current[field] !== body[field])
        const values = FIELDS.map((field) => body[field])
        const columns = FIELDS.map((field) => COLUMNS[field])

        if (!current.exists) {
          // The first save writes the row. The caller was looking at the
          // defaults, which are version 1.
          if (body.expectedVersion !== 1) throw new ApiFailure('VERSION_CONFLICT')
          const inserted = await conn.client.query(
            `INSERT INTO assistant_settings (school_id, ${columns.join(', ')}, version)
             VALUES ($1, ${columns.map((_, index) => `$${index + 2}`).join(', ')}, 2)
             ON CONFLICT (school_id) DO NOTHING`,
            [context.schoolId, ...values],
          )
          if (inserted.rowCount === 0) throw new ApiFailure('VERSION_CONFLICT')
        } else {
          // Keyed by the school rather than an id, so the version in the WHERE
          // clause is the bumpVersion check written out.
          const assignments = columns.map((column, index) => `${column} = $${index + 3}`).join(', ')
          const updated = await conn.client.query(
            `UPDATE assistant_settings
                SET ${assignments}, version = version + 1, updated_at = now()
              WHERE school_id = $1 AND version = $2`,
            [context.schoolId, body.expectedVersion, ...values],
          )
          if (updated.rowCount === 0) throw new ApiFailure('VERSION_CONFLICT')
        }

        await writeAudit(conn, context, {
          action: 'ai_assistant.manage',
          targetType: 'ai_assistant',
          targetId: context.schoolId,
          summary: 'Changed the assistant settings.',
          safeChanges: {
            changed,
            firstSave: !current.exists,
            ...(changed.includes('enabled') ? { enabled: body.enabled } : {}),
          },
        })
        return readSettings(conn, context)
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/assistant/usage',
    permission: 'ai_assistant.manage',
    query: UsageQuery,
    response: AssistantUsage,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const month = query.month ?? (await schoolMonth(conn, context.schoolId))
        const first = `${month}-01`
        const settings = await loadAssistantSettings(conn, context.schoolId)
        // Counts only: how many questions and how many people, per role the
        // person held when they asked. Never the words, never who.
        const total = await conn.client.query<{ questions: string }>(
          `SELECT count(*)::text AS questions FROM assistant_usage
            WHERE school_id = $1 AND school_day >= $2::date
              AND school_day < ($2::date + interval '1 month')`,
          [context.schoolId, first],
        )
        const roles = await conn.client.query<{ role: string; questions: string; people: string }>(
          `SELECT role, count(*)::text AS questions, count(DISTINCT membership_id)::text AS people
             FROM assistant_usage, unnest(role_keys) AS role
            WHERE school_id = $1 AND school_day >= $2::date
              AND school_day < ($2::date + interval '1 month')
            GROUP BY role`,
          [context.schoolId, first],
        )
        const byRole = RoleKey.options.flatMap((role) => {
          const row = roles.rows.find((entry) => entry.role === role)
          return row ? [{ role, questions: Number(row.questions), people: Number(row.people) }] : []
        })
        return {
          month,
          questions: Number(total.rows[0]?.questions ?? '0'),
          monthlyQuestions: settings.monthlyQuestions,
          byRole,
        }
      }),
  })
}
