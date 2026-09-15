import type { FastifyInstance } from 'fastify'
import { and, eq, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  AuthorizedSectionCounts,
  Section,
  SectionDetail,
  SectionInput,
  SectionList,
  SetupSectionListQuery,
  SetupSectionStrengthsQuery,
  SetupSectionUpdateRequest,
} from '@erp/contracts'
import { planPredicate } from '@erp/authz'
import { sections } from '@erp/db/schema'
import { withTenantTransaction } from '@erp/db'
import { protectedRoute, type ModuleDependencies } from '../shared/route.ts'
import { authorizeSchoolAction, readPlan } from '../shared/authorize.ts'
import { lockSchool, writeAudit } from '../shared/audit.ts'
import { bumpVersion } from '../shared/version.ts'
import { ApiFailure, requireFound } from '../shared/errors.ts'
import {
  optional,
  refuseWhenReferenced,
  requireQueryUuid,
  requireReference,
  requireUuid,
  scopedTable,
} from './common.ts'

type SectionResponse = z.infer<typeof Section>

const columns = {
  id: sections.id,
  schoolId: sections.schoolId,
  gradeId: sections.gradeId,
  academicYearId: sections.academicYearId,
  name: sections.name,
  classTeacherId: sections.classTeacherStaffId,
  roomNumber: sections.roomNumber,
  capacity: sections.capacity,
  version: sections.version,
}

interface SectionRow {
  id: string
  schoolId: string
  gradeId: string
  academicYearId: string
  name: string
  classTeacherId: string | null
  roomNumber: string | null
  capacity: number | null
  version: number
}

function toSection(row: SectionRow): SectionResponse {
  return {
    id: row.id,
    schoolId: row.schoolId,
    gradeId: row.gradeId,
    academicYearId: row.academicYearId,
    name: row.name,
    ...optional('classTeacherId', row.classTeacherId),
    ...optional('roomNumber', row.roomNumber),
    ...optional('capacity', row.capacity),
    version: row.version,
  } as SectionResponse
}

/** Everything that would be orphaned by removing a section. */
const SECTION_REFERENCES = [
  { table: 'enrollments', column: 'section_id' },
  { table: 'teaching_assignments', column: 'section_id' },
  { table: 'timetable_entries', column: 'section_id' },
  { table: 'substitutions', column: 'section_id' },
  { table: 'resource_access_rules', column: 'section_id' },
] as const

/** The grade, year and class teacher a body names must all be ours. */
async function checkReferences(
  conn: Parameters<typeof requireReference>[0],
  schoolId: string,
  body: z.infer<typeof SectionInput>,
): Promise<void> {
  await requireReference(conn, 'grades', schoolId, body.gradeId)
  await requireReference(conn, 'academic_years', schoolId, body.academicYearId)
  if (body.classTeacherId) await requireReference(conn, 'staff', schoolId, body.classTeacherId)
}

export function registerSectionRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/sections',
    permission: 'sections.read',
    query: SetupSectionListQuery,
    response: SectionList,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const plan = await readPlan(conn, context, 'sections.read', 'section')
        const filters: SQL[] = [planPredicate(plan, scopedTable('section'))]
        if (query.academicYearId) {
          filters.push(eq(sections.academicYearId, requireQueryUuid(query.academicYearId)))
        }
        if (query.gradeId) filters.push(eq(sections.gradeId, requireQueryUuid(query.gradeId)))
        const rows = await conn.db
          .select(columns)
          .from(sections)
          .where(and(...filters))
          .orderBy(sections.name)
        return rows.map(toSection)
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/sections/strengths',
    permission: 'sections.read_strengths',
    query: SetupSectionStrengthsQuery,
    response: AuthorizedSectionCounts,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const plan = await readPlan(conn, context, 'sections.read_strengths', 'section')
        // Only sections the plan allows are counted, and only pupils who have
        // not left them, so a count never describes a class the caller may not
        // open.
        const rows = await conn.db
          .select({
            sectionId: sections.id,
            // Written out in full: a column reference in a select list is
            // rendered unqualified, which a correlated subquery would resolve
            // against its own table instead of this one.
            count: sql<number>`(SELECT count(*)::int FROM enrollments e
                WHERE e.school_id = sections.school_id AND e.section_id = sections.id
                  AND e.academic_year_id = sections.academic_year_id AND e.left_on IS NULL)`,
          })
          .from(sections)
          .where(
            and(
              planPredicate(plan, scopedTable('section')),
              eq(sections.academicYearId, requireQueryUuid(query.academicYearId)),
            ),
          )
          .orderBy(sections.id)
        return rows.map((row) => ({ sectionId: row.sectionId, count: Number(row.count) }))
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/sections/:sectionId',
    permission: 'sections.read',
    response: SectionDetail,
    handler: async ({ context, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const id = requireUuid(param('sectionId'))
        const plan = await readPlan(conn, context, 'sections.read', 'section')
        const rows = await conn.db
          .select(columns)
          .from(sections)
          .where(and(planPredicate(plan, scopedTable('section')), eq(sections.id, id)))
          .limit(1)
        return toSection(requireFound(rows[0]))
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/sections',
    permission: 'sections.manage',
    body: SectionInput,
    response: Section,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'sections.manage')
        await checkReferences(conn, context.schoolId, body)
        const duplicate = await conn.client.query(
          `SELECT 1 FROM sections
            WHERE school_id = $1 AND academic_year_id = $2 AND grade_id = $3 AND name = $4`,
          [context.schoolId, body.academicYearId, body.gradeId, body.name],
        )
        if (duplicate.rowCount !== null && duplicate.rowCount > 0) throw new ApiFailure('INVALID_REQUEST')

        const inserted = await conn.client.query<{ id: string }>(
          `INSERT INTO sections(school_id, grade_id, academic_year_id, name,
                                class_teacher_staff_id, room_number, capacity)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            context.schoolId,
            body.gradeId,
            body.academicYearId,
            body.name,
            body.classTeacherId ?? null,
            body.roomNumber ?? null,
            body.capacity ?? null,
          ],
        )
        const id = requireFound(inserted.rows[0]).id
        await writeAudit(conn, context, {
          action: 'sections.manage',
          targetType: 'section',
          targetId: id,
          summary: 'Created a section.',
        })
        const rows = await conn.db.select(columns).from(sections).where(eq(sections.id, id)).limit(1)
        return toSection(requireFound(rows[0]))
      }),
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/sections/:sectionId',
    permission: 'sections.manage',
    body: SetupSectionUpdateRequest,
    response: Section,
    handler: async ({ context, body, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const id = requireUuid(param('sectionId'))
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'sections.manage')
        await checkReferences(conn, context.schoolId, body)
        const clash = await conn.client.query(
          `SELECT 1 FROM sections
            WHERE school_id = $1 AND academic_year_id = $2 AND grade_id = $3 AND name = $4 AND id <> $5`,
          [context.schoolId, body.academicYearId, body.gradeId, body.name, id],
        )
        if (clash.rowCount !== null && clash.rowCount > 0) throw new ApiFailure('INVALID_REQUEST')
        // A section that already holds pupils cannot be moved to another year
        // or class, because their enrollments name the pair it had.
        const moved = await conn.client.query(
          `SELECT 1 FROM sections
            WHERE school_id = $1 AND id = $2 AND (academic_year_id <> $3 OR grade_id <> $4)`,
          [context.schoolId, id, body.academicYearId, body.gradeId],
        )
        if (moved.rowCount !== null && moved.rowCount > 0) {
          await refuseWhenReferenced(conn, context.schoolId, SECTION_REFERENCES, id)
        }

        await bumpVersion(conn, 'sections', {
          schoolId: context.schoolId,
          id,
          expectedVersion: body.expectedVersion,
          set: {
            grade_id: body.gradeId,
            academic_year_id: body.academicYearId,
            name: body.name,
            class_teacher_staff_id: body.classTeacherId ?? null,
            room_number: body.roomNumber ?? null,
            capacity: body.capacity ?? null,
          },
        })
        await writeAudit(conn, context, {
          action: 'sections.manage',
          targetType: 'section',
          targetId: id,
          summary: 'Updated a section.',
        })
        const rows = await conn.db.select(columns).from(sections).where(eq(sections.id, id)).limit(1)
        return toSection(requireFound(rows[0]))
      }),
  })

  protectedRoute(app, deps, {
    method: 'DELETE',
    path: '/api/schools/:schoolId/sections/:sectionId',
    permission: 'sections.manage',
    response: z.null(),
    successStatus: 204,
    handler: async ({ context, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const id = requireUuid(param('sectionId'))
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'sections.manage')
        const existing = await conn.client.query('SELECT 1 FROM sections WHERE school_id = $1 AND id = $2', [
          context.schoolId,
          id,
        ])
        if (existing.rowCount === 0) throw new ApiFailure('RESOURCE_NOT_FOUND')
        await refuseWhenReferenced(conn, context.schoolId, SECTION_REFERENCES, id)

        await conn.client.query('DELETE FROM sections WHERE school_id = $1 AND id = $2', [context.schoolId, id])
        await writeAudit(conn, context, {
          action: 'sections.manage',
          targetType: 'section',
          targetId: id,
          summary: 'Removed an empty section.',
        })
        return null
      }),
  })
}
