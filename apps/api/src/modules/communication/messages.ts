import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  AudienceOptions,
  AudiencePreview,
  AudiencePreviewRequest,
  CreateMessageRequest,
  DeleteMessageRequest,
  MESSAGE_BODY_MAX,
  MESSAGE_SCHEDULE_MAX_DAYS,
  MESSAGE_SCHEDULE_MIN_MINUTES,
  MESSAGE_TITLE_MAX,
  MessageDetail,
  SendMessageRequest,
  UnscheduleMessageRequest,
  UpdateMessageRequest,
  WithdrawMessageRequest,
  renderMessageText,
  unknownPlaceholders,
  type MessageAudienceInput,
  type MessagePlaceholder,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import type { ScopedTable } from '@erp/authz'
import { withTenantTransaction } from '@erp/db'
import { sections } from '@erp/db/schema'
import {
  ApiFailure,
  assertUuidParam,
  assertVersion,
  bumpVersion,
  decideResource,
  lockSchool,
  protectedRoute,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import type { AudienceTarget } from './audience.ts'
import { previewAudience } from './audience.ts'
import { materialiseMessage } from './materialise.ts'
import { kickMessagePump } from './pump.ts'
import { removeStoredFiles } from './attachments.ts'
import {
  assertMayAct,
  audienceInputOf,
  auditFacts,
  decideMessage,
  labelMessages,
  optionalPredicate,
  readMessageDetail,
  refusedAsMissing,
  schoolName,
  type MessageConnection,
  type MessageRow,
} from './shared-reads.ts'

/**
 * Writing and sending notices: the audiences the caller may choose, a preview
 * of who a message would reach, the draft itself, and sending, scheduling,
 * unscheduling and withdrawing it. Every write locks the school, decides the
 * message and its target again, and leaves exactly one audit row that names
 * the message and never its words.
 */

/** A target the caller may send to, checked and ready to store. */
interface ResolvedTarget {
  readonly target: AudienceTarget
  /** The pupil of a `pupil` audience, for the placeholders. */
  readonly pupil?: { readonly name: string; readonly firstName: string; readonly className?: string }
}

/**
 * The sections of the open years, laid out for a `communication` plan: a
 * section is its own section, so assigned_sections reaches exactly the
 * caller's own, and the school scope reaches all of them.
 */
const SECTION_TARGETS: ScopedTable = {
  table: sections,
  schoolId: sections.schoolId,
  id: sections.id,
  sectionId: sections.id,
  academicYearId: sections.academicYearId,
}

function invalid(): ApiFailure {
  return new ApiFailure('INVALID_REQUEST')
}

function reasonFailure(
  reason:
    | 'message_not_editable'
    | 'message_not_sent'
    | 'message_schedule_in_past'
    | 'message_schedule_too_far'
    | 'message_placeholder_unknown'
    | 'message_template_archived'
    | 'message_template_kind_mismatch',
): ApiFailure {
  return new ApiFailure('INVALID_REQUEST', undefined, reason)
}

/**
 * The target decided under communication.send on its own id, then checked.
 * A grade, a section or a pupil the caller may not send to answers exactly
 * like one that does not exist; the school and the staff are not records
 * anybody names, so refusing them is a plain refusal.
 */
async function decideTarget(
  conn: MessageConnection,
  context: RequestContext,
  audience: MessageAudienceInput,
): Promise<ResolvedTarget> {
  const targetId =
    audience.kind === 'grade'
      ? audience.gradeId
      : audience.kind === 'section'
        ? audience.sectionId
        : audience.kind === 'pupil'
          ? audience.studentId
          : context.schoolId
  const decision = await decideResource(conn, context, 'communication.send', 'communication', targetId)
  if (!decision.allowed) {
    if (audience.kind === 'school' || audience.kind === 'staff') {
      throw new ApiFailure(decision.code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : 'ACCESS_DENIED')
    }
    throw refusedAsMissing(decision.code)
  }

  switch (audience.kind) {
    case 'school':
    case 'staff':
      return { target: { kind: audience.kind } }
    case 'grade': {
      const found = await conn.client.query('SELECT 1 FROM grades WHERE school_id = $1 AND id = $2', [
        context.schoolId,
        audience.gradeId,
      ])
      if (found.rows.length === 0) throw new ApiFailure('RESOURCE_NOT_FOUND')
      return { target: { kind: 'grade', gradeId: audience.gradeId } }
    }
    case 'section': {
      const found = await conn.client.query<{ academic_year_id: string; status: string }>(
        `SELECT s.academic_year_id, y.status
           FROM sections s JOIN academic_years y ON y.school_id = s.school_id AND y.id = s.academic_year_id
          WHERE s.school_id = $1 AND s.id = $2`,
        [context.schoolId, audience.sectionId],
      )
      const section = found.rows[0]
      if (!section) throw new ApiFailure('RESOURCE_NOT_FOUND')
      // A closed year's section has nobody left to tell.
      if (section.status === 'closed') throw invalid()
      return {
        target: { kind: 'section', sectionId: audience.sectionId, academicYearId: section.academic_year_id },
      }
    }
    case 'pupil': {
      const found = await conn.client.query<{
        status: string
        anonymised: boolean
        first_name: string
        last_name: string | null
      }>(
        `SELECT status, anonymised_at IS NOT NULL AS anonymised, first_name, last_name
           FROM students WHERE school_id = $1 AND id = $2`,
        [context.schoolId, audience.studentId],
      )
      const pupil = found.rows[0]
      if (!pupil) throw new ApiFailure('RESOURCE_NOT_FOUND')
      if (pupil.status !== 'active' || pupil.anonymised) throw invalid()
      // The pupil's section this year, copied onto the message so a teacher of
      // that section reaches it, and the class a placeholder names.
      const enrolled = await conn.client.query<{
        section_id: string
        academic_year_id: string
        section_name: string
        grade_name: string
      }>(
        `SELECT e.section_id, e.academic_year_id, s.name AS section_name, g.name AS grade_name
           FROM enrollments e
           JOIN academic_years y ON y.school_id = e.school_id AND y.id = e.academic_year_id AND y.status = 'current'
           JOIN sections s ON s.school_id = e.school_id AND s.id = e.section_id
           JOIN grades g ON g.school_id = s.school_id AND g.id = s.grade_id
          WHERE e.school_id = $1 AND e.student_id = $2 AND e.left_on IS NULL
          ORDER BY e.joined_on DESC, e.id
          LIMIT 1`,
        [context.schoolId, audience.studentId],
      )
      const enrolment = enrolled.rows[0]
      const name = [pupil.first_name, pupil.last_name ?? ''].map((part) => part.trim()).filter(Boolean).join(' ')
      return {
        target: {
          kind: 'pupil',
          studentId: audience.studentId,
          ...(enrolment ? { sectionId: enrolment.section_id, academicYearId: enrolment.academic_year_id } : {}),
        },
        pupil: {
          name,
          firstName: pupil.first_name.trim() || name,
          ...(enrolment ? { className: `${enrolment.grade_name} ${enrolment.section_name}` } : {}),
        },
      }
    }
  }
}

/**
 * The words as they will be stored: every placeholder must be one this
 * audience can fill, and all of them are filled now. Nothing is left in
 * braces for a later step to guess at.
 */
async function renderWords(
  conn: MessageConnection,
  schoolId: string,
  resolved: ResolvedTarget,
  title: string,
  body: string,
): Promise<{ title: string; body: string }> {
  if (unknownPlaceholders(`${title}\n${body}`, 'notice', resolved.target.kind).length > 0) {
    throw reasonFailure('message_placeholder_unknown')
  }
  const values: Partial<Record<MessagePlaceholder, string>> = { school: await schoolName(conn, schoolId) }
  if (resolved.pupil) {
    values.pupil_name = resolved.pupil.name
    values.pupil_first_name = resolved.pupil.firstName
    if (resolved.pupil.className !== undefined) values.class = resolved.pupil.className
  }
  const rendered = { title: renderMessageText(title, values).trim(), body: renderMessageText(body, values).trim() }
  // A placeholder with no value (a pupil with no class this year) stays as
  // written, and is refused rather than stored.
  if (unknownPlaceholders(`${rendered.title}\n${rendered.body}`, 'notice', 'school').length > 0) {
    throw reasonFailure('message_placeholder_unknown')
  }
  if (
    rendered.title.length === 0 ||
    rendered.title.length > MESSAGE_TITLE_MAX ||
    rendered.body.length === 0 ||
    rendered.body.length > MESSAGE_BODY_MAX
  ) {
    throw invalid()
  }
  return rendered
}

/** A template a notice may start from: this school's, a notice template, still live. */
async function assertNoticeTemplate(conn: MessageConnection, schoolId: string, templateId: string): Promise<void> {
  const found = await conn.client.query<{ kind: string; archived: boolean }>(
    `SELECT kind, archived_at IS NOT NULL AS archived FROM message_templates WHERE school_id = $1 AND id = $2`,
    [schoolId, templateId],
  )
  const template = found.rows[0]
  if (!template) throw invalid()
  if (template.archived) throw reasonFailure('message_template_archived')
  if (template.kind !== 'notice') throw reasonFailure('message_template_kind_mismatch')
}

/** The stored columns of an audience. */
function audienceColumns(target: AudienceTarget): Record<string, string | null> {
  return {
    audience: target.kind,
    grade_id: target.gradeId ?? null,
    section_id: target.sectionId ?? null,
    academic_year_id: target.academicYearId ?? null,
    student_id: target.studentId ?? null,
    staff_id: null,
  }
}

/** A message that still may be written to. */
function assertEditable(row: MessageRow): void {
  if (row.status !== 'draft' && row.status !== 'scheduled') throw reasonFailure('message_not_editable')
}

export function registerMessageWriteRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/messages/audiences',
    permission: 'communication.send',
    response: AudienceOptions,
    handler: async ({ context }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // The school, the staff and the grades name no section, so only the
        // school scope reaches them.
        const whole = await decideResource(conn, context, 'communication.send', 'communication', context.schoolId)
        const grades = whole.allowed
          ? (
              await conn.client.query<{ id: string; name: string }>(
                'SELECT id, name FROM grades WHERE school_id = $1 ORDER BY sort_order, name, id LIMIT 50',
                [context.schoolId],
              )
            ).rows
          : []
        const predicate = await optionalPredicate(
          conn,
          context,
          'communication.send',
          'communication',
          SECTION_TARGETS,
        )
        const open = await conn.db.execute<{
          id: string
          name: string
          grade_id: string
          grade_name: string
          academic_year_id: string
        }>(
          sql`SELECT sections.id, sections.name, sections.grade_id, g.name AS grade_name, sections.academic_year_id
                FROM sections
                JOIN grades g ON g.school_id = sections.school_id AND g.id = sections.grade_id
                JOIN academic_years y ON y.school_id = sections.school_id AND y.id = sections.academic_year_id
               WHERE ${predicate} AND y.status <> 'closed'
               ORDER BY y.start_date DESC, g.sort_order, sections.name, sections.id
               LIMIT 300`,
        )
        const sectionOptions = open.rows.map((row) => ({
          id: row.id,
          name: row.name,
          grade: { id: row.grade_id, name: row.grade_name },
          academicYearId: row.academic_year_id,
        }))
        return {
          school: whole.allowed,
          staff: whole.allowed,
          grades: grades.map((grade) => ({ id: grade.id, name: grade.name })),
          sections: sectionOptions,
          pupils: whole.allowed || sectionOptions.length > 0,
        }
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/messages/audience-preview',
    permission: 'communication.send',
    body: AudiencePreviewRequest,
    response: AudiencePreview,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const resolved = await decideTarget(conn, context, body.audience)
        const counts = await previewAudience(conn, deps, context.schoolId, resolved.target)
        // The label is built as a message's would be; the id only keys the
        // lookup and names no row.
        const id = randomUUID()
        const labels = await labelMessages(conn, context, [
          {
            id,
            audience: resolved.target.kind,
            grade_id: resolved.target.gradeId ?? null,
            section_id: resolved.target.sectionId ?? null,
            student_id: resolved.target.studentId ?? null,
            staff_id: null,
            created_by_membership_id: context.membershipId,
          },
        ])
        const audience = labels.audiences.get(id)
        if (!audience) throw new ApiFailure('RESOURCE_NOT_FOUND')
        return { audience, ...counts }
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/messages',
    permission: 'communication.send',
    body: CreateMessageRequest,
    response: MessageDetail,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        const resolved = await decideTarget(conn, context, body.audience)
        if (body.templateId !== undefined) await assertNoticeTemplate(conn, context.schoolId, body.templateId)
        const words = await renderWords(conn, context.schoolId, resolved, body.title, body.body)
        const columns = audienceColumns(resolved.target)

        const inserted = await conn.client.query<{ id: string }>(
          `INSERT INTO messages (school_id, kind, audience, grade_id, section_id, academic_year_id, student_id,
                                 title, body, status, created_by_membership_id, template_id)
           VALUES ($1, 'notice', $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $10)
           RETURNING id`,
          [
            context.schoolId,
            columns.audience,
            columns.grade_id,
            columns.section_id,
            columns.academic_year_id,
            columns.student_id,
            words.title,
            words.body,
            context.membershipId,
            body.templateId ?? null,
          ],
        )
        const id = inserted.rows[0]?.id
        if (!id) throw new ApiFailure('SERVICE_UNAVAILABLE')
        await writeAudit(conn, context, {
          action: 'communication.send',
          targetType: 'communication',
          targetId: id,
          summary: 'Wrote a message draft.',
          safeChanges: await auditFacts(
            conn,
            context.schoolId,
            { id, kind: 'notice', audience: resolved.target.kind, status: 'draft' },
            { scheduled: false, fromTemplate: body.templateId !== undefined },
          ),
        })
        return readMessageDetail(conn, context, id)
      }),
  })

  protectedRoute(app, deps, {
    method: 'PATCH',
    path: '/api/schools/:schoolId/messages/:messageId',
    permission: 'communication.send',
    body: UpdateMessageRequest,
    response: MessageDetail,
    handler: async ({ context, body, param }) => {
      const id = assertUuidParam(param('messageId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        const row = await decideMessage(conn, context, 'communication.send', id, { forUpdate: true })
        assertEditable(row)
        const action = await assertMayAct(conn, context, row)
        assertVersion(body.expectedVersion, row.version)

        const set: Record<string, unknown> = {}
        const wordsChange = body.title !== undefined || body.body !== undefined
        // A new audience is decided and checked like a new message's. The
        // words are rendered against the audience they will go to.
        let resolved: ResolvedTarget | null = null
        if (body.audience !== undefined || wordsChange) {
          const audience = body.audience ?? audienceInputOf(row)
          if (!audience) throw invalid()
          resolved = await decideTarget(conn, context, audience)
        }
        if (body.audience !== undefined && resolved) Object.assign(set, audienceColumns(resolved.target))
        if (wordsChange && resolved) {
          const words = await renderWords(
            conn,
            context.schoolId,
            resolved,
            body.title ?? row.title,
            body.body ?? row.body,
          )
          set.title = words.title
          set.body = words.body
        } else if (body.audience !== undefined && resolved) {
          // The stored words are already rendered; they must still suit the
          // new audience, so a pupil's name never goes to a whole section.
          await renderWords(conn, context.schoolId, resolved, row.title, row.body)
        }
        if (body.templateId !== undefined) {
          if (body.templateId !== null) await assertNoticeTemplate(conn, context.schoolId, body.templateId)
          set.template_id = body.templateId
        }

        await bumpVersion(conn, 'messages', {
          schoolId: context.schoolId,
          id,
          expectedVersion: body.expectedVersion,
          set,
        })
        await writeAudit(conn, context, {
          action,
          targetType: 'communication',
          targetId: id,
          summary: 'Changed a message.',
          safeChanges: await auditFacts(
            conn,
            context.schoolId,
            { id, kind: row.kind, audience: resolved?.target.kind ?? row.audience, status: row.status },
            {
              scheduled: row.status === 'scheduled',
              changed: Object.keys(set),
            },
          ),
        })
        return readMessageDetail(conn, context, id)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'DELETE',
    path: '/api/schools/:schoolId/messages/:messageId',
    permission: 'communication.send',
    query: DeleteMessageRequest,
    response: z.null(),
    successStatus: 204,
    handler: async ({ context, query, param, request }) => {
      const id = assertUuidParam(param('messageId'))
      const keys = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        const row = await decideMessage(conn, context, 'communication.send', id, { forUpdate: true })
        if (row.status !== 'draft') throw reasonFailure('message_not_editable')
        // Only a draft's author ever sees it, so the author is the only one
        // who can get this far.
        if (row.created_by_membership_id !== context.membershipId) throw new ApiFailure('RESOURCE_NOT_FOUND')
        assertVersion(query.expectedVersion, row.version)

        const facts = await auditFacts(conn, context.schoolId, row, { scheduled: false })
        const files = await conn.client.query<{ storage_key: string }>(
          'SELECT storage_key FROM message_attachments WHERE school_id = $1 AND message_id = $2',
          [context.schoolId, id],
        )
        const deleted = await conn.client.query(
          'DELETE FROM messages WHERE school_id = $1 AND id = $2 AND version = $3',
          [context.schoolId, id, query.expectedVersion],
        )
        if (deleted.rowCount === 0) throw new ApiFailure('VERSION_CONFLICT')
        await writeAudit(conn, context, {
          action: 'communication.send',
          targetType: 'communication',
          targetId: id,
          summary: 'Deleted a message draft.',
          safeChanges: facts,
        })
        return files.rows.map((file) => file.storage_key)
      })
      // Only after the commit: nothing names these bytes any more.
      await removeStoredFiles(deps, request, keys)
      return null
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/messages/:messageId/send',
    permission: 'communication.send',
    body: SendMessageRequest,
    response: MessageDetail,
    handler: async ({ context, body, param }) => {
      const id = assertUuidParam(param('messageId'))
      const outcome = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        const row = await decideMessage(conn, context, 'communication.send', id, { forUpdate: true })
        assertEditable(row)
        const action = await assertMayAct(conn, context, row)
        assertVersion(body.expectedVersion, row.version)
        const audience = audienceInputOf(row)
        if (!audience) throw invalid()
        // The target decided again: an assignment that ended since the draft
        // was written means it cannot go now.
        await decideTarget(conn, context, audience)

        if (body.sendAt === undefined) {
          const sent = await materialiseMessage(conn, deps, context.schoolId, id)
          await writeAudit(conn, context, {
            action,
            targetType: 'communication',
            targetId: id,
            summary: 'Sent a message.',
            safeChanges: await auditFacts(
              conn,
              context.schoolId,
              { ...row, status: 'sent' },
              { scheduled: false, recipients: sent.recipients, delivered: sent.delivered },
            ),
          })
          return { detail: await readMessageDetail(conn, context, id), sentNow: true }
        }

        // The database clock decides, so the answer does not depend on the
        // server the request landed on.
        const window = await conn.client.query<{ too_soon: boolean; too_far: boolean }>(
          `SELECT $1::timestamptz < now() + make_interval(mins => $2) AS too_soon,
                  $1::timestamptz > now() + make_interval(days => $3) AS too_far`,
          [body.sendAt, MESSAGE_SCHEDULE_MIN_MINUTES, MESSAGE_SCHEDULE_MAX_DAYS],
        )
        const check = window.rows[0]
        if (!check || check.too_soon) throw reasonFailure('message_schedule_in_past')
        if (check.too_far) throw reasonFailure('message_schedule_too_far')
        await bumpVersion(conn, 'messages', {
          schoolId: context.schoolId,
          id,
          expectedVersion: body.expectedVersion,
          set: { status: 'scheduled', send_at: body.sendAt },
        })
        await writeAudit(conn, context, {
          action,
          targetType: 'communication',
          targetId: id,
          summary: 'Scheduled a message.',
          safeChanges: await auditFacts(
            conn,
            context.schoolId,
            { ...row, status: 'scheduled' },
            { scheduled: true, rescheduled: row.status === 'scheduled' },
          ),
        })
        return { detail: await readMessageDetail(conn, context, id), sentNow: false }
      })
      // After the commit, so the pump sees the recipient rows it is to send.
      if (outcome.sentNow) kickMessagePump(deps, context.schoolId)
      return outcome.detail
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/messages/:messageId/unschedule',
    permission: 'communication.send',
    body: UnscheduleMessageRequest,
    response: MessageDetail,
    handler: async ({ context, body, param }) => {
      const id = assertUuidParam(param('messageId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        const row = await decideMessage(conn, context, 'communication.send', id, { forUpdate: true })
        if (row.status !== 'scheduled') throw invalid()
        const action = await assertMayAct(conn, context, row)
        await bumpVersion(conn, 'messages', {
          schoolId: context.schoolId,
          id,
          expectedVersion: body.expectedVersion,
          set: { status: 'draft', send_at: null },
        })
        await writeAudit(conn, context, {
          action,
          targetType: 'communication',
          targetId: id,
          summary: 'Took a scheduled message back to a draft.',
          safeChanges: await auditFacts(conn, context.schoolId, { ...row, status: 'draft' }, { scheduled: false }),
        })
        // A manager who unscheduled somebody else's message is answered
        // with the draft they just made, once; from now on it is its
        // author's alone.
        return readMessageDetail(conn, context, id, { justActedOn: true })
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/messages/:messageId/withdraw',
    permission: 'communication.send',
    body: WithdrawMessageRequest,
    response: MessageDetail,
    handler: async ({ context, body, param }) => {
      const id = assertUuidParam(param('messageId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        const row = await decideMessage(conn, context, 'communication.send', id, { forUpdate: true })
        if (row.status !== 'sent') throw reasonFailure('message_not_sent')
        const action = await assertMayAct(conn, context, row)
        await bumpVersion(conn, 'messages', {
          schoolId: context.schoolId,
          id,
          expectedVersion: body.expectedVersion,
          set: { status: 'withdrawn', withdrawn_at: new Date(), withdrawn_by_membership_id: context.membershipId },
        })
        // Every email still waiting stops here; one already sent cannot be
        // recalled, and the screen says so.
        const cancelled = await conn.client.query(
          `UPDATE message_recipients SET email_status = 'cancelled', email_next_attempt_at = NULL
            WHERE school_id = $1 AND message_id = $2 AND email_status = 'pending'`,
          [context.schoolId, id],
        )
        await writeAudit(conn, context, {
          action,
          targetType: 'communication',
          targetId: id,
          summary: 'Withdrew a message.',
          safeChanges: await auditFacts(
            conn,
            context.schoolId,
            { ...row, status: 'withdrawn' },
            { scheduled: false, emailsCancelled: cancelled.rowCount ?? 0 },
          ),
          note: body.reason,
        })
        return readMessageDetail(conn, context, id)
      })
    },
  })
}
