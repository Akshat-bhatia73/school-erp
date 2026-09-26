import type { z } from 'zod'
import type { AssistantProposalKind, AssistantProposalPreview, PermissionKey } from '@erp/contracts'
import type { ToolCallContext } from '../tools/types.ts'

/**
 * A change tool (24b). It never writes. `prepare` reads what it needs through
 * the same GET routes a screen uses and returns a proposal draft: an editable
 * preview and the GET route it was read from. The framework saves it, and when
 * the person confirms, calls `write` with the preview as they left it to get
 * the one request the real write route expects, then sends that request as
 * the person. See docs/assistant/ARCHITECTURE.md section 5.
 */

export type WriteMethod = 'POST' | 'PUT' | 'PATCH'

/** One call to an existing write route, relative to /api/schools/:schoolId. */
export interface WriteRequest {
  readonly method: WriteMethod
  readonly path: string
  readonly body: unknown
}

export interface ProposalDraft<TPreview extends AssistantProposalPreview> {
  readonly kind: AssistantProposalKind
  /** "Mark 9 A for 26 Sep 2026". Plain words, no ids. */
  readonly title: string
  readonly preview: TPreview
  /**
   * The GET route (relative to /api/schools/:schoolId, with its query) whose
   * answer the preview was built from. The framework keeps a digest of that
   * answer and reads it again before writing; if it changed, nothing is
   * written and the proposal is stale.
   */
  readonly checkPath: string
  /** What the model is told: a one-line summary it can repeat, and counts. */
  readonly forModel: unknown
  /** Where the record lives in the app, shown once it is done. */
  readonly href?: string
}

export type PrepareOutcome<TPreview extends AssistantProposalPreview> =
  | { readonly status: 'ok'; readonly draft: ProposalDraft<TPreview> }
  /** The route refused or the record is missing, exactly as a screen would see it. */
  | { readonly status: 'not_available' }
  /** The request cannot be proposed as asked; `problem` says why in plain words for the model to pass on. */
  | { readonly status: 'invalid'; readonly problem: string }
  | { readonly status: 'failed' }

export interface ProposeToolDefinition<TInput, TPreview extends AssistantProposalPreview> {
  /** snake_case, starts with `propose_`, stable: it is kept in conversations. */
  readonly name: string
  /** For the model: what it proposes and when to use it. */
  readonly description: string
  readonly kind: TPreview['kind']
  /**
   * The permission of the write route behind it, used only to offer the tool
   * to a person who holds it somewhere. The write route decides for real.
   */
  readonly permission: PermissionKey
  /** Small inputs a small model can fill: names are matched to ids by the tool. */
  readonly input: z.ZodType<TInput>
  /** The preview's own schema, used to check the edited preview on Confirm. */
  readonly preview: z.ZodType<TPreview>
  prepare(input: TInput, context: ToolCallContext): Promise<PrepareOutcome<TPreview>>
  /**
   * True when `edited` is the same change as `original` with only the
   * editable fields changed: same record, same rows, in the same order.
   * Anything else is refused before any write.
   */
  sameTarget(original: TPreview, edited: TPreview): boolean
  /**
   * The write for a preview, or a plain-English problem when the edited
   * preview cannot be written (a correction with no reason, nothing changed).
   */
  write(preview: TPreview): WriteRequest | { readonly problem: string }
  /** Plain words for a done proposal: "Saved 9 A's register: 38 present, 2 absent." */
  describeDone(preview: TPreview): string
}

export type AnyProposeTool = ProposeToolDefinition<never, never>

/** Identity helper so a definition keeps its types. */
export function proposeTool<TInput, TPreview extends AssistantProposalPreview>(
  definition: ProposeToolDefinition<TInput, TPreview>,
): ProposeToolDefinition<TInput, TPreview> {
  return definition
}
