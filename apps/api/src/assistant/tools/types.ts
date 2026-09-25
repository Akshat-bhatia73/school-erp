import type { z } from 'zod'
import type { AssistantCard, AssistantSource, PermissionKey } from '@erp/contracts'

/**
 * What one of our own routes answered when a tool called it as the person.
 * `ok: false` carries the route's own error code: ACCESS_DENIED and NOT_FOUND
 * are the same thing to a tool ("not available to you"), exactly as a screen
 * cannot tell them apart.
 */
export type RouteAnswer =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | { readonly ok: false; readonly status: number; readonly code: string }

/** Everything a read tool may use. It holds no database handle on purpose. */
export interface ToolCallContext {
  readonly schoolId: string
  /** Today in the school's timezone, YYYY-MM-DD. */
  readonly today: string
  /** The current academic year's id, when the school has one the person can read. */
  readonly academicYearId: string | null
  /**
   * GET one of our own protected routes as the person asking, through the
   * whole route pipeline (session, membership, permission gate, plan scope,
   * response contract, read audit). `path` is relative to
   * /api/schools/:schoolId, for example `/students/search`. Query values are
   * sent as strings.
   */
  get(path: string, query?: Readonly<Record<string, string | number | boolean | undefined>>): Promise<RouteAnswer>
}

export type ReadToolOutcome =
  | {
      readonly status: 'ok'
      /** How the browser draws the result. */
      readonly card?: AssistantCard
      /** Where it came from; shown under the answer. */
      readonly source?: AssistantSource
      /**
       * What the model reads: the fields it needs to answer and to chain the
       * next call (ids included), nothing more. Plain JSON.
       */
      readonly forModel: unknown
    }
  | { readonly status: 'not_available' }
  | { readonly status: 'failed' }

export interface ReadToolDefinition<TInput> {
  /** snake_case, unique, stable: it is kept in conversations. */
  readonly name: string
  /** One or two plain sentences for the model: what it returns and when to use it. */
  readonly description: string
  /**
   * The permission the route behind it declares. The tool is offered only to
   * a person who holds it somewhere in the school. This keeps the model from
   * wasting steps; it is not the security boundary, the route is.
   */
  readonly permission: PermissionKey
  readonly input: z.ZodType<TInput>
  run(input: TInput, context: ToolCallContext): Promise<ReadToolOutcome>
}

export type AnyReadTool = ReadToolDefinition<never>

/** Identity helper so a definition keeps its input type. */
export function readTool<TInput>(definition: ReadToolDefinition<TInput>): ReadToolDefinition<TInput> {
  return definition
}

/** Turn a route answer into the outcome a tool returns when the route refused or failed. */
export function refusal(answer: Extract<RouteAnswer, { ok: false }>): ReadToolOutcome {
  if (answer.status === 403 || answer.status === 404) return { status: 'not_available' }
  return { status: 'failed' }
}
