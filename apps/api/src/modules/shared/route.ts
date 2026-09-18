import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { PERMISSION_CATALOGUE, PermissionKey } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import { ApiFailure } from '../../http/errors.ts'
import { requireMembership } from '../../auth/guards.ts'
import { parseBody, requiredParam } from '../../memberships/lifecycle.ts'
import { authorizeSchoolAction } from '../../memberships/authorize.ts'
import type { AccessDependencies } from '../../memberships/routes.ts'
import type { DocumentStorage } from '../../files/storage.ts'
import type { ApiConfig } from '../../config.ts'

export interface ModuleDependencies extends AccessDependencies {
  /** Read once at startup; modules use it for the data encryption key. */
  readonly config: ApiConfig
  /** Private document bytes. Keys are server state and are never returned. */
  readonly documents: DocumentStorage
}

export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** Everything a module handler is allowed to trust about the request. */
export interface RouteInput<TQuery, TBody> {
  readonly context: RequestContext
  readonly query: TQuery
  readonly body: TBody
  readonly permission: PermissionKey
  readonly request: FastifyRequest
  readonly reply: FastifyReply
  /** A path parameter, or INVALID_REQUEST when it is missing. */
  param(name: string): string
}

export interface RouteDefinition<TQuery, TBody, TResponse> {
  readonly method: RouteMethod
  readonly path: string
  /**
   * The permission this route exists for. Before the handler runs it is
   * decided against the whole school dataset, so a member who holds it
   * nowhere in the school never reaches the handler. The handler still decides
   * each record and each projection; this gate is the floor, not the ceiling.
   */
  readonly permission: PermissionKey
  readonly query?: z.ZodType<TQuery>
  readonly body?: z.ZodType<TBody>
  /** Every response is parsed through this before it is sent. */
  readonly response: z.ZodType<TResponse>
  /** 200 for a read, 201 for a create, 202 for queued work. */
  readonly successStatus?: 200 | 201 | 202 | 204
  handler(input: RouteInput<TQuery, TBody>): Promise<TResponse>
}

/** Query values arrive as strings; only decimal digits become a number. */
function asNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) return Number.NaN
  return Number(value)
}

/** True when this key is declared as a number, through optionals and defaults. */
function isNumericField(field: z.ZodType): boolean {
  let current: unknown = field
  for (let depth = 0; depth < 10; depth += 1) {
    if (current instanceof z.ZodNumber) return true
    const inner = (current as { def?: { innerType?: unknown } }).def?.innerType
    if (inner === undefined) return false
    current = inner
  }
  return false
}

/**
 * The keys a schema declares as numbers. Converting only those keeps a string
 * field a string, so a schema stays the single description of the query.
 */
function numericKeys(schema: z.ZodType): ReadonlySet<string> {
  const keys = new Set<string>()
  const shape = schema instanceof z.ZodObject ? (schema.shape as Record<string, z.ZodType>) : undefined
  if (!shape) return keys
  for (const [name, field] of Object.entries(shape)) {
    if (isNumericField(field)) keys.add(name)
  }
  return keys
}

function parseQuery<T>(schema: z.ZodType<T> | undefined, raw: unknown): T {
  if (!schema) return undefined as T
  const source = (raw ?? {}) as Record<string, unknown>
  const numeric = numericKeys(schema)
  const converted: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    converted[name] = numeric.has(name) ? asNumber(value) : value
  }
  const parsed = schema.safeParse(converted)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  return parsed.data
}

/**
 * One shape for every module route: a verified membership, the declared
 * permission decided before the handler runs, a parsed request and a response
 * that is checked before it leaves. A handler that forgets a record check is
 * still bounded by the gate, and a projection bug fails loudly instead of
 * leaking the fields it forgot to drop.
 */
export function protectedRoute<TQuery, TBody, TResponse>(
  app: FastifyInstance,
  deps: ModuleDependencies,
  definition: RouteDefinition<TQuery, TBody, TResponse>,
): void {
  // Fail closed at startup: a route with no permission could never be
  // authorized, so it must not exist at all.
  if (!PermissionKey.safeParse(definition.permission).success) {
    throw new Error(`Route ${definition.method} ${definition.path} declares no known permission`)
  }
  if (PERMISSION_CATALOGUE[definition.permission].availability !== 'active') {
    throw new Error(`Route ${definition.method} ${definition.path} uses a reserved permission`)
  }

  app.route({
    method: definition.method,
    url: definition.path,
    preHandler: requireMembership(deps),
    handler: async (request, reply) => {
      const context = request.context
      if (!context) throw new ApiFailure('AUTHENTICATION_REQUIRED')

      // The aggregate decision: the same evaluator, against the school as a
      // whole, so a relationship scope answers when the member has that
      // relationship at all. It runs in its own short transaction because the
      // handler owns the one its reads and writes share.
      await withTenantTransaction(deps.pools.runtime, context, (conn) =>
        authorizeSchoolAction(conn, context, definition.permission),
      )

      const body = definition.body ? parseBody(request.body, definition.body) : (undefined as TBody)
      const result = await definition.handler({
        context,
        query: parseQuery(definition.query, request.query),
        body,
        permission: definition.permission,
        request,
        reply,
        param: (name: string) => requiredParam(request.params, name),
      })

      const checked = definition.response.safeParse(result)
      if (!checked.success) {
        // Never send the unchecked object: an unexpected field is a leak.
        request.log.error(
          { requestId: request.id, route: `${definition.method} ${definition.path}` },
          'response failed its contract',
        )
        throw new ApiFailure('SERVICE_UNAVAILABLE')
      }
      const status = definition.successStatus ?? 200
      if (status === 204) return reply.status(204).send()
      return reply.status(status).send(checked.data)
    },
  })
}
