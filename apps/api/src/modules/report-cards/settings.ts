import type { FastifyInstance } from 'fastify'
import { withTenantTransaction } from '@erp/db'
import { ExamSettings, ExamSettingsUpdateRequest, gradeBandsProblem } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import {
  ApiFailure,
  authorizeSchoolAction,
  bumpVersion,
  decideSchoolAction,
  lockSchool,
  protectedRoute,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import { readExamSettings, type ExamConnection } from '../exams/common.ts'

/**
 * The school's grade bands, whether families see marks or grades, and the
 * report card layout. They are school-wide and every holder of exams.read may
 * read them, because the grading key is printed on every card. Only the
 * office changes them, and a change never touches a card already published.
 */

async function settingsAnswer(conn: ExamConnection, context: RequestContext): Promise<ExamSettings> {
  const settings = await readExamSettings(conn, context.schoolId)
  const logo = await conn.client.query<{ has_logo: boolean }>(
    'SELECT (logo_storage_key IS NOT NULL) AS has_logo FROM schools WHERE id = $1',
    [context.schoolId],
  )
  const manage = await decideSchoolAction(conn, context, 'exams.manage')
  return {
    displayMode: settings.displayMode,
    gradeBands: settings.gradeBands,
    layout: settings.layout,
    version: settings.version,
    ...(settings.updatedAt === null ? {} : { updatedAt: settings.updatedAt }),
    hasLogo: logo.rows[0]?.has_logo === true,
    allowedActions: manage.allowed ? ['exams.manage'] : [],
  }
}

export function registerReportCardSettingsRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/report-cards/settings',
    permission: 'exams.read',
    response: ExamSettings,
    handler: async ({ context }) =>
      withTenantTransaction(deps.pools.runtime, context, (conn) => settingsAnswer(conn, context)),
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/report-cards/settings',
    permission: 'exams.manage',
    body: ExamSettingsUpdateRequest,
    response: ExamSettings,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'exams.manage')
        // The whole body is checked before anything is written.
        const problem = gradeBandsProblem(body.gradeBands)
        if (problem !== null) throw new ApiFailure('INVALID_REQUEST', undefined, problem)

        const before = await readExamSettings(conn, context.schoolId)
        const bands = JSON.stringify(body.gradeBands)
        const layout = JSON.stringify(body.layout)
        if (body.expectedVersion === 0) {
          // The first save over the defaults. Somebody else's first save got
          // in first when nothing is inserted.
          const inserted = await conn.client.query(
            `INSERT INTO exam_settings (school_id, display_mode, grade_bands, layout, updated_by_membership_id)
             VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
             ON CONFLICT (school_id) DO NOTHING RETURNING id`,
            [context.schoolId, body.displayMode, bands, layout, context.membershipId],
          )
          if (inserted.rows.length === 0) throw new ApiFailure('VERSION_CONFLICT')
        } else {
          const found = await conn.client.query<{ id: string }>(
            'SELECT id FROM exam_settings WHERE school_id = $1',
            [context.schoolId],
          )
          const row = found.rows[0]
          if (!row) throw new ApiFailure('VERSION_CONFLICT')
          await bumpVersion(conn, 'exam_settings', {
            schoolId: context.schoolId,
            id: row.id,
            expectedVersion: body.expectedVersion,
            set: {
              display_mode: body.displayMode,
              grade_bands: bands,
              layout,
              updated_by_membership_id: context.membershipId,
            },
          })
        }

        const changed: string[] = []
        if (JSON.stringify(before.gradeBands) !== bands) changed.push('gradeBands')
        if (before.displayMode !== body.displayMode) changed.push('displayMode')
        if (JSON.stringify(before.layout) !== layout) changed.push('layout')
        await writeAudit(conn, context, {
          action: 'exams.manage',
          targetType: 'exam_settings',
          targetId: null,
          summary: 'Changed the grade bands, the results display or the report card layout.',
          safeChanges: {
            displayMode: body.displayMode,
            bands: body.gradeBands.length,
            blocks: body.layout.blocks.length,
            changed,
          },
        })
        return settingsAnswer(conn, context)
      }),
  })
}
