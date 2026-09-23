import type { AuthzConnection } from '@erp/authz'
import type { RequestContext } from '@erp/contracts/server'
import type { DocumentStorage } from '../files/storage.ts'

/**
 * What the runner lends a producer besides the transaction: the private
 * document store, for a producer that prints a stored picture (the school
 * logo on a report card). A producer never writes to it.
 */
export interface ProducerIo {
  readonly documents: DocumentStorage
}

/**
 * The kinds of file an export job can produce. Three are lists of records as a
 * spreadsheet, four are one record as a document (two profiles, a fee receipt
 * and one pupil's month of attendance), and the timetable, the fee dues list,
 * the collection register and the two attendance registers are either, chosen
 * by the request. A paper's marks register is a spreadsheet; one report card
 * and a section's report cards are documents.
 */
export type ExportJobKind =
  | 'students'
  | 'staff'
  | 'audit'
  | 'student_profile'
  | 'staff_profile'
  | 'timetable'
  | 'fee_receipt'
  | 'fee_dues'
  | 'fee_collections'
  | 'attendance_register'
  | 'attendance_pupil_month'
  | 'staff_attendance_register'
  | 'exam_marks_register'
  | 'report_card'
  | 'report_cards_section'

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
    io?: ProducerIo,
  ): Promise<ExportFile>
}
