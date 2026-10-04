import type { FastifyInstance } from 'fastify'
import { HomeworkCheckSaveRequest, HomeworkCheckSheet, type HomeworkCheckStatus } from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import {
  ApiFailure,
  assertUuidParam,
  bumpVersion,
  lockSchool,
  protectedRoute,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import {
  assertNotRemoved,
  assertWindowOpen,
  checkWindow,
  decideHomework,
  homeworkWritePlans,
  itemMatches,
  readItemRow,
  schoolToday,
  teacherClosesOn,
  type HomeworkConnection,
} from './common.ts'
import { readCheckSheet } from './reads.ts'

/**
 * The check-off sheet: the pupils enrolled in the item's section on its due
 * date, each marked done, partly done or not done with an optional remark.
 *
 * Check-offs open on the due date. A teacher may change them until
 * HOMEWORK_TEACHER_CHECK_DAYS after it; the office, reached through the
 * school-wide grant of the homework.check plan, at any time. A save is the
 * changed lines of the sheet: every line is checked (the pupil on the roster,
 * the version the writer read) before the first row is written, so a refused
 * save writes nothing, and the save is one audit row for the item. A line is
 * never un-checked.
 */

const SHEET = '/api/schools/:schoolId/homework/:homeworkId/checks'

interface StoredCheck {
  id: string
  version: number
  status: HomeworkCheckStatus
  remark: string | null
}

/** Every pupil enrolled in the item's section on its due date, read school-wide after the decision. */
async function rosterIds(conn: HomeworkConnection, schoolId: string, homeworkId: string): Promise<Set<string>> {
  const rows = await conn.client.query<{ student_id: string }>(
    `SELECT DISTINCT en.student_id
       FROM homework
       JOIN enrollments en ON en.school_id = homework.school_id AND en.section_id = homework.section_id
        AND en.academic_year_id = homework.academic_year_id
        AND en.joined_on <= homework.due_on AND (en.left_on IS NULL OR en.left_on >= homework.due_on)
      WHERE homework.school_id = $1 AND homework.id = $2`,
    [schoolId, homeworkId],
  )
  return new Set(rows.rows.map((row) => row.student_id))
}

/** The stored check-offs of the item, by pupil, read school-wide for a write after the decision. */
async function storedChecks(
  conn: HomeworkConnection,
  schoolId: string,
  homeworkId: string,
): Promise<Map<string, StoredCheck>> {
  const rows = await conn.client.query<StoredCheck & { student_id: string }>(
    `SELECT id, student_id, version, status, remark FROM homework_checks
      WHERE school_id = $1 AND homework_id = $2 FOR UPDATE`,
    [schoolId, homeworkId],
  )
  return new Map(rows.rows.map((row) => [row.student_id, { ...row, version: Number(row.version) }]))
}

export function registerHomeworkCheckRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: SHEET,
    permission: 'homework.read',
    response: HomeworkCheckSheet,
    handler: async ({ context, param }) => {
      const homeworkId = assertUuidParam(param('homeworkId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await decideHomework(conn, context, 'homework.read', homeworkId)
        return readCheckSheet(conn, context, homeworkId)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: SHEET,
    permission: 'homework.check',
    body: HomeworkCheckSaveRequest,
    response: HomeworkCheckSheet,
    handler: async ({ context, body, param }) => {
      const homeworkId = assertUuidParam(param('homeworkId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const schoolId = context.schoolId
        await lockSchool(conn, schoolId)
        await decideHomework(conn, context, 'homework.check', homeworkId)
        const row = await readItemRow(conn, schoolId, homeworkId, { forUpdate: true })
        assertNotRemoved(row)
        const today = await schoolToday(conn, schoolId)
        const office = await itemMatches(
          conn,
          schoolId,
          homeworkId,
          (await homeworkWritePlans(conn, context, 'homework.check')).office,
        )
        assertWindowOpen(checkWindow({ dueOn: row.due_on, today, removed: false, mayCheck: true, office }))

        const roster = await rosterIds(conn, schoolId, homeworkId)
        for (const line of body.entries) {
          if (!roster.has(line.studentId)) {
            throw new ApiFailure('INVALID_REQUEST', undefined, 'homework_pupil_not_on_roster')
          }
        }
        const stored = await storedChecks(conn, schoolId, homeworkId)
        // A line written from a check-off that has moved since refuses the whole save.
        for (const line of body.entries) {
          if ((stored.get(line.studentId)?.version ?? 0) !== line.expectedVersion) {
            throw new ApiFailure('VERSION_CONFLICT')
          }
        }

        let checked = 0
        let changed = 0
        const remarks: string[] = []
        const tally: Record<HomeworkCheckStatus, number> = { done: 0, partly_done: 0, not_done: 0 }
        for (const line of body.entries) {
          const current = stored.get(line.studentId)
          const remark = line.remark === undefined ? (current?.remark ?? null) : line.remark
          if (current === undefined) {
            await conn.client.query(
              `INSERT INTO homework_checks (school_id, homework_id, student_id, academic_year_id, section_id, subject_id,
                                            status, remark, checked_by_membership_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                schoolId,
                homeworkId,
                line.studentId,
                row.academic_year_id,
                row.section_id,
                row.subject_id,
                line.status,
                remark,
                context.membershipId,
              ],
            )
            checked += 1
          } else if (current.status !== line.status || current.remark !== remark) {
            await bumpVersion(conn, 'homework_checks', {
              schoolId,
              id: current.id,
              expectedVersion: current.version,
              set: {
                status: line.status,
                remark,
                checked_by_membership_id: context.membershipId,
                checked_at: context.now,
              },
            })
            changed += 1
          } else {
            continue
          }
          tally[line.status] += 1
          if (remark !== null && remark !== (current?.remark ?? null)) remarks.push(remark)
        }

        if (checked + changed > 0) {
          await writeAudit(conn, context, {
            action: 'homework.check',
            targetType: 'homework',
            targetId: homeworkId,
            summary: 'Checked off pupils for homework.',
            safeChanges: {
              sectionId: row.section_id,
              subjectId: row.subject_id,
              dueOn: row.due_on,
              pupils: roster.size,
              checked,
              changed,
              done: tally.done,
              partlyDone: tally.partly_done,
              notDone: tally.not_done,
              afterTeacherWindow: today > teacherClosesOn(row.due_on),
            },
            // What the teacher typed about the pupils lives in the note, which can be redacted.
            ...(remarks.length > 0 ? { note: remarks.join('\n') } : {}),
          })
        }
        return readCheckSheet(conn, context, homeworkId)
      })
    },
  })
}
