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
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`
const COLUMNS = `id, thread_id, kind, tool_name, title_sealed, preview_sealed, confirmed_preview_sealed, check_path, check_digest,
  status, outcome, write_request_id, edited,
  to_char(expires_at AT TIME ZONE 'UTC', ${ISO}) AS expires_at,
  to_char(decided_at AT TIME ZONE 'UTC', ${ISO}) AS decided_at,
  (status = 'open' AND expires_at <= now()) AS lapsed`

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
  readonly status: Exclude<AssistantProposalStatus, 'open'>
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
}

export function forModelOf(row: ProposalRow, key: string): ProposalForModel {
  return {
    proposalId: row.id,
    title: open(row.title_sealed, key),
    status: row.lapsed ? 'expired' : row.status,
    outcome: row.outcome,
    ...(row.edited === null ? {} : { edited: row.edited }),
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
