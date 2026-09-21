import type { AuthzConnection } from '@erp/authz'
import type { RequestContext } from '@erp/contracts/server'

/**
 * The kinds of file an export job can produce. Three are lists of records as a
 * spreadsheet, two are one record as a document, and the timetable is either,
 * chosen by the request.
 */
export type ExportJobKind =
  | 'students'
  | 'staff'
  | 'audit'
  | 'student_profile'
  | 'staff_profile'
  | 'timetable'

/** What a producer hands back. The bytes are never stored anywhere else. */
export interface ExportFile {
  readonly bytes: Uint8Array
  readonly contentType: string
  /** The name the person sees when the file lands. Server state, not input. */
  readonly fileName: string
  /** Rows in the file, for the job row; one for a single-record document. */
  readonly rowCount: number
}

/**
 * One producer per job kind. It runs inside the tenant transaction that owns
 * the job, so it must re-apply scope in SQL with planPredicate(readPlan(...),
 * scopedTableFor(...)): the access that justified the job is not evidence of
 * the access that produces it, and a list must contain a row only when the
 * same person's detail read would. Nothing is filtered in JavaScript, and a
 * field the requester may not read is never put in the file.
 */
export interface ExportProducer {
  readonly kind: ExportJobKind
  produce(
    conn: AuthzConnection,
    context: RequestContext,
    criteria: unknown,
  ): Promise<ExportFile>
}
