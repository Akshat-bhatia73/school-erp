import type { FastifyInstance } from 'fastify'
import {
  HOMEWORK_DUE_MAX_DAYS,
  HomeworkCreateRequest,
  HomeworkDetail,
  HomeworkListRequest,
  HomeworkListResponse,
  HomeworkRemoveRequest,
  HomeworkUpdateRequest,
} from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import {
  ApiFailure,
  assertUuidParam,
  assertVersion,
  bumpVersion,
  lockSchool,
  protectedRoute,
  requireFound,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import {
  addDays,
  assertNotRemoved,
  decideHomework,
  homeworkWritePlans,
  itemMatches,
  readItemRow,
  schoolToday,
  type HomeworkConnection,
} from './common.ts'
import { listHomework, readHomeworkDetail } from './reads.ts'

/**
 * Homework items: the list, one item, setting, editing and removing.
 *
 * Setting has no row to decide against yet, so the item is inserted and then
 * decided again through the caller's own homework.set plan in the same
 * transaction; when the plan does not reach it the transaction rolls back
 * with the refusal (PROTECTED_APIS.md, Homework). Nothing here checks a
 * teaching assignment or a class-teacher post by hand.
 */

const BASE = '/api/schools/:schoolId/homework'
const ONE = `${BASE}/:homeworkId`

interface SectionFacts {
  id: string
  academic_year_id: string
  grade_id: string
  year_status: string
  year_start: string
  year_end: string
}

/** The section with its year, in this school, or a refused request. */
async function sectionFacts(conn: HomeworkConnection, schoolId: string, sectionId: string): Promise<SectionFacts> {
  const rows = await conn.client.query<SectionFacts>(
    `SELECT sections.id, sections.academic_year_id, sections.grade_id, ay.status AS year_status,
            to_char(ay.start_date, 'YYYY-MM-DD') AS year_start, to_char(ay.end_date, 'YYYY-MM-DD') AS year_end
       FROM sections
       JOIN academic_years ay ON ay.school_id = sections.school_id AND ay.id = sections.academic_year_id
      WHERE sections.school_id = $1 AND sections.id = $2`,
    [schoolId, sectionId],
  )
  const row = rows.rows[0]
  if (!row) throw new ApiFailure('INVALID_REQUEST')
  return row
}

/**
 * The due date: on or after the day the item was set, within
 * HOMEWORK_DUE_MAX_DAYS of it, and inside the item's academic year.
 */
function assertDueOn(dueOn: string, setOn: string, yearEnd: string): void {
  if (dueOn < setOn || dueOn > addDays(setOn, HOMEWORK_DUE_MAX_DAYS) || dueOn > yearEnd) {
    throw new ApiFailure('INVALID_REQUEST', undefined, 'homework_due_out_of_range')
  }
}

/** The author's own staff record, when they have one. */
async function staffOf(conn: HomeworkConnection, schoolId: string, membershipId: string): Promise<string | null> {
  const rows = await conn.client.query<{ staff_id: string }>(
    'SELECT staff_id FROM membership_staff_links WHERE school_id = $1 AND membership_id = $2 LIMIT 1',
    [schoolId, membershipId],
  )
  return rows.rows[0]?.staff_id ?? null
}

export function registerHomeworkItemRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: BASE,
    permission: 'homework.read',
    query: HomeworkListRequest,
    response: HomeworkListResponse,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, (conn) => listHomework(conn, context, query)),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: ONE,
    permission: 'homework.read',
    response: HomeworkDetail,
    handler: async ({ context, param }) => {
      const homeworkId = assertUuidParam(param('homeworkId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await decideHomework(conn, context, 'homework.read', homeworkId)
        return readHomeworkDetail(conn, context, homeworkId)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: BASE,
    permission: 'homework.set',
    body: HomeworkCreateRequest,
    response: HomeworkDetail,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const schoolId = context.schoolId
        await lockSchool(conn, schoolId)
        const today = await schoolToday(conn, schoolId)
        const section = await sectionFacts(conn, schoolId, body.sectionId)
        if (section.year_status === 'closed' || today < section.year_start || today > section.year_end) {
          throw new ApiFailure('INVALID_REQUEST', undefined, 'homework_year_not_current')
        }
        const subjectId = body.subjectId ?? null
        if (subjectId !== null) {
          // One of the class's subjects that year, and a subject of this school.
          const taught = await conn.client.query(
            `SELECT 1 FROM grade_subjects gs
               JOIN subjects ON subjects.school_id = gs.school_id AND subjects.id = gs.subject_id
              WHERE gs.school_id = $1 AND gs.grade_id = $2 AND gs.academic_year_id = $3 AND gs.subject_id = $4`,
            [schoolId, section.grade_id, section.academic_year_id, subjectId],
          )
          if (taught.rows.length === 0) throw new ApiFailure('INVALID_REQUEST', undefined, 'homework_subject_not_in_class')
        }
        assertDueOn(body.dueOn, today, section.year_end)

        const inserted = await conn.client.query<{ id: string }>(
          `INSERT INTO homework (school_id, academic_year_id, section_id, subject_id, title, instructions, set_on, due_on,
                                 created_by_membership_id, created_by_staff_id, updated_by_membership_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $9) RETURNING id`,
          [
            schoolId,
            section.academic_year_id,
            section.id,
            subjectId,
            body.title,
            body.instructions ?? '',
            today,
            body.dueOn,
            context.membershipId,
            await staffOf(conn, schoolId, context.membershipId),
          ],
        )
        const homeworkId = requireFound(inserted.rows[0]).id

        // The decision on the new row, through the caller's own plan. The
        // refusal rolls the insert back.
        const plans = await homeworkWritePlans(conn, context, 'homework.set')
        if (!(await itemMatches(conn, schoolId, homeworkId, plans.items))) throw new ApiFailure('ACCESS_DENIED')

        await writeAudit(conn, context, {
          action: 'homework.set',
          targetType: 'homework',
          targetId: homeworkId,
          summary: 'Set homework.',
          safeChanges: {
            academicYearId: section.academic_year_id,
            sectionId: section.id,
            subjectId,
            general: subjectId === null,
            setOn: today,
            dueOn: body.dueOn,
          },
        })
        return readHomeworkDetail(conn, context, homeworkId)
      }),
  })

  protectedRoute(app, deps, {
    method: 'PATCH',
    path: ONE,
    permission: 'homework.set',
    body: HomeworkUpdateRequest,
    response: HomeworkDetail,
    handler: async ({ context, body, param }) => {
      const homeworkId = assertUuidParam(param('homeworkId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const schoolId = context.schoolId
        await lockSchool(conn, schoolId)
        await decideHomework(conn, context, 'homework.set', homeworkId)
        const row = await readItemRow(conn, schoolId, homeworkId, { forUpdate: true })
        assertNotRemoved(row)
        assertVersion(body.expectedVersion, row.version)
        if (body.dueOn !== undefined) assertDueOn(body.dueOn, row.set_on, row.year_end)

        const set: Record<string, unknown> = { updated_by_membership_id: context.membershipId }
        const changed: string[] = []
        if (body.title !== undefined) {
          set.title = body.title
          changed.push('title')
        }
        if (body.instructions !== undefined) {
          set.instructions = body.instructions
          changed.push('instructions')
        }
        if (body.dueOn !== undefined) {
          set.due_on = body.dueOn
          changed.push('dueOn')
        }
        await bumpVersion(conn, 'homework', { schoolId, id: homeworkId, expectedVersion: body.expectedVersion, set })
        await writeAudit(conn, context, {
          action: 'homework.set',
          targetType: 'homework',
          targetId: homeworkId,
          summary: 'Changed homework.',
          safeChanges: {
            sectionId: row.section_id,
            subjectId: row.subject_id,
            changed,
            ...(body.dueOn !== undefined && body.dueOn !== row.due_on
              ? { dueOn: body.dueOn, previousDueOn: row.due_on }
              : {}),
          },
        })
        return readHomeworkDetail(conn, context, homeworkId)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: `${ONE}/remove`,
    permission: 'homework.set',
    body: HomeworkRemoveRequest,
    response: HomeworkDetail,
    handler: async ({ context, body, param }) => {
      const homeworkId = assertUuidParam(param('homeworkId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const schoolId = context.schoolId
        await lockSchool(conn, schoolId)
        await decideHomework(conn, context, 'homework.set', homeworkId)
        const row = await readItemRow(conn, schoolId, homeworkId, { forUpdate: true })
        assertNotRemoved(row)
        assertVersion(body.expectedVersion, row.version)
        await bumpVersion(conn, 'homework', {
          schoolId,
          id: homeworkId,
          expectedVersion: body.expectedVersion,
          set: { removed_at: context.now, removed_by_membership_id: context.membershipId },
        })
        await writeAudit(conn, context, {
          action: 'homework.set',
          targetType: 'homework',
          targetId: homeworkId,
          summary: 'Removed homework.',
          safeChanges: { sectionId: row.section_id, subjectId: row.subject_id, removed: true, dueOn: row.due_on },
          ...(body.reason === undefined ? {} : { note: body.reason }),
        })
        return readHomeworkDetail(conn, context, homeworkId)
      })
    },
  })
}
