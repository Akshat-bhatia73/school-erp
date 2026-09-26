import { createHash } from 'node:crypto'
import {
  ASSISTANT_PROPOSAL_MINUTES,
  AssistantProposal,
  AssistantProposalPreview,
  type AssistantProposalStatus,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { open, seal } from '../../modules/shared/crypto.ts'
import type { TenantConnection } from '../../modules/shared/audit.ts'
import type { AnyProposeTool, ProposalDraft } from './types.ts'

/**
 * The proposals table (24b). A proposal is its owner's alone: every query
 * here names the caller's membership as well as the school, so another
 * person's proposal, the owner's included, answers exactly like one that does
 * not exist. The title and the preview are sealed with the application key,
 * like the conversation they belong to.
 */

type Conn = Pick<TenantConnection, 'client'>

/** The same shape the migration allows for check_path. */
const CHECK_PATH = /^\/[A-Za-z0-9/_.?=&%-]{1,400}$/

export interface ProposalRow {
  id: string
  thread_id: string
  kind: string
  tool_name: string
  title_sealed: string
  preview_sealed: string
  confirmed_preview_sealed: string | null
  check_path: string
  check_digest: string
  status: AssistantProposalStatus
  outcome: string | null
  write_request_id: string | null
  edited: boolean | null
  expires_at: string
  decided_at: string | null
  /** True when the row is open and its time has passed. */
  lapsed: boolean
  /** True when the row has been confirming for longer than any write can take. */
  abandoned: boolean
}

/**
 * How long a confirming proposal may wait for its write before it is settled
 * from the audit log instead: longer than a request can run (the function's
 * limit is five minutes), so the write has certainly finished or died.
 */
export const CONFIRM_LEASE_MINUTES = 6

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`
const COLUMNS = `id, thread_id, kind, tool_name, title_sealed, preview_sealed, confirmed_preview_sealed, check_path, check_digest,
  status, outcome, write_request_id, edited,
  to_char(expires_at AT TIME ZONE 'UTC', ${ISO}) AS expires_at,
  to_char(decided_at AT TIME ZONE 'UTC', ${ISO}) AS decided_at,
  (status = 'open' AND expires_at <= now()) AS lapsed,
  (status = 'confirming' AND confirming_at <= now() - make_interval(mins => ${CONFIRM_LEASE_MINUTES})) AS abandoned`

/** JSON with every object's keys in order, so the same answer always digests the same. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** SHA-256 hex of a route's parsed answer. */
export function digestOf(body: unknown): string {
  return createHash('sha256').update(stableJson(body)).digest('hex')
}

export function isCheckPath(path: string): boolean {
  return CHECK_PATH.test(path)
}

/**
 * What the preview column holds: the preview and where the record lives in
 * the app. The preview never changes after the proposal is made (the runtime
 * login cannot update the column); the preview as the person confirmed it is
 * kept beside it, so a reopened conversation shows what was written.
 */
interface SealedPreview {
  readonly preview: AssistantProposalPreview
  readonly href?: string
}

export function previewOf(row: Pick<ProposalRow, 'preview_sealed'>, key: string): SealedPreview {
  return JSON.parse(open(row.preview_sealed, key)) as SealedPreview
}

/** The proposal as the browser draws it. The link is given once it is done. */
export function proposalOf(row: ProposalRow, key: string, shown?: AssistantProposalPreview): AssistantProposal {
  const sealed = previewOf(row, key)
  return AssistantProposal.parse({
    id: row.id,
    kind: row.kind,
    title: open(row.title_sealed, key),
    status: row.status,
    expiresAt: row.expires_at,
    preview: shown ?? (row.confirmed_preview_sealed === null ? sealed.preview : (JSON.parse(open(row.confirmed_preview_sealed, key)) as AssistantProposalPreview)),
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    ...(row.status === 'done' && sealed.href !== undefined ? { href: sealed.href } : {}),
    ...(row.status === 'open' || row.decided_at === null ? {} : { decidedAt: row.decided_at }),
  })
}

export interface NewProposal {
  readonly threadId: string
  readonly tool: Pick<AnyProposeTool, 'name'>
  readonly draft: ProposalDraft<AssistantProposalPreview>
  readonly checkDigest: string
}

/** Seal and keep one proposal, open for ASSISTANT_PROPOSAL_MINUTES. */
export async function saveProposal(
  conn: Conn,
  context: RequestContext,
  proposal: NewProposal,
  key: string,
): Promise<AssistantProposal> {
  const { draft } = proposal
  const href = draft.href !== undefined && AssistantProposal.shape.href.safeParse(draft.href).success ? draft.href : undefined
  const sealed: SealedPreview = { preview: draft.preview, ...(href === undefined ? {} : { href }) }
  const found = await conn.client.query<ProposalRow>(
    `INSERT INTO assistant_proposals
       (school_id, thread_id, membership_id, kind, tool_name, title_sealed, preview_sealed,
        check_path, check_digest, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(mins => $10))
     RETURNING ${COLUMNS}`,
    [
      context.schoolId,
      proposal.threadId,
      context.membershipId,
      draft.kind,
      proposal.tool.name,
      seal(draft.title, key),
      seal(JSON.stringify(sealed), key),
      draft.checkPath,
      proposal.checkDigest,
      ASSISTANT_PROPOSAL_MINUTES,
    ],
  )
  const row = found.rows[0]
  if (!row) throw new Error('proposal was not saved')
  return proposalOf(row, key)
}

/** One of the caller's own proposals, locked when `lock` is set so two confirms cannot both write. */
export async function ownProposal(
  conn: Conn,
  context: RequestContext,
  proposalId: string,
  lock = false,
): Promise<ProposalRow | null> {
  const found = await conn.client.query<ProposalRow>(
    `SELECT ${COLUMNS} FROM assistant_proposals
      WHERE school_id = $1 AND membership_id = $2 AND id = $3${lock ? ' FOR UPDATE' : ''}`,
    [context.schoolId, context.membershipId, proposalId],
  )
  return found.rows[0] ?? null
}

export interface Decision {
  readonly status: Exclude<AssistantProposalStatus, 'open' | 'confirming'>
  readonly outcome?: string
  readonly writeRequestId?: string | null
  readonly edited?: boolean
  /** The preview as confirmed, sealed; only for a done proposal. */
  readonly confirmedPreviewSealed?: string
}

/** Record what happened to an open proposal. The preview is never touched. */
export async function decide(conn: Conn, context: RequestContext, row: ProposalRow, decision: Decision): Promise<ProposalRow> {
  const found = await conn.client.query<ProposalRow>(
    `UPDATE assistant_proposals
        SET status = $4, outcome = $5, write_request_id = $6, edited = $7, confirmed_preview_sealed = $8,
            decided_at = CASE WHEN $4 = 'expired' THEN NULL ELSE now() END
      WHERE school_id = $1 AND membership_id = $2 AND id = $3
      RETURNING ${COLUMNS}`,
    [
      context.schoolId,
      context.membershipId,
      row.id,
      decision.status,
      decision.outcome?.slice(0, 500) ?? null,
      decision.writeRequestId ?? null,
      decision.edited ?? null,
      decision.confirmedPreviewSealed ?? null,
    ],
  )
  const updated = found.rows[0]
  if (!updated) throw new Error('proposal was not updated')
  return updated
}

/**
 * Step one of Confirm: the proposal is being written, by the request whose id
 * is `operationId`, with the preview as the person confirmed it. Nothing else
 * may decide it until that write has been heard from.
 */
export async function markConfirming(
  conn: Conn,
  context: RequestContext,
  row: ProposalRow,
  confirming: { readonly operationId: string; readonly edited: boolean; readonly confirmedPreviewSealed: string },
): Promise<ProposalRow> {
  const found = await conn.client.query<ProposalRow>(
    `UPDATE assistant_proposals
        SET status = 'confirming', confirming_at = now(), write_request_id = $4, edited = $5, confirmed_preview_sealed = $6
      WHERE school_id = $1 AND membership_id = $2 AND id = $3 AND status = 'open'
      RETURNING ${COLUMNS}`,
    [context.schoolId, context.membershipId, row.id, confirming.operationId, confirming.edited, confirming.confirmedPreviewSealed],
  )
  const updated = found.rows[0]
  if (!updated) throw new Error('proposal was not marked confirming')
  return updated
}

/**
 * The last step of Confirm: settle a confirming proposal with what its write
 * did, or open it again when nothing was written. Only the confirm that
 * started it (the same operation id) may settle it; null when another
 * already has.
 */
export async function settle(
  conn: Conn,
  context: RequestContext,
  proposalId: string,
  operationId: string,
  decision: Decision | { readonly status: 'open' },
): Promise<ProposalRow | null> {
  const found = await conn.client.query<ProposalRow>(
    `UPDATE assistant_proposals
        SET status = $5, outcome = $6,
            write_request_id = CASE WHEN $5 = 'done' THEN write_request_id ELSE NULL END,
            edited = CASE WHEN $5 = 'done' THEN edited ELSE NULL END,
            confirmed_preview_sealed = CASE WHEN $5 = 'done' THEN confirmed_preview_sealed ELSE NULL END,
            decided_at = CASE WHEN $5 IN ('open', 'expired') THEN NULL ELSE now() END
      WHERE school_id = $1 AND membership_id = $2 AND id = $3 AND status = 'confirming' AND write_request_id = $4
      RETURNING ${COLUMNS}`,
    [
      context.schoolId,
      context.membershipId,
      proposalId,
      operationId,
      decision.status,
      'outcome' in decision ? (decision.outcome?.slice(0, 500) ?? null) : null,
    ],
  )
  return found.rows[0] ?? null
}

/** True when the write with this request id committed: its audit row says so. */
export async function wasWritten(conn: Conn, context: RequestContext, requestId: string): Promise<boolean> {
  const found = await conn.client.query(
    `SELECT 1 FROM audit_events WHERE school_id = $1 AND request_id = $2 AND result = 'allowed' LIMIT 1`,
    [context.schoolId, requestId],
  )
  return found.rows.length > 0
}

/**
 * Settle one abandoned confirming proposal: the process stopped between
 * sending the write and hearing back. The write's audit row is committed with
 * the write itself, so it alone says what happened. Written: done, described
 * from the preview that was confirmed. Not written: open again, or expired if
 * its time has passed, so the person can confirm again.
 */
export async function settleAbandoned(
  conn: Conn,
  context: RequestContext,
  row: ProposalRow,
  key: string,
  describeDone: ((preview: AssistantProposalPreview) => string) | undefined,
): Promise<ProposalRow> {
  if (!row.abandoned || row.write_request_id === null) return row
  if (await wasWritten(conn, context, row.write_request_id)) {
    const confirmed = row.confirmed_preview_sealed === null ? null : (JSON.parse(open(row.confirmed_preview_sealed, key)) as AssistantProposalPreview)
    const outcome = confirmed !== null && describeDone ? describeDone(confirmed) : 'Saved.'
    return (await settle(conn, context, row.id, row.write_request_id, { status: 'done', outcome })) ?? row
  }
  const lapsed = new Date(row.expires_at).getTime() <= Date.now()
  const decision = lapsed ? ({ status: 'expired' } as const) : ({ status: 'open' } as const)
  return (await settle(conn, context, row.id, row.write_request_id, decision)) ?? row
}

/** An open proposal whose time has passed becomes expired the moment anyone looks at it. */
export async function expireLapsed(conn: Conn, context: RequestContext, threadId?: string): Promise<void> {
  await conn.client.query(
    `UPDATE assistant_proposals SET status = 'expired'
      WHERE school_id = $1 AND membership_id = $2 AND status = 'open' AND expires_at <= now()
        AND ($3::uuid IS NULL OR thread_id = $3::uuid)`,
    [context.schoolId, context.membershipId, threadId ?? null],
  )
}

/** Every proposal in one of the caller's threads, oldest first. */
export async function threadProposals(conn: Conn, context: RequestContext, threadId: string): Promise<ProposalRow[]> {
  const found = await conn.client.query<ProposalRow>(
    `SELECT ${COLUMNS} FROM assistant_proposals
      WHERE school_id = $1 AND membership_id = $2 AND thread_id = $3
      ORDER BY created_at, id
      LIMIT 200`,
    [context.schoolId, context.membershipId, threadId],
  )
  return found.rows
}

/**
 * What the model is told about a proposal when a conversation is replayed:
 * where it stands now, not what it looked like when it was made, so the
 * model can say "Done" or offer to prepare it again.
 */
export interface ProposalForModel {
  readonly proposalId: string
  readonly title: string
  readonly status: AssistantProposalStatus
  readonly outcome: string | null
  readonly edited?: boolean
  /** For a done proposal: each change as it was confirmed, at most SAVED_MAX. */
  readonly saved?: readonly SavedChange[]
  /** How many more changes were saved than `saved` lists. */
  readonly savedMore?: number
}

export type SavedChange =
  | { readonly name: string; readonly mark: string }
  | { readonly name: string; readonly part: string; readonly value: string | number }
  | { readonly name: string; readonly grades: Readonly<Record<string, string | null>>; readonly remarkChanged: boolean }

/** The most saved changes the model is told about one proposal. */
export const SAVED_MAX = 40

/**
 * Every change a confirmed preview made, person by person: a row whose
 * proposed value differs from what was saved before. This is what was
 * written, the person's edits included, so the model can say what it saved.
 */
export function savedChanges(preview: AssistantProposalPreview): SavedChange[] {
  switch (preview.kind) {
    case 'attendance_day':
    case 'staff_attendance_day':
      return preview.rows.filter((row) => row.proposed !== row.current).map((row) => ({ name: row.name, mark: row.proposed }))
    case 'exam_marks': {
      const labels = new Map(preview.components.map((part) => [part.component, part.label]))
      return preview.rows.flatMap((row) =>
        row.cells
          .filter((cell) => cell.proposed !== null && stableJson(cell.proposed) !== stableJson(cell.current))
          .map((cell) => ({ name: row.name, part: labels.get(cell.component) ?? cell.component, value: cell.proposed as string | number })),
      )
    }
    case 'co_scholastic':
      return preview.rows.flatMap((row) => {
        const grades = Object.fromEntries(
          Object.entries(row.proposed).filter(([area, grade]) => grade !== row.current[area as keyof typeof row.current]),
        )
        const remarkChanged = (row.proposedRemarks ?? null) !== (row.currentRemarks ?? null)
        return Object.keys(grades).length > 0 || remarkChanged ? [{ name: row.name, grades, remarkChanged }] : []
      })
  }
}

export function forModelOf(row: ProposalRow, key: string): ProposalForModel {
  const status = row.lapsed ? 'expired' : row.status
  const confirmed =
    status === 'done' && row.confirmed_preview_sealed !== null
      ? AssistantProposalPreview.safeParse(JSON.parse(open(row.confirmed_preview_sealed, key)))
      : undefined
  const saved = confirmed?.success ? savedChanges(confirmed.data) : undefined
  return {
    proposalId: row.id,
    title: open(row.title_sealed, key),
    status,
    outcome: row.outcome,
    ...(row.edited === null ? {} : { edited: row.edited }),
    ...(saved === undefined ? {} : { saved: saved.slice(0, SAVED_MAX) }),
    ...(saved !== undefined && saved.length > SAVED_MAX ? { savedMore: saved.length - SAVED_MAX } : {}),
  }
}

interface MessageLike {
  readonly id: string
  readonly role: string
  readonly parts: readonly Record<string, unknown>[]
}

/**
 * The same messages with each proposal tool part's `forModel` replaced by
 * where that proposal stands now. Only the copy sent to the model changes.
 */
export function replayProposals<T extends MessageLike>(
  messages: readonly T[],
  states: ReadonlyMap<string, ProposalForModel>,
): T[] {
  if (states.size === 0) return [...messages]
  return messages.map((message) => {
    let changed = false
    const parts = message.parts.map((part) => {
      const output = part.output as { status?: unknown; proposal?: { id?: unknown } } | undefined
      const id = output?.status === 'ok' ? output.proposal?.id : undefined
      const state = typeof id === 'string' ? states.get(id) : undefined
      if (!state) return part
      changed = true
      return { ...part, output: { ...output, forModel: state } }
    })
    return changed ? { ...message, parts } : message
  })
}
