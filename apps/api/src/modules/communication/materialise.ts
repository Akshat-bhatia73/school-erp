import type { MessageAudienceKind, MessageRecipients } from '@erp/contracts'
import { ApiFailure, type TenantConnection } from '../shared/index.ts'
import { resolveRecipients } from './audience.ts'
import type { DispatchDependencies } from './common.ts'

interface MessageRow {
  status: string
  audience: MessageAudienceKind
  grade_id: string | null
  grade_to_id: string | null
  recipients: MessageRecipients | null
  section_id: string | null
  academic_year_id: string | null
  student_id: string | null
  staff_id: string | null
  created_by_membership_id: string | null
}

/**
 * Send a draft or scheduled message now, inside the caller's tenant
 * transaction: work out who it is for, write one recipient row per person and
 * mark the message sent. The rows copy the message's section, year and author
 * so a delivery list reads through the same scope as the message.
 *
 * A message nobody at all is in is refused and nothing is written, unless the
 * caller says an empty audience is fine (an automatic message about a pupil
 * whose family has left, say), in which case it still goes out to nobody.
 */
export async function materialiseMessage(
  conn: TenantConnection,
  deps: DispatchDependencies,
  schoolId: string,
  messageId: string,
  options: { allowEmpty?: boolean } = {},
): Promise<{ recipients: number; delivered: number }> {
  const found = await conn.client.query<MessageRow>(
    `SELECT status, audience, grade_id, grade_to_id, recipients, section_id, academic_year_id, student_id, staff_id, created_by_membership_id
       FROM messages WHERE school_id = $1 AND id = $2
       FOR UPDATE`,
    [schoolId, messageId],
  )
  const message = found.rows[0]
  if (!message) throw new ApiFailure('RESOURCE_NOT_FOUND')
  if (message.status !== 'draft' && message.status !== 'scheduled')
    throw new ApiFailure('INVALID_REQUEST', undefined, 'message_not_editable')

  const people = await resolveRecipients(conn, deps, schoolId, {
    kind: message.audience,
    ...(message.grade_id ? { gradeId: message.grade_id } : {}),
    ...(message.grade_to_id ? { toGradeId: message.grade_to_id } : {}),
    ...(message.recipients ? { recipients: message.recipients } : {}),
    ...(message.section_id ? { sectionId: message.section_id } : {}),
    ...(message.academic_year_id ? { academicYearId: message.academic_year_id } : {}),
    ...(message.student_id ? { studentId: message.student_id } : {}),
    ...(message.staff_id ? { staffId: message.staff_id } : {}),
  })
  if (people.length === 0 && !options.allowEmpty)
    throw new ApiFailure('INVALID_REQUEST', undefined, 'message_audience_empty')

  if (people.length > 0) {
    // One statement for every row, however large the audience.
    await conn.client.query(
      `INSERT INTO message_recipients
         (school_id, message_id, guardian_id, staff_id, membership_id, student_id, section_id,
          academic_year_id, sender_membership_id, outcome, in_app, email_status, email_masked,
          email_next_attempt_at, is_student)
       SELECT $1, $2, person.guardian_id, person.staff_id, person.membership_id, person.student_id,
              $3::uuid, $4::uuid, $5::uuid, person.outcome, person.in_app, person.email_status,
              person.email_masked, CASE WHEN person.email_status = 'pending' THEN now() END,
              person.is_student
         FROM unnest($6::uuid[], $7::uuid[], $8::uuid[], $9::uuid[], $10::text[], $11::boolean[],
                     $12::text[], $13::text[], $14::boolean[])
           AS person (guardian_id, staff_id, membership_id, student_id, outcome, in_app, email_status, email_masked,
                      is_student)`,
      [
        schoolId,
        messageId,
        message.section_id,
        message.academic_year_id,
        message.created_by_membership_id,
        people.map((person) => person.guardianId ?? null),
        people.map((person) => person.staffId ?? null),
        people.map((person) => person.membershipId),
        people.map((person) => person.studentId),
        people.map((person) => person.outcome),
        people.map((person) => person.inApp),
        people.map((person) => person.emailStatus),
        people.map((person) => person.emailMasked),
        people.map((person) => person.isStudent === true),
      ],
    )
  }

  await conn.client.query(
    `UPDATE messages SET status = 'sent', sent_at = now(), version = version + 1, updated_at = now()
      WHERE school_id = $1 AND id = $2`,
    [schoolId, messageId],
  )
  return {
    recipients: people.length,
    delivered: people.filter((person) => person.outcome === 'delivered').length,
  }
}
