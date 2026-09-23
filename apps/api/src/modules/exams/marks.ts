import type { FastifyInstance } from 'fastify'
import {
  EXAM_PATTERN,
  ExamMarkHistory,
  ExamMarkHistoryRequest,
  ExamMarksCorrectionRequest,
  ExamMarksSaveRequest,
  ExamPapersRequest,
  ExamPapersResponse,
  ExamSheet,
  markFitsComponent,
  type ExamMarkLine,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import {
  ApiFailure,
  assertUuidParam,
  lockSchool,
  protectedRoute,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import {
  cellKey,
  decideExam,
  examPlans,
  examState,
  insertMark,
  publicationState,
  readPaper,
  rosterOn,
  sameValue,
  schoolToday,
  storedMarks,
  type ExamConnection,
  type PaperRow,
  type StoredMark,
} from './common.ts'
import { listPapers, readMarkHistory, readSheet } from './reads.ts'

/**
 * Papers: the caller's list, one marks sheet, the whole-sheet save, the
 * office's correction and one cell's history.
 *
 * Nothing here is ever edited. A save is a new row per cell whose value
 * changed, pointing at the row it supersedes, and the current mark is always
 * the highest revision of that cell. Every line of a body is checked before
 * the first row is written, so a refused request writes nothing.
 */

/** A line that is about to be written, with the stored row it supersedes. */
interface PlannedMark {
  readonly line: ExamMarkLine
  readonly current: StoredMark | undefined
}

/**
 * Checks every line of a body against the paper and its roster, and works out
 * which cells change. Nothing is written here.
 */
async function planMarks(
  conn: ExamConnection,
  context: RequestContext,
  paper: PaperRow,
  lines: readonly ExamMarkLine[],
  permission: 'exams.record_marks' | 'exams.manage',
): Promise<{ pupils: number; firstSaves: PlannedMark[]; changes: PlannedMark[] }> {
  const plans = await examPlans(conn, context, permission)
  const roster = await rosterOn(conn, context.schoolId, paper.section_id, paper.starts_on, plans.pupils)
  const onRoll = new Set(roster.map((pupil) => pupil.id))
  const components: readonly string[] = EXAM_PATTERN[paper.kind].components
  for (const line of lines) {
    if (!onRoll.has(line.studentId)) throw new ApiFailure('INVALID_REQUEST', undefined, 'exam_pupil_not_on_roster')
    if (!components.includes(line.component)) {
      throw new ApiFailure('INVALID_REQUEST', undefined, 'exam_component_not_in_exam')
    }
    if (!markFitsComponent(line.component, line.value)) {
      throw new ApiFailure('INVALID_REQUEST', undefined, 'exam_mark_above_maximum')
    }
  }

  const stored = await storedMarks(conn, context.schoolId, paper.id)
  const firstSaves: PlannedMark[] = []
  const changes: PlannedMark[] = []
  for (const line of lines) {
    const current = stored.get(cellKey(line.studentId, line.component))
    if (current === undefined) firstSaves.push({ line, current })
    else if (!sameValue(current, line.value)) changes.push({ line, current })
  }
  return { pupils: roster.length, firstSaves, changes }
}

export function registerExamMarksRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/exams/papers',
    permission: 'exams.read',
    query: ExamPapersRequest,
    response: ExamPapersResponse,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => listPapers(conn, context, query)),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/exams/papers/:paperId',
    permission: 'exams.read',
    response: ExamSheet,
    handler: async ({ context, param }) => {
      const paperId = assertUuidParam(param('paperId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await decideExam(conn, context, 'exams.read', paperId)
        return readSheet(conn, context, paperId)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/exams/papers/:paperId/marks',
    permission: 'exams.record_marks',
    body: ExamMarksSaveRequest,
    response: ExamSheet,
    handler: async ({ context, body, param }) => {
      const paperId = assertUuidParam(param('paperId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await decideExam(conn, context, 'exams.record_marks', paperId)
        const paper = await readPaper(conn, context.schoolId, paperId)
        const state = examState(paper, await schoolToday(conn, context.schoolId))
        if (state === 'not_started') throw new ApiFailure('INVALID_REQUEST', undefined, 'exam_not_started')
        // After the re-check deadline a change is the office's, with a reason.
        if (state === 'locked') throw new ApiFailure('INVALID_REQUEST', undefined, 'exam_recheck_deadline_passed')

        const planned = await planMarks(conn, context, paper, body.entries, 'exams.record_marks')
        if (planned.changes.length > 0 && body.change === undefined) {
          throw new ApiFailure('INVALID_REQUEST', undefined, 'exam_change_needs_reason')
        }

        for (const { line, current } of planned.firstSaves) {
          await insertMarkFor(conn, context, paper, line, 'entry', null, current)
        }
        for (const { line, current } of planned.changes) {
          await insertMarkFor(conn, context, paper, line, 'entry', body.change?.reasonKind ?? null, current)
        }

        const changed = planned.changes.length
        await writeAudit(conn, context, {
          action: 'exams.record_marks',
          targetType: 'exam_paper',
          targetId: paperId,
          summary: 'Saved marks for a paper.',
          safeChanges: {
            paperId,
            examId: paper.exam_id,
            sectionId: paper.section_id,
            subjectId: paper.subject_id,
            pupils: planned.pupils,
            entered: planned.firstSaves.length,
            changed,
            ...(changed > 0 && body.change !== undefined ? { reasonKind: body.change.reasonKind } : {}),
          },
          // What somebody typed lives in the note, which can be redacted.
          ...(changed > 0 && body.change !== undefined ? { note: body.change.reason } : {}),
        })
        return readSheet(conn, context, paperId)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/exams/papers/:paperId/corrections',
    permission: 'exams.manage',
    body: ExamMarksCorrectionRequest,
    response: ExamSheet,
    successStatus: 201,
    handler: async ({ context, body, param }) => {
      const paperId = assertUuidParam(param('paperId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await decideExam(conn, context, 'exams.manage', paperId)
        const paper = await readPaper(conn, context.schoolId, paperId)
        const state = examState(paper, await schoolToday(conn, context.schoolId))
        if (state === 'not_started') throw new ApiFailure('INVALID_REQUEST', undefined, 'exam_not_started')

        const planned = await planMarks(conn, context, paper, body.entries, 'exams.manage')
        // A first fill by the office is a correction too: it always has a reason.
        const corrections = [...planned.firstSaves, ...planned.changes]
        if (corrections.length === 0) return readSheet(conn, context, paperId)

        const published = await publicationState(conn, context.schoolId, paper.exam_id, paper.section_id)
        for (const { line, current } of corrections) {
          await insertMarkFor(conn, context, paper, line, 'correction', body.reasonKind, current)
        }
        await writeAudit(conn, context, {
          action: 'exams.manage',
          targetType: 'exam_paper',
          targetId: paperId,
          summary: 'Corrected marks on a paper.',
          safeChanges: {
            paperId,
            examId: paper.exam_id,
            sectionId: paper.section_id,
            subjectId: paper.subject_id,
            corrected: corrections.length,
            reasonKind: body.reasonKind,
            afterPublication: published !== null,
          },
          note: body.reason,
        })
        return readSheet(conn, context, paperId)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/exams/papers/:paperId/students/:studentId/history',
    permission: 'exams.read',
    query: ExamMarkHistoryRequest,
    response: ExamMarkHistory,
    handler: async ({ context, query, param }) => {
      const paperId = assertUuidParam(param('paperId'))
      const studentId = assertUuidParam(param('studentId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await decideExam(conn, context, 'exams.read', paperId)
        return readMarkHistory(conn, context, paperId, studentId, query.component)
      })
    },
  })
}

/** One line of a body, appended through the one writer of marks. */
async function insertMarkFor(
  conn: ExamConnection,
  context: RequestContext,
  paper: PaperRow,
  line: ExamMarkLine,
  kind: 'entry' | 'correction',
  reasonKind: 'recheck' | 'entry_error' | 'other' | null,
  current: StoredMark | undefined,
): Promise<void> {
  await insertMark(conn, context, {
    paper,
    studentId: line.studentId,
    component: line.component,
    value: line.value,
    kind,
    reasonKind,
    current,
  })
}
