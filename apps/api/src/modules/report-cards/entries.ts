import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { withTenantTransaction } from '@erp/db'
import {
  ExamTerm,
  ReportCardEntriesResponse,
  ReportCardEntriesSaveRequest,
  TERM_PATTERN,
  type CoScholasticGrades,
  type ReportCardEntry,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import {
  allowedActionsFor,
  ApiFailure,
  assertUuidParam,
  bumpVersion,
  lockSchool,
  protectedRoute,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import {
  decideReportCard,
  pupilRef,
  readSection,
  reportCardPlans,
  rosterOn,
  schoolToday,
  type ExamConnection,
  type SectionRow,
} from '../exams/common.ts'
import { rosterDate } from './build.ts'

/**
 * The class teacher's co-scholastic grades and remarks, per pupil and term.
 *
 * The remarks are free text about a child. They are stored on the entry row
 * and nowhere else: never in an audit row's changes and never in its note.
 */

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`

/** The term from the path; anything else is a page that does not exist. */
function termParam(value: string): ExamTerm {
  const parsed = ExamTerm.safeParse(value)
  if (!parsed.success) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return parsed.data
}

/** The term's roster day: the first day of its main exam, or today clipped into the year. */
async function termRosterDate(
  conn: ExamConnection,
  schoolId: string,
  section: SectionRow,
  term: ExamTerm,
): Promise<string> {
  const today = await schoolToday(conn, schoolId)
  return rosterDate(conn, schoolId, section, TERM_PATTERN[term].mainExam, today)
}

interface EntryRow extends Record<string, unknown> {
  id: string
  student_id: string
  version: number
  work_education: 'A' | 'B' | 'C' | null
  art_education: 'A' | 'B' | 'C' | null
  health_physical_education: 'A' | 'B' | 'C' | null
  discipline: 'A' | 'B' | 'C' | null
  remarks: string | null
  updated_at: string
}

function toEntry(row: EntryRow): ReportCardEntry {
  return {
    id: row.id,
    version: Number(row.version),
    grades: {
      work_education: row.work_education,
      art_education: row.art_education,
      health_physical_education: row.health_physical_education,
      discipline: row.discipline,
    },
    remarks: row.remarks,
    updatedAt: row.updated_at,
  }
}

/** The term's roster with each pupil's entry, both under the caller's plans. */
export async function readReportCardEntries(
  conn: ExamConnection,
  context: RequestContext,
  sectionId: string,
  term: ExamTerm,
): Promise<ReportCardEntriesResponse> {
  const plans = await reportCardPlans(conn, context, 'report_cards.read')
  const section = await readSection(conn, context.schoolId, sectionId)
  const date = await termRosterDate(conn, context.schoolId, section, term)
  const roster = await rosterOn(conn, context.schoolId, sectionId, date, plans.pupils)
  const entries = await conn.db.execute<EntryRow>(
    sql`SELECT report_card_entries.id, report_card_entries.student_id, report_card_entries.version,
               report_card_entries.work_education, report_card_entries.art_education,
               report_card_entries.health_physical_education, report_card_entries.discipline,
               report_card_entries.remarks,
               to_char(report_card_entries.updated_at AT TIME ZONE 'UTC', ${sql.raw(ISO)}) AS updated_at
          FROM report_card_entries
         WHERE report_card_entries.school_id = ${context.schoolId}::uuid
           AND report_card_entries.section_id = ${sectionId}::uuid
           AND report_card_entries.term = ${term}
           AND (${plans.entries})`,
  )
  const byPupil = new Map(entries.rows.map((row) => [row.student_id, row]))
  const actions = await allowedActionsFor(conn, context, {
    schoolId: context.schoolId,
    resourceType: 'report_card',
    id: sectionId,
  })
  return {
    section: { id: section.id, name: section.name },
    grade: { id: section.grade_id, name: section.grade_name },
    academicYear: { id: section.academic_year_id, name: section.year_name },
    term,
    rows: roster.map((pupil) => {
      const row = byPupil.get(pupil.id)
      return { student: pupilRef(pupil), entry: row ? toEntry(row) : null }
    }),
    allowedActions: [...actions],
  }
}

function sameGrades(row: EntryRow, grades: CoScholasticGrades): boolean {
  return (
    row.work_education === grades.work_education &&
    row.art_education === grades.art_education &&
    row.health_physical_education === grades.health_physical_education &&
    row.discipline === grades.discipline
  )
}

export function registerReportCardEntryRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  const path = '/api/schools/:schoolId/report-cards/sections/:sectionId/terms/:term/entries'

  protectedRoute(app, deps, {
    method: 'GET',
    path,
    permission: 'report_cards.read',
    response: ReportCardEntriesResponse,
    handler: async ({ context, param }) => {
      const sectionId = assertUuidParam(param('sectionId'))
      const term = termParam(param('term'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // The roster face: the class teacher's own class, or the office.
        await decideReportCard(conn, context, 'report_cards.read', sectionId)
        return readReportCardEntries(conn, context, sectionId, term)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path,
    permission: 'report_cards.manage',
    body: ReportCardEntriesSaveRequest,
    response: ReportCardEntriesResponse,
    handler: async ({ context, param, body }) => {
      const sectionId = assertUuidParam(param('sectionId'))
      const term = termParam(param('term'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await decideReportCard(conn, context, 'report_cards.manage', sectionId)
        const section = await readSection(conn, context.schoolId, sectionId)
        const date = await termRosterDate(conn, context.schoolId, section, term)

        // Every pupil named must be on the term's roster, checked before any
        // write, so a refused save leaves nothing behind.
        const roster = new Set(
          (await rosterOn(conn, context.schoolId, sectionId, date, sql`TRUE`)).map((pupil) => pupil.id),
        )
        if (body.rows.some((row) => !roster.has(row.studentId))) {
          throw new ApiFailure('INVALID_REQUEST', undefined, 'report_card_pupil_not_on_roster')
        }

        const existing = await conn.client.query<EntryRow>(
          `SELECT id, student_id, version, work_education, art_education, health_physical_education,
                  discipline, remarks, updated_at::text AS updated_at
             FROM report_card_entries
            WHERE school_id = $1 AND section_id = $2 AND term = $3 AND student_id = ANY($4::uuid[])`,
          [context.schoolId, sectionId, term, body.rows.map((row) => row.studentId)],
        )
        const byPupil = new Map(existing.rows.map((row) => [row.student_id, row]))
        // Versions are checked for every row first, so a stale row refuses
        // the whole save before anything is written.
        for (const row of body.rows) {
          const current = byPupil.get(row.studentId)
          if (row.expectedVersion === 0 ? current !== undefined : current === undefined) {
            throw new ApiFailure('VERSION_CONFLICT')
          }
          if (current !== undefined && Number(current.version) !== row.expectedVersion) {
            throw new ApiFailure('VERSION_CONFLICT')
          }
        }

        let written = 0
        let remarksChanged = 0
        for (const row of body.rows) {
          const remarks = row.remarks === null || row.remarks === '' ? null : row.remarks
          const current = byPupil.get(row.studentId)
          if (current !== undefined && sameGrades(current, row.grades) && current.remarks === remarks) continue
          if ((current?.remarks ?? null) !== remarks) remarksChanged += 1
          written += 1
          if (current === undefined) {
            try {
              await conn.client.query(
                `INSERT INTO report_card_entries
                   (school_id, student_id, academic_year_id, section_id, term, work_education, art_education,
                    health_physical_education, discipline, remarks, updated_by_membership_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [
                  context.schoolId,
                  row.studentId,
                  section.academic_year_id,
                  sectionId,
                  term,
                  row.grades.work_education,
                  row.grades.art_education,
                  row.grades.health_physical_education,
                  row.grades.discipline,
                  remarks,
                  context.membershipId,
                ],
              )
            } catch (error) {
              if ((error as { code?: string }).code === '23505') throw new ApiFailure('VERSION_CONFLICT')
              throw error
            }
          } else {
            await bumpVersion(conn, 'report_card_entries', {
              schoolId: context.schoolId,
              id: current.id,
              expectedVersion: row.expectedVersion,
              set: {
                work_education: row.grades.work_education,
                art_education: row.grades.art_education,
                health_physical_education: row.grades.health_physical_education,
                discipline: row.grades.discipline,
                remarks,
                updated_by_membership_id: context.membershipId,
              },
            })
          }
        }

        // Counts only: the remarks themselves go nowhere but the entry row.
        await writeAudit(conn, context, {
          action: 'report_cards.manage',
          targetType: 'section',
          targetId: sectionId,
          summary: 'Saved co-scholastic grades and remarks.',
          safeChanges: {
            sectionId,
            academicYearId: section.academic_year_id,
            term,
            rows: written,
            remarksChanged,
          },
        })
        return readReportCardEntries(conn, context, sectionId, term)
      })
    },
  })
}
