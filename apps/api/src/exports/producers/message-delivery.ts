import { z } from 'zod'
import type { AuthzConnection } from '@erp/authz'
import { FilesUuid, MESSAGE_KIND_LABELS, type EmailStatus, type RecipientOutcome } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { sql } from 'drizzle-orm'
import { ApiFailure } from '../../http/errors.ts'
import {
  decideMessage,
  guardianReadablePupils,
  isoOf,
  readablePupils,
  readableStaff,
  readsAsSender,
  recipientPlan,
  sectionLabels,
} from '../../modules/communication/shared-reads.ts'
import { exportFileName, fileNameDate } from '../naming.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile } from '../types.ts'
import { buildWorkbook, XLSX_CONTENT_TYPE, type ExportColumn } from '../xlsx.ts'

/** The job row says which message; everything else is read again now. */
const Criteria = z.object({ messageId: FilesUuid })

const OUTCOME_WORDS: Readonly<Record<RecipientOutcome, string>> = {
  delivered: 'Delivered',
  no_consent: 'No consent',
  not_receiving: 'Notifications off',
  no_contact: 'No contact',
}

const EMAIL_WORDS: Readonly<Record<EmailStatus, string>> = {
  none: 'Not sent',
  pending: 'Waiting',
  sent: 'Sent',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

type RecipientDbRow = {
  guardian_id: string | null
  staff_id: string | null
  student_id: string | null
  section_id: string | null
  outcome: RecipientOutcome
  in_app: boolean
  email_status: EmailStatus
  email_masked: string | null
  read_at: string | null
}

/** A moment as a school in India reads it: "05 Sep 2026, 14:30". */
function readAtWords(iso: string | null): string {
  if (iso === null) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date)
}

/**
 * One message's delivery record as a spreadsheet: a row per person it was
 * meant for, named by the same rules as the delivery list on screen (the
 * pupil under students.read_basic, the guardian and relation only where the
 * caller reads that pupil's guardian contacts, a staff member under
 * staff.read_directory). The message's own words are not in the file.
 */
async function produce(
  conn: AuthzConnection,
  context: RequestContext,
  criteria: unknown,
): Promise<ExportFile> {
  const parsed = Criteria.safeParse(criteria)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  const { messageId } = parsed.data
  // The message is decided again under the export key, and the delivery list
  // is only ever the author's or a reader's who reaches it other than as a
  // recipient, exactly as on screen.
  const message = await decideMessage(conn, context, 'communication.export', messageId)
  if (!(await readsAsSender(conn, context, message))) throw new ApiFailure('RESOURCE_NOT_FOUND')

  const predicate = await recipientPlan(conn, context)
  const result = await conn.db.execute<RecipientDbRow>(
    sql`SELECT message_recipients.guardian_id, message_recipients.staff_id, message_recipients.student_id,
               message_recipients.section_id, message_recipients.outcome, message_recipients.in_app,
               message_recipients.email_status, message_recipients.email_masked,
               ${sql.raw(isoOf('message_recipients.read_at'))} AS read_at
          FROM message_recipients
         WHERE ${predicate} AND message_recipients.message_id = ${messageId}::uuid
         ORDER BY message_recipients.created_at, message_recipients.id`,
  )
  const rows = [...result.rows]

  const studentIds = rows.flatMap((row) => (row.student_id ? [row.student_id] : []))
  const pupils = await readablePupils(conn, context, studentIds)
  const guardianReach = await guardianReadablePupils(conn, context, studentIds)
  const staffNames = await readableStaff(conn, context, rows.flatMap((row) => (row.staff_id ? [row.staff_id] : [])))
  const sections = await sectionLabels(conn, context.schoolId, rows.flatMap((row) => (row.section_id ? [row.section_id] : [])))

  const pairs = rows.filter(
    (row) => row.guardian_id !== null && row.student_id !== null && guardianReach.has(row.student_id),
  )
  const guardians = new Map<string, { name: string; relation: string }>()
  if (pairs.length > 0) {
    const found = await conn.client.query<{
      guardian_id: string
      student_id: string
      first_name: string
      last_name: string | null
      relation: string
    }>(
      `SELECT g.id AS guardian_id, sg.student_id, g.first_name, g.last_name, sg.relation
         FROM guardians g
         JOIN student_guardians sg ON sg.school_id = g.school_id AND sg.guardian_id = g.id
        WHERE g.school_id = $1 AND (g.id, sg.student_id) IN (
              SELECT * FROM unnest($2::uuid[], $3::uuid[]))`,
      [context.schoolId, pairs.map((row) => row.guardian_id), pairs.map((row) => row.student_id)],
    )
    for (const row of found.rows) {
      const name = [row.first_name, row.last_name ?? ''].map((part) => part.trim()).filter(Boolean).join(' ')
      if (name.length > 0) {
        guardians.set(`${row.guardian_id}:${row.student_id}`, { name: name.slice(0, 160), relation: row.relation })
      }
    }
  }

  const columns: ExportColumn[] = [
    { header: 'Name', key: 'name', width: 30 },
    { header: 'Relation', key: 'relation', width: 14 },
    { header: 'Pupil', key: 'pupil', width: 30 },
    { header: 'Class', key: 'section', width: 14 },
    { header: 'Outcome', key: 'outcome', width: 18 },
    { header: 'In the app', key: 'inApp', width: 11 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Email status', key: 'emailStatus', width: 13 },
    { header: 'Read at', key: 'readAt', width: 20 },
  ]
  const sheetRows = rows.map((row) => {
    const pupil = row.student_id ? pupils.get(row.student_id) : undefined
    const section = pupil && row.section_id ? sections.get(row.section_id) : undefined
    const guardian =
      row.guardian_id && row.student_id ? guardians.get(`${row.guardian_id}:${row.student_id}`) : undefined
    const name =
      row.staff_id !== null ? (staffNames.get(row.staff_id) ?? 'Staff member') : (guardian?.name ?? 'Guardian')
    return {
      name,
      relation: row.staff_id !== null ? 'Staff' : (guardian?.relation.slice(0, 40) ?? ''),
      pupil: pupil?.name ?? '',
      section: section?.label ?? '',
      outcome: OUTCOME_WORDS[row.outcome],
      inApp: row.in_app ? 'Yes' : 'No',
      email: row.email_masked ?? '',
      emailStatus: EMAIL_WORDS[row.email_status],
      readAt: readAtWords(row.read_at),
    }
  })

  // The file is named by what it is and when, never by the message's title.
  return {
    bytes: await buildWorkbook({ sheetName: 'Delivery record', columns, rows: sheetRows }),
    contentType: XLSX_CONTENT_TYPE,
    fileName: exportFileName(
      ['message delivery', MESSAGE_KIND_LABELS[message.kind], fileNameDate(context.now)],
      'xlsx',
    ),
    rowCount: sheetRows.length,
  }
}

registerProducer({ kind: 'message_delivery', produce })
