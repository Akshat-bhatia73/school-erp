import type { FastifyInstance } from 'fastify'
import {
  AUTOMATIC_MESSAGE_KINDS,
  CommunicationSettings,
  UpdateCommunicationSettingsRequest,
  type CommunicationSettingsValues,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import {
  allowedActionsFor,
  ApiFailure,
  authorizeSchoolAction,
  lockSchool,
  protectedRoute,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import { loadAutomaticWording, loadCommunicationSettings, type StoredCommunicationSettings } from './common.ts'
import type { MessageConnection } from './shared-reads.ts'

/**
 * The automatic messages' settings: which kinds are on, the delays and the
 * hour of the day, and the wording each kind uses. While the school has never
 * saved them the answer is the defaults, as version 1; the first save writes
 * the row.
 */

/** The request field, the column it is stored in, in one place. */
const COLUMNS: Readonly<Record<keyof CommunicationSettingsValues, string>> = {
  absenceEnabled: 'absence_enabled',
  absenceDelayMinutes: 'absence_delay_minutes',
  resultsEnabled: 'results_enabled',
  reportCardsEnabled: 'report_cards_enabled',
  feeRemindersEnabled: 'fee_reminders_enabled',
  feeReminderDaysBefore: 'fee_reminder_days_before',
  feeOverdueEveryDays: 'fee_overdue_every_days',
  birthdaysPupilsEnabled: 'birthdays_pupils_enabled',
  birthdaysStaffEnabled: 'birthdays_staff_enabled',
  dailySendHour: 'daily_send_hour',
}

const FIELDS = Object.keys(COLUMNS) as (keyof CommunicationSettingsValues)[]

function valuesOf(stored: CommunicationSettingsValues): CommunicationSettingsValues {
  return Object.fromEntries(FIELDS.map((field) => [field, stored[field]])) as unknown as CommunicationSettingsValues
}

async function readSettings(conn: MessageConnection, context: RequestContext): Promise<CommunicationSettings> {
  const stored: StoredCommunicationSettings = await loadCommunicationSettings(conn, context.schoolId)
  const wording = await loadAutomaticWording(conn, context.schoolId)
  const actions = await allowedActionsFor(conn, context, {
    schoolId: context.schoolId,
    resourceType: 'communication',
    id: context.schoolId,
  })
  return {
    ...valuesOf(stored),
    version: stored.version,
    wording: AUTOMATIC_MESSAGE_KINDS.map((kind) => {
      const words = wording[kind]
      return {
        kind,
        title: words.title,
        body: words.body,
        ...(words.templateId === undefined ? {} : { templateId: words.templateId }),
      }
    }),
    allowedActions: [...actions],
  }
}

export function registerCommunicationSettingsRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/messages/settings',
    permission: 'communication.manage',
    response: CommunicationSettings,
    handler: async ({ context }) =>
      withTenantTransaction(deps.pools.runtime, context, (conn) => readSettings(conn, context)),
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/messages/settings',
    permission: 'communication.manage',
    body: UpdateCommunicationSettingsRequest,
    response: CommunicationSettings,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'communication.manage')
        const current = await loadCommunicationSettings(conn, context.schoolId)
        const changed = FIELDS.filter((field) => current[field] !== body[field])
        const values = FIELDS.map((field) => body[field])
        const columns = FIELDS.map((field) => COLUMNS[field])

        if (!current.exists) {
          // The first save writes the row, and automatic messages start from
          // now. The pump may have written it a moment ago, in which case the
          // caller was looking at defaults that are no longer the row.
          if (body.expectedVersion !== 1) throw new ApiFailure('VERSION_CONFLICT')
          const inserted = await conn.client.query(
            `INSERT INTO communication_settings (school_id, ${columns.join(', ')}, version)
             VALUES ($1, ${columns.map((_, index) => `$${index + 2}`).join(', ')}, 2)
             ON CONFLICT (school_id) DO NOTHING`,
            [context.schoolId, ...values],
          )
          if (inserted.rowCount === 0) throw new ApiFailure('VERSION_CONFLICT')
        } else {
          // The table is keyed by the school, not by an id, so bumpVersion
          // cannot be used; the version in the WHERE clause is the same check.
          const assignments = columns.map((column, index) => `${column} = $${index + 3}`).join(', ')
          const updated = await conn.client.query(
            `UPDATE communication_settings
                SET ${assignments}, version = version + 1, updated_at = now()
              WHERE school_id = $1 AND version = $2`,
            [context.schoolId, body.expectedVersion, ...values],
          )
          if (updated.rowCount === 0) throw new ApiFailure('VERSION_CONFLICT')
        }

        await writeAudit(conn, context, {
          action: 'communication.manage',
          targetType: 'communication',
          targetId: context.schoolId,
          summary: 'Changed the automatic message settings.',
          safeChanges: { changed, firstSave: !current.exists },
        })
        return readSettings(conn, context)
      }),
  })
}
