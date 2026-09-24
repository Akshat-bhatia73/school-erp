import type { PoolClient } from 'pg'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql, type SQL } from 'drizzle-orm'
import type {
  MessageAudienceInput,
  MessageAudienceKind,
  MessageAudienceView,
  MessageCounts,
  MessageDetail,
  MessageKind,
  MessageRecipients,
  MessageSender,
  MessageStatus,
  MessageSummary,
  PermissionKey,
  ResourceType,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import {
  AuthorizationError,
  communicationScopedTable,
  planPredicate,
  planPredicateWithout,
  scopedTableFor,
  type ScopedTable,
} from '@erp/authz'
import {
  allowedActionsForMany,
  ApiFailure,
  decideResource,
  readPlan,
  requireFound,
} from '../shared/index.ts'

/**
 * What the communication routes share: the message row and its projection,
 * the names a message may show (each through the caller's own plan), the
 * decision on one message and the author-or-manager rule for acting on it.
 * Nothing here writes.
 */

/** The connection withTenantTransaction hands a module handler. */
export interface MessageConnection {
  readonly client: PoolClient
  readonly db: NodePgDatabase
}

/** A timestamp as the contracts want it, made by the database so no driver parsing is involved. */
export function isoOf(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
}

export type MessageRow = {
  id: string
  kind: MessageKind
  audience: MessageAudienceKind
  /** Null exactly for the staff audiences. */
  recipients: MessageRecipients | null
  grade_id: string | null
  /** The last class of a `grade_range`. */
  grade_to_id: string | null
  section_id: string | null
  academic_year_id: string | null
  student_id: string | null
  staff_id: string | null
  title: string
  body: string
  status: MessageStatus
  send_at: string | null
  sent_at: string | null
  withdrawn_at: string | null
  cancel_reason: 'author_lost_access' | null
  created_by_membership_id: string | null
  template_id: string | null
  redacted: boolean
  version: number
  created_at: string
}

/** The columns of a message, over the unaliased table the authorizer names. */
export const MESSAGE_COLUMNS = `messages.id, messages.kind, messages.audience, messages.recipients, messages.grade_id,
       messages.grade_to_id, messages.section_id, messages.academic_year_id, messages.student_id, messages.staff_id, messages.title, messages.body,
       messages.status, ${isoOf('messages.send_at')} AS send_at, ${isoOf('messages.sent_at')} AS sent_at,
       ${isoOf('messages.withdrawn_at')} AS withdrawn_at, messages.cancel_reason,
       messages.created_by_membership_id, messages.template_id, messages.redacted_at IS NOT NULL AS redacted,
       messages.version, ${isoOf('messages.created_at')} AS created_at`

/** The stored row, with no plan: only after the caller has been decided on it. */
export async function loadMessage(
  conn: MessageConnection,
  schoolId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<MessageRow> {
  const result = await conn.client.query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE messages.school_id = $1 AND messages.id = $2
     ${options.forUpdate ? 'FOR UPDATE' : ''}`,
    [schoolId, id],
  )
  const row = requireFound(result.rows[0])
  return { ...row, version: Number(row.version) }
}

/**
 * A refusal on a record somebody named is the same answer as a record that is
 * not there. Two-step verification is the one refusal worth saying out loud.
 */
export function refusedAsMissing(code: string): ApiFailure {
  return new ApiFailure(code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : 'RESOURCE_NOT_FOUND')
}

/**
 * The message decided under the key the route declares, then read. A draft is
 * its author's alone, so anybody else, the office included, is told it is not
 * there.
 */
export async function decideMessage(
  conn: MessageConnection,
  context: RequestContext,
  permission: PermissionKey,
  id: string,
  options: { forUpdate?: boolean; justActedOn?: boolean } = {},
): Promise<MessageRow> {
  const decision = await decideResource(conn, context, permission, 'communication', id)
  if (!decision.allowed) throw refusedAsMissing(decision.code)
  const row = await loadMessage(conn, context.schoolId, id, options)
  if (row.status === 'draft' && row.created_by_membership_id !== context.membershipId && !options.justActedOn) {
    throw new ApiFailure('RESOURCE_NOT_FOUND')
  }
  return row
}

/**
 * Acting on a message: its author may, and so may a caller who holds
 * communication.manage on it. An automatic message has no author, so only
 * manage reaches it. The answer is the audit action the write records.
 */
export async function assertMayAct(
  conn: MessageConnection,
  context: RequestContext,
  row: MessageRow,
): Promise<'communication.send' | 'communication.manage'> {
  if (row.created_by_membership_id !== null && row.created_by_membership_id === context.membershipId) {
    return 'communication.send'
  }
  const decision = await decideResource(conn, context, 'communication.manage', 'communication', row.id)
  if (decision.allowed) return 'communication.manage'
  // The caller can already see the message, so saying no names nothing new.
  throw new ApiFailure(decision.code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : 'ACCESS_DENIED')
}

/** The audience a person chose, rebuilt from the stored row, for deciding it again. */
export function audienceInputOf(row: MessageRow): MessageAudienceInput | null {
  const recipients = row.recipients ?? 'families'
  switch (row.audience) {
    case 'school':
      return { kind: 'school', recipients }
    case 'staff':
      return { kind: 'staff' }
    case 'grade':
      return row.grade_id === null ? null : { kind: 'grade', gradeId: row.grade_id, recipients }
    case 'grade_range':
      return row.grade_id === null || row.grade_to_id === null
        ? null
        : { kind: 'grade_range', fromGradeId: row.grade_id, toGradeId: row.grade_to_id, recipients }
    case 'section':
      return row.section_id === null ? null : { kind: 'section', sectionId: row.section_id, recipients }
    case 'pupil':
      return row.student_id === null ? null : { kind: 'pupil', studentId: row.student_id, recipients }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Plans. Each answers FALSE, not a refusal, when the caller holds the key
// nowhere: the block is left out, the read still answers.

function tableFor(resourceType: ResourceType): ScopedTable {
  const scoped = scopedTableFor(resourceType)
  if (!scoped) throw new Error(`the authorizer has no scoped table for ${resourceType}`)
  return scoped
}

export async function optionalPredicate(
  conn: MessageConnection,
  context: RequestContext,
  permission: PermissionKey,
  resourceType: ResourceType,
  table: ScopedTable = tableFor(resourceType),
): Promise<SQL> {
  try {
    return planPredicate(await readPlan(conn, context, permission, resourceType), table)
  } catch (error) {
    if (error instanceof AuthorizationError && error.code === 'ACCESS_DENIED') return sql`FALSE`
    throw error
  }
}

/** Over `messages`: the messages the caller reaches under communication.read. */
export interface MessagePlans {
  readonly all: SQL
  /** The same plan without the self scope: reached other than as a recipient (or the author's self). */
  readonly asReader: SQL
}

export async function messagePlans(conn: MessageConnection, context: RequestContext): Promise<MessagePlans> {
  const plan = await readPlan(conn, context, 'communication.read', 'communication')
  const table = communicationScopedTable('message')
  return { all: planPredicate(plan, table), asReader: planPredicateWithout(plan, table, ['self']) }
}

/** Over `message_recipients`: the delivery rows the caller reaches. */
export async function recipientPlan(conn: MessageConnection, context: RequestContext): Promise<SQL> {
  return optionalPredicate(
    conn,
    context,
    'communication.read',
    'communication',
    communicationScopedTable('recipient'),
  )
}

/**
 * True when the caller wrote the message or reaches it other than as one of
 * its recipients: the two readers who see its counts and its delivery list.
 */
export async function readsAsSender(
  conn: MessageConnection,
  context: RequestContext,
  row: MessageRow,
): Promise<boolean> {
  if (row.created_by_membership_id === context.membershipId) return true
  const plans = await messagePlans(conn, context)
  const found = await conn.db.execute(
    sql`SELECT 1 FROM messages WHERE ${plans.all} AND ${plans.asReader} AND messages.id = ${row.id}::uuid`,
  )
  return found.rows.length > 0
}

// ---------------------------------------------------------------------------
// Names.

function fullName(first: string, last: string | null): string {
  return [first, last ?? ''].map((part) => part.trim()).filter((part) => part.length > 0).join(' ').slice(0, 160)
}

export interface PupilName {
  readonly name: string
  readonly firstName: string
}

/** Pupil names the caller may read under students.read_basic. */
export async function readablePupils(
  conn: MessageConnection,
  context: RequestContext,
  ids: readonly string[],
): Promise<Map<string, PupilName>> {
  const names = new Map<string, PupilName>()
  const wanted = [...new Set(ids)]
  if (wanted.length === 0) return names
  const predicate = await optionalPredicate(conn, context, 'students.read_basic', 'student')
  const result = await conn.db.execute<{ id: string; first_name: string; last_name: string | null }>(
    sql`SELECT students.id, students.first_name, students.last_name FROM students
         WHERE ${predicate} AND students.id = ANY(${sql.raw(uuidArray(wanted))})`,
  )
  for (const row of result.rows) {
    const name = fullName(row.first_name, row.last_name)
    if (name.length > 0) names.set(row.id, { name, firstName: row.first_name.trim() || name })
  }
  return names
}

/** The pupils whose guardians the caller may name, under students.read_guardian_contact. */
export async function guardianReadablePupils(
  conn: MessageConnection,
  context: RequestContext,
  ids: readonly string[],
): Promise<Set<string>> {
  const wanted = [...new Set(ids)]
  if (wanted.length === 0) return new Set()
  const predicate = await optionalPredicate(conn, context, 'students.read_guardian_contact', 'student')
  const result = await conn.db.execute<{ id: string }>(
    sql`SELECT students.id FROM students WHERE ${predicate} AND students.id = ANY(${sql.raw(uuidArray(wanted))})`,
  )
  return new Set(result.rows.map((row) => row.id))
}

/** Staff names the caller may read under staff.read_directory. */
export async function readableStaff(
  conn: MessageConnection,
  context: RequestContext,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const wanted = [...new Set(ids)]
  if (wanted.length === 0) return names
  const predicate = await optionalPredicate(conn, context, 'staff.read_directory', 'staff')
  const result = await conn.db.execute<{ id: string; first_name: string; last_name: string | null }>(
    sql`SELECT staff.id, staff.first_name, staff.last_name FROM staff
         WHERE ${predicate} AND staff.id = ANY(${sql.raw(uuidArray(wanted))})`,
  )
  for (const row of result.rows) {
    const name = fullName(row.first_name, row.last_name)
    if (name.length > 0) names.set(row.id, name)
  }
  return names
}

/**
 * A literal uuid array for ids this module already holds as uuids (from its
 * own rows). Each is checked against the uuid shape before it reaches the
 * statement text, so nothing a caller typed can.
 */
function uuidArray(ids: readonly string[]): string {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  for (const id of ids) if (!UUID.test(id)) throw new Error('not a uuid')
  return `ARRAY[${ids.map((id) => `'${id}'`).join(', ')}]::uuid[]`
}

/** "Class 5 A": a section as a screen names it. */
export async function sectionLabels(
  conn: MessageConnection,
  schoolId: string,
  ids: readonly string[],
): Promise<Map<string, { label: string; gradeId: string; gradeName: string; name: string }>> {
  const wanted = [...new Set(ids)]
  if (wanted.length === 0) return new Map()
  const result = await conn.client.query<{ id: string; name: string; grade_id: string; grade_name: string }>(
    `SELECT s.id, s.name, s.grade_id, g.name AS grade_name
       FROM sections s JOIN grades g ON g.school_id = s.school_id AND g.id = s.grade_id
      WHERE s.school_id = $1 AND s.id = ANY($2::uuid[])`,
    [schoolId, wanted],
  )
  return new Map(
    result.rows.map((row) => [
      row.id,
      { label: `${row.grade_name} ${row.name}`.slice(0, 80), gradeId: row.grade_id, gradeName: row.grade_name, name: row.name },
    ]),
  )
}

async function gradeNames(conn: MessageConnection, schoolId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)]
  if (wanted.length === 0) return new Map()
  const result = await conn.client.query<{ id: string; name: string }>(
    `SELECT id, name FROM grades WHERE school_id = $1 AND id = ANY($2::uuid[])`,
    [schoolId, wanted],
  )
  return new Map(result.rows.map((row) => [row.id, row.name]))
}

export async function schoolName(conn: MessageConnection, schoolId: string): Promise<string> {
  const result = await conn.client.query<{ name: string }>('SELECT name FROM schools WHERE id = $1', [schoolId])
  const name = (result.rows[0]?.name ?? '').trim()
  return name.length > 0 ? name.slice(0, 160) : 'School'
}

/**
 * The name a member writes under: their staff record, exactly as the member
 * directory resolves it first, otherwise "School office". A sign-in profile
 * name is never used here, so no login detail reaches a family.
 */
async function senderNames(
  conn: MessageConnection,
  schoolId: string,
  membershipIds: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(membershipIds)]
  if (wanted.length === 0) return new Map()
  const result = await conn.client.query<{ membership_id: string; first_name: string; last_name: string | null }>(
    `SELECT msl.membership_id, s.first_name, s.last_name
       FROM membership_staff_links msl
       JOIN staff s ON s.school_id = msl.school_id AND s.id = msl.staff_id
      WHERE msl.school_id = $1 AND msl.membership_id = ANY($2::uuid[])`,
    [schoolId, wanted],
  )
  const names = new Map<string, string>()
  for (const row of result.rows) {
    const name = fullName(row.first_name, row.last_name)
    if (name.length > 0) names.set(row.membership_id, name)
  }
  return names
}

// ---------------------------------------------------------------------------
// Projection.

/** Everything a page of messages needs besides its rows, loaded once for the page. */
export interface MessageLabels {
  readonly audiences: Map<string, MessageAudienceView>
  readonly senders: Map<string, MessageSender>
  readonly attachments: Map<string, number>
}

export async function labelMessages(
  conn: MessageConnection,
  context: RequestContext,
  rows: readonly Pick<
    MessageRow,
    | 'id'
    | 'audience'
    | 'recipients'
    | 'grade_id'
    | 'grade_to_id'
    | 'section_id'
    | 'student_id'
    | 'staff_id'
    | 'created_by_membership_id'
  >[],
): Promise<MessageLabels> {
  const schoolId = context.schoolId
  // One after another: they share the transaction's single connection.
  const grades = await gradeNames(conn, schoolId, rows.flatMap((row) =>
    row.audience === 'grade' || row.audience === 'grade_range'
      ? [row.grade_id, row.grade_to_id].filter((gradeId): gradeId is string => gradeId !== null)
      : [],
  ))
  const sections = await sectionLabels(conn, schoolId, rows.flatMap((row) => (row.audience === 'section' && row.section_id ? [row.section_id] : [])))
  const pupils = await readablePupils(conn, context, rows.flatMap((row) => (row.audience === 'pupil' && row.student_id ? [row.student_id] : [])))
  const staffNames = await readableStaff(conn, context, rows.flatMap((row) => (row.staff_id ? [row.staff_id] : [])))
  const members = await senderNames(conn, schoolId, rows.flatMap((row) => (row.created_by_membership_id ? [row.created_by_membership_id] : [])))
  const school = await schoolName(conn, schoolId)
  const attachments = await attachmentCounts(conn, schoolId, rows.map((row) => row.id))

  const audiences = new Map<string, MessageAudienceView>()
  const senders = new Map<string, MessageSender>()
  for (const row of rows) {
    audiences.set(row.id, audienceView(row, { grades, sections, pupils, staffNames }))
    senders.set(
      row.id,
      row.created_by_membership_id === null
        ? { kind: 'school', name: school }
        : {
            kind: 'member',
            membershipId: row.created_by_membership_id,
            name: members.get(row.created_by_membership_id) ?? 'School office',
          },
    )
  }
  return { audiences, senders, attachments }
}

function audienceView(
  row: Pick<MessageRow, 'audience' | 'recipients' | 'grade_id' | 'grade_to_id' | 'section_id' | 'student_id' | 'staff_id'>,
  names: {
    grades: Map<string, string>
    sections: Map<string, { label: string }>
    pupils: Map<string, PupilName>
    staffNames: Map<string, string>
  },
): MessageAudienceView {
  // Every pupil audience says who of it the message is for; the staff ones never do.
  const recipients = row.recipients ?? 'families'
  switch (row.audience) {
    case 'school':
      return {
        kind: 'school',
        label: recipients === 'families' ? 'Whole school (families)' : 'Whole school',
        recipients,
      }
    case 'staff':
      return { kind: 'staff', label: 'All staff' }
    case 'grade':
      return {
        kind: 'grade',
        label: (row.grade_id && names.grades.get(row.grade_id)) || 'A class',
        recipients,
        ...(row.grade_id ? { gradeId: row.grade_id } : {}),
      }
    case 'grade_range': {
      const first = row.grade_id ? names.grades.get(row.grade_id) : undefined
      const last = row.grade_to_id ? names.grades.get(row.grade_to_id) : undefined
      return {
        kind: 'grade_range',
        label: (first && last ? `${first} to ${last}` : 'A range of classes').slice(0, 200),
        recipients,
        ...(row.grade_id ? { gradeId: row.grade_id } : {}),
        ...(row.grade_to_id ? { toGradeId: row.grade_to_id } : {}),
      }
    }
    case 'section':
      return {
        kind: 'section',
        recipients,
        label: (row.section_id && names.sections.get(row.section_id)?.label) || 'A section',
        ...(row.section_id ? { sectionId: row.section_id } : {}),
      }
    case 'pupil': {
      const pupil = row.student_id ? names.pupils.get(row.student_id) : undefined
      return {
        kind: 'pupil',
        label: pupilAudienceLabel(pupil?.name, recipients),
        recipients,
        ...(row.student_id ? { studentId: row.student_id } : {}),
        ...(row.section_id ? { sectionId: row.section_id } : {}),
      }
    }
    case 'staff_member': {
      const name = row.staff_id ? names.staffNames.get(row.staff_id) : undefined
      return {
        kind: 'staff_member',
        label: name ?? 'One staff member',
        ...(row.staff_id ? { staffId: row.staff_id } : {}),
      }
    }
  }
}

/** "Family of Aarav Sharma", "Aarav Sharma" or "Aarav Sharma and family"; the same without a name when it is not readable. */
function pupilAudienceLabel(name: string | undefined, recipients: MessageRecipients): string {
  switch (recipients) {
    case 'families':
      return name ? `Family of ${name}` : 'One family'
    case 'students':
      return name ?? 'One pupil'
    case 'both':
      return name ? `${name} and family` : 'One pupil and family'
  }
}

async function attachmentCounts(
  conn: MessageConnection,
  schoolId: string,
  ids: readonly string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map()
  const result = await conn.client.query<{ message_id: string; count: number }>(
    `SELECT message_id, count(*)::int AS count FROM message_attachments
      WHERE school_id = $1 AND message_id = ANY($2::uuid[]) GROUP BY message_id`,
    [schoolId, [...ids]],
  )
  return new Map(result.rows.map((row) => [row.message_id, Number(row.count)]))
}

/**
 * The delivery figures of each message, over the recipient rows the caller's
 * recipient plan reaches: one grouped query for the whole page.
 */
export async function messageCounts(
  conn: MessageConnection,
  context: RequestContext,
  ids: readonly string[],
): Promise<Map<string, MessageCounts>> {
  const counts = new Map<string, MessageCounts>()
  if (ids.length === 0) return counts
  const predicate = await recipientPlan(conn, context)
  const result = await conn.db.execute<Record<string, string | number>>(
    sql`SELECT message_recipients.message_id,
               count(*)::int AS recipients,
               count(*) FILTER (WHERE is_student)::int AS pupils,
               count(*) FILTER (WHERE outcome = 'delivered')::int AS delivered,
               count(*) FILTER (WHERE outcome = 'no_consent')::int AS no_consent,
               count(*) FILTER (WHERE outcome = 'not_receiving')::int AS not_receiving,
               count(*) FILTER (WHERE outcome = 'no_contact')::int AS no_contact,
               count(*) FILTER (WHERE in_app)::int AS in_app,
               count(*) FILTER (WHERE read_at IS NOT NULL)::int AS read,
               count(*) FILTER (WHERE email_status = 'sent')::int AS email_sent,
               count(*) FILTER (WHERE email_status = 'pending')::int AS email_pending,
               count(*) FILTER (WHERE email_status = 'failed')::int AS email_failed
          FROM message_recipients
         WHERE ${predicate} AND message_recipients.message_id = ANY(${sql.raw(uuidArray([...new Set(ids)]))})
         GROUP BY message_recipients.message_id`,
  )
  const empty: MessageCounts = {
    recipients: 0, pupils: 0, delivered: 0, noConsent: 0, notReceiving: 0, noContact: 0,
    inApp: 0, read: 0, emailSent: 0, emailPending: 0, emailFailed: 0,
  }
  for (const id of ids) counts.set(id, empty)
  for (const row of result.rows) {
    counts.set(String(row.message_id), {
      recipients: Number(row.recipients),
      pupils: Number(row.pupils),
      delivered: Number(row.delivered),
      noConsent: Number(row.no_consent),
      notReceiving: Number(row.not_receiving),
      noContact: Number(row.no_contact),
      inApp: Number(row.in_app),
      read: Number(row.read),
      emailSent: Number(row.email_sent),
      emailPending: Number(row.email_pending),
      emailFailed: Number(row.email_failed),
    })
  }
  return counts
}

/** Recipients exist once a message has gone out. */
export function hasRecipients(status: MessageStatus): boolean {
  return status === 'sent' || status === 'withdrawn'
}

/**
 * What the caller may do to each message. The policy answers per record; a
 * write needs the author or manage on top, and a withdrawn or cancelled
 * message takes no action at all.
 */
export async function messageActions(
  conn: MessageConnection,
  context: RequestContext,
  rows: readonly Pick<MessageRow, 'id' | 'status' | 'created_by_membership_id'>[],
): Promise<Map<string, PermissionKey[]>> {
  const decided = await allowedActionsForMany(conn, context, 'communication', rows.map((row) => row.id))
  const actions = new Map<string, PermissionKey[]>()
  for (const row of rows) {
    const keys = [...(decided.get(row.id) ?? [])]
    const mine = row.created_by_membership_id !== null && row.created_by_membership_id === context.membershipId
    const actable = row.status === 'draft' || row.status === 'scheduled' || row.status === 'sent'
    actions.set(
      row.id,
      keys.filter(
        (key) => key !== 'communication.send' || (actable && (mine || keys.includes('communication.manage'))),
      ),
    )
  }
  return actions
}

/** Page rows as summaries. `withCounts` names the messages whose delivery figures this caller sees. */
export async function projectSummaries(
  conn: MessageConnection,
  context: RequestContext,
  rows: readonly MessageRow[],
  withCounts: (row: MessageRow) => boolean,
): Promise<MessageSummary[]> {
  const labels = await labelMessages(conn, context, rows)
  const counted = rows.filter((row) => hasRecipients(row.status) && withCounts(row)).map((row) => row.id)
  const counts = await messageCounts(conn, context, counted)
  const actions = await messageActions(conn, context, rows)
  return rows.map((row) => summaryOf(row, labels, counts.get(row.id), actions.get(row.id) ?? []))
}

function summaryOf(
  row: MessageRow,
  labels: MessageLabels,
  counts: MessageCounts | undefined,
  actions: PermissionKey[],
): MessageSummary {
  return {
    id: row.id,
    kind: row.kind,
    audience: requireFound(labels.audiences.get(row.id)),
    title: row.title,
    status: row.status,
    ...(row.send_at === null ? {} : { sendAt: row.send_at }),
    ...(row.sent_at === null ? {} : { sentAt: row.sent_at }),
    createdAt: row.created_at,
    sender: requireFound(labels.senders.get(row.id)),
    attachmentCount: labels.attachments.get(row.id) ?? 0,
    ...(counts === undefined ? {} : { counts }),
    version: Number(row.version),
    allowedActions: actions,
  }
}

/**
 * One message as its detail read answers it: decided again under
 * communication.read, counts only for its author and a reader who reaches it
 * other than as a recipient, and the caller's own copy when there is one.
 */
export async function readMessageDetail(
  conn: MessageConnection,
  context: RequestContext,
  id: string,
  options: { justActedOn?: boolean } = {},
): Promise<MessageDetail> {
  const row = await decideMessage(conn, context, 'communication.read', id, options)
  const sender = await readsAsSender(conn, context, row)
  const [summary] = await projectSummaries(conn, context, [row], () => sender)
  const files = await conn.client.query<{ id: string; file_name: string; content_type: 'application/pdf' | 'image/jpeg' | 'image/png'; size_bytes: number }>(
    `SELECT id, file_name, content_type, size_bytes FROM message_attachments
      WHERE school_id = $1 AND message_id = $2 ORDER BY created_at, id`,
    [context.schoolId, id],
  )
  const receipt = await conn.client.query<{ id: string; read_at: string | null }>(
    `SELECT id, ${isoOf('read_at')} AS read_at FROM message_recipients
      WHERE school_id = $1 AND message_id = $2 AND membership_id = $3 AND in_app LIMIT 1`,
    [context.schoolId, id, context.membershipId],
  )
  const mine = receipt.rows[0]
  return {
    ...requireFound(summary),
    body: row.body,
    attachments: files.rows.map((file) => ({
      id: file.id,
      fileName: file.file_name,
      contentType: file.content_type,
      sizeBytes: Number(file.size_bytes),
    })),
    ...(row.template_id === null ? {} : { templateId: row.template_id }),
    ...(row.withdrawn_at === null ? {} : { withdrawnAt: row.withdrawn_at }),
    ...(row.cancel_reason === null ? {} : { cancelReason: row.cancel_reason }),
    redacted: row.redacted,
    ...(mine ? { myReceipt: { recipientId: mine.id, ...(mine.read_at === null ? {} : { readAt: mine.read_at }) } } : {}),
  }
}

/** The safe facts of a message for its audit row: never its words. */
export async function auditFacts(
  conn: MessageConnection,
  schoolId: string,
  row: Pick<MessageRow, 'id' | 'kind' | 'audience' | 'status'>,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const files = await attachmentCounts(conn, schoolId, [row.id])
  return {
    messageId: row.id,
    kind: row.kind,
    audienceKind: row.audience,
    status: row.status,
    attachments: files.get(row.id) ?? 0,
    ...extra,
  }
}
