import type { FastifyInstance } from 'fastify'
import { sql, type SQL } from 'drizzle-orm'
import {
  HOMEWORK_NOT_DONE_THRESHOLD,
  HomeworkExportJob,
  HomeworkReportExportRequest,
  HomeworkReportRequest,
  HomeworkReportResponse,
  type PermissionKey,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import { insertExportJob } from '../../exports/jobs.ts'
import { createAndMaybeProduce } from '../../exports/run.ts'
import { decideSchoolAction, protectedRoute, type ModuleDependencies } from '../shared/index.ts'
import {
  EXPORT,
  homeworkReadPlans,
  homeworkWritePlans,
  pupilName,
  schoolToday,
  type HomeworkConnection,
} from './common.ts'

/**
 * The office's report, gated by homework.check so a teacher sees it for
 * their own scope: the items due in a range per section and subject with the
 * check-offs over their rosters, and the pupils with
 * HOMEWORK_NOT_DONE_THRESHOLD or more Not done in that range. Everything is
 * narrowed by the caller's homework.check plan (the items and check-offs) and
 * their homework.read plan (the pupils they may name). Removed items are left
 * out. The Excel file (homework_report) is produced from the same function.
 */

const REPORT_MAX_ROWS = 2000

interface SetRow extends Record<string, unknown> {
  section_id: string
  section_name: string
  grade_id: string
  grade_name: string
  subject_id: string | null
  subject_name: string | null
  items: number
  done: number
  partly_done: number
  not_done: number
  not_checked: number
}

interface PupilRow extends Record<string, unknown> {
  id: string
  first_name: string
  last_name: string | null
  admission_number: string
  roll_number: number | null
  section_id: string
  section_name: string
  grade_id: string
  grade_name: string
  not_done: number
  checked: number
}

function reportWhere(query: HomeworkReportRequest): SQL {
  const parts: SQL[] = [
    sql`homework.removed_at IS NULL`,
    sql`homework.due_on >= ${query.from}::date`,
    sql`homework.due_on <= ${query.to}::date`,
  ]
  if (query.academicYearId !== undefined) parts.push(sql`homework.academic_year_id = ${query.academicYearId}::uuid`)
  if (query.sectionId !== undefined) parts.push(sql`homework.section_id = ${query.sectionId}::uuid`)
  if (query.subjectId !== undefined) parts.push(sql`homework.subject_id = ${query.subjectId}::uuid`)
  if (query.general === 'true') parts.push(sql`homework.subject_id IS NULL`)
  if (query.general === 'false') parts.push(sql`homework.subject_id IS NOT NULL`)
  return sql.join(parts, sql` AND `)
}

/** The report as the caller may see it. Shared by the screen and the export producer. */
export async function readHomeworkReport(
  conn: HomeworkConnection,
  context: RequestContext,
  query: HomeworkReportRequest,
): Promise<HomeworkReportResponse> {
  const schoolId = context.schoolId
  const today = await schoolToday(conn, schoolId)
  const read = await homeworkReadPlans(conn, context)
  const check = await homeworkWritePlans(conn, context, 'homework.check')
  const where = reportWhere(query)

  const sets = await conn.db.execute<SetRow>(
    sql`SELECT homework.section_id, sec.name AS section_name, g.id AS grade_id, g.name AS grade_name,
               homework.subject_id, sub.name AS subject_name,
               count(*)::int AS items,
               COALESCE(sum(r.done), 0)::int AS done,
               COALESCE(sum(r.partly_done), 0)::int AS partly_done,
               COALESCE(sum(r.not_done), 0)::int AS not_done,
               -- Nobody is behind on an item that is not due yet.
               COALESCE(sum(CASE WHEN homework.due_on <= ${today}::date
                                 THEN r.pupils - r.done - r.partly_done - r.not_done ELSE 0 END), 0)::int AS not_checked
          FROM homework
          JOIN sections sec ON sec.school_id = homework.school_id AND sec.id = homework.section_id
          JOIN grades g ON g.school_id = sec.school_id AND g.id = sec.grade_id
          LEFT JOIN subjects sub ON sub.school_id = homework.school_id AND sub.id = homework.subject_id
          CROSS JOIN LATERAL (
            SELECT count(DISTINCT roster.id)::int AS pupils,
                   count(DISTINCT roster.id) FILTER (WHERE homework_checks.status = 'done')::int AS done,
                   count(DISTINCT roster.id) FILTER (WHERE homework_checks.status = 'partly_done')::int AS partly_done,
                   count(DISTINCT roster.id) FILTER (WHERE homework_checks.status = 'not_done')::int AS not_done
              FROM (SELECT students.id
                      FROM enrollments en
                      JOIN students ON students.school_id = en.school_id AND students.id = en.student_id
                     WHERE en.school_id = homework.school_id AND en.section_id = homework.section_id
                       AND en.academic_year_id = homework.academic_year_id
                       AND en.joined_on <= homework.due_on AND (en.left_on IS NULL OR en.left_on >= homework.due_on)
                       AND (${read.staffPupils})) roster
              LEFT JOIN homework_checks ON homework_checks.school_id = homework.school_id
                   AND homework_checks.homework_id = homework.id AND homework_checks.student_id = roster.id
                   AND (${check.checks})
          ) r
         WHERE homework.school_id = ${schoolId}::uuid
           AND (${check.items})
           AND ${where}
         GROUP BY homework.section_id, sec.name, g.id, g.name, g.sort_order, homework.subject_id, sub.name
         ORDER BY g.sort_order, g.name, sec.name, sub.name NULLS FIRST, homework.section_id
         LIMIT ${REPORT_MAX_ROWS}`,
  )

  const pupils = await conn.db.execute<PupilRow>(
    sql`SELECT students.id, students.first_name, students.last_name, students.admission_number,
               (SELECT min(en.roll_number) FROM enrollments en
                 WHERE en.school_id = homework_checks.school_id AND en.student_id = students.id
                   AND en.section_id = homework_checks.section_id) AS roll_number,
               homework_checks.section_id, sec.name AS section_name, g.id AS grade_id, g.name AS grade_name,
               count(*) FILTER (WHERE homework_checks.status = 'not_done')::int AS not_done,
               count(*)::int AS checked
          FROM homework_checks
          JOIN homework ON homework.school_id = homework_checks.school_id AND homework.id = homework_checks.homework_id
          JOIN students ON students.school_id = homework_checks.school_id AND students.id = homework_checks.student_id
          JOIN sections sec ON sec.school_id = homework_checks.school_id AND sec.id = homework_checks.section_id
          JOIN grades g ON g.school_id = sec.school_id AND g.id = sec.grade_id
         WHERE homework_checks.school_id = ${schoolId}::uuid
           AND (${check.checks})
           AND (${check.items})
           AND (${read.staffPupils})
           AND ${where}
         GROUP BY students.id, students.first_name, students.last_name, students.admission_number,
                  homework_checks.school_id, homework_checks.section_id, sec.name, g.id, g.name
        HAVING count(*) FILTER (WHERE homework_checks.status = 'not_done') >= ${HOMEWORK_NOT_DONE_THRESHOLD}
         ORDER BY not_done DESC, g.name, sec.name, students.first_name, students.id
         LIMIT ${REPORT_MAX_ROWS}`,
  )

  const allowedActions: PermissionKey[] = (await decideSchoolAction(conn, context, EXPORT)).allowed ? [EXPORT] : []
  return {
    from: query.from,
    to: query.to,
    threshold: HOMEWORK_NOT_DONE_THRESHOLD,
    sets: sets.rows.map((row) => ({
      section: { id: row.section_id, name: row.section_name },
      grade: { id: row.grade_id, name: row.grade_name },
      ...(row.subject_id !== null && row.subject_name !== null
        ? { subject: { id: row.subject_id, name: row.subject_name } }
        : {}),
      items: Number(row.items),
      done: Number(row.done),
      partlyDone: Number(row.partly_done),
      notDone: Number(row.not_done),
      notChecked: Math.max(0, Number(row.not_checked)),
    })),
    repeatedNotDone: pupils.rows.map((row) => ({
      student: {
        id: row.id,
        name: pupilName(row.first_name, row.last_name),
        admissionNumber: row.admission_number,
        ...(row.roll_number === null || Number(row.roll_number) <= 0 ? {} : { rollNumber: Number(row.roll_number) }),
      },
      section: { id: row.section_id, name: row.section_name },
      grade: { id: row.grade_id, name: row.grade_name },
      notDone: Number(row.not_done),
      checked: Number(row.checked),
    })),
    allowedActions,
  }
}

export function registerHomeworkReportRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/homework/report',
    permission: 'homework.check',
    query: HomeworkReportRequest,
    response: HomeworkReportResponse,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, (conn) => readHomeworkReport(conn, context, query)),
  })

  // The same report as a spreadsheet. The route decides that this caller may
  // ask for the file (homework.export, the office's) and counts the rows the
  // same reader gives them now; the producer reads every row again under the
  // requester's own plans when it makes the bytes.
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/homework/report/export',
    permission: 'homework.export',
    body: HomeworkReportExportRequest,
    response: HomeworkExportJob,
    successStatus: 202,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const counted = await readHomeworkReport(conn, context, body)
        const rows = counted.sets.length + counted.repeatedNotDone.length
        const criteria = {
          from: body.from,
          to: body.to,
          ...(body.academicYearId === undefined ? {} : { academicYearId: body.academicYearId }),
          ...(body.sectionId === undefined ? {} : { sectionId: body.sectionId }),
          ...(body.subjectId === undefined ? {} : { subjectId: body.subjectId }),
          ...(body.general === undefined ? {} : { general: body.general }),
        }
        const jobId = await insertExportJob(conn, context, {
          kind: 'homework_report',
          permission: 'homework.export',
          criteria,
          summary: 'Requested the homework report as a file.',
          safeChanges: { ...criteria, rows },
        })
        return createAndMaybeProduce(deps, conn, context, { id: jobId, estimatedRows: rows })
      }),
  })
}
