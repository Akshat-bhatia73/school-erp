import type { FastifyInstance } from 'fastify'
import { AnonymiseRequest, RETENTION, StaffDetailByAudience } from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import { ApiFailure } from '../../http/errors.ts'
import {
  authorizeResource,
  lockSchool,
  protectedRoute,
  writeAudit,
  type ModuleDependencies,
  type TenantConnection,
} from '../shared/index.ts'
import { bumpVersion } from '../shared/version.ts'
import { recordId, staffDetail } from './reads.ts'
import { reloadStaff } from './writes.ts'

/** Employment ended long enough ago that the private columns may go. */
const LEFT_STATUSES = new Set(['resigned', 'retired'])

/**
 * Staff anonymisation after the retention period (Task 12). What a school owes
 * an ex-employee's record is the employment history: who they were, what they
 * did and when. Everything else is cleared here, by a decision of the school
 * rather than by a timer.
 */
export function registerStaffLifecycleRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/staff/:staffId/anonymise',
    permission: 'staff.anonymise',
    body: AnonymiseRequest,
    response: StaffDetailByAudience,
    handler: async ({ context, body, param }) => {
      const staffId = recordId(param('staffId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await authorizeResource(conn, context, 'staff.anonymise', 'staff', staffId)

        const current = await reloadStaff(conn, context.schoolId, staffId)
        // Nothing about the request is wrong; the record is simply not ready.
        if (current.anonymisedAt !== null) throw new ApiFailure('NOT_ALLOWED_YET')
        if (!LEFT_STATUSES.has(current.status)) throw new ApiFailure('NOT_ALLOWED_YET')
        if (!(await retentionElapsed(conn, context.schoolId, staffId))) {
          throw new ApiFailure('NOT_ALLOWED_YET')
        }

        await bumpVersion(conn, 'staff', {
          schoolId: context.schoolId,
          id: staffId,
          expectedVersion: body.expectedVersion,
          set: {
            phone: null,
            email: null,
            address: null,
            date_of_birth: null,
            gender: null,
            blood_group: null,
            monthly_salary: null,
            bank_account_last4: null,
            pan_last4: null,
            qualification: null,
            anonymised_at: new Date(),
          },
        })

        await writeAudit(conn, context, {
          action: 'staff.anonymise',
          targetType: 'staff',
          targetId: staffId,
          summary: 'Anonymised a former staff record after the retention period.',
          safeChanges: { status: current.status },
          note: body.reason,
        })

        return staffDetail(conn, context, await reloadStaff(conn, context.schoolId, staffId))
      })
    },
  })
}

/**
 * The comparison is made by the database against its own clock, so an API host
 * with a wrong date cannot shorten the period.
 */
async function retentionElapsed(
  conn: TenantConnection,
  schoolId: string,
  staffId: string,
): Promise<boolean> {
  const result = await conn.client.query<{ elapsed: boolean }>(
    `SELECT leaving_date IS NOT NULL
        AND leaving_date <= current_date - make_interval(years => $3::int) AS elapsed
       FROM staff WHERE school_id = $1 AND id = $2`,
    [schoolId, staffId, RETENTION.staffPrivateYears],
  )
  return result.rows[0]?.elapsed === true
}
