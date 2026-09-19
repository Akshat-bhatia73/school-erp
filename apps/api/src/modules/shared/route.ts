import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { PERMISSION_CATALOGUE, PermissionKey } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import { AuthorizationError } from '@erp/authz'
import { ApiFailure } from '../../http/errors.ts'
import { requireMembership } from '../../auth/guards.ts'
import { parseBody, requiredParam } from '../../memberships/lifecycle.ts'
import { authorizeSchoolAction } from '../../memberships/authorize.ts'
import type { AccessDependencies } from '../../memberships/routes.ts'
import type { DocumentStorage } from '../../files/storage.ts'
import type { ApiConfig } from '../../config.ts'
import { writeAudit } from './audit.ts'
import { reportDenialBurst } from '../../observability.ts'

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
  /**
   * A read of one person's record. When the handler answered, one `allowed`
   * audit row names that record, so a school can ask who read it. Lists carry
   * no entry: the volume would be the roster, not the reading.
   */
  readonly auditRead?: {
    readonly targetType: string
    /** The path parameter naming the record that was read. */
    readonly param: string
    readonly summary: string
    /** Safe facts about what was returned, for example which blocks. */
    readonly detail?: (result: NoInfer<TResponse>) => Record<string, unknown>
  }
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


/** Denied rows in this window are what a burst is counted over. */
const DENIAL_WINDOW = '10 minutes'
const DENIAL_BURST = 20

/** True for the gate's refusal and for a handler's own record refusal. */
function isAccessDenied(error: unknown): boolean {
  if (error instanceof ApiFailure) return error.code === 'ACCESS_DENIED'
  return error instanceof AuthorizationError && error.code === 'ACCESS_DENIED'
}

const UUID_PARAM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The value of a path parameter when it is a well-formed uuid, else null. */
function optionalUuidParam(params: unknown, name: string): string | null {
  const value = (params as Record<string, unknown> | null)?.[name]
  return typeof value === 'string' && UUID_PARAM.test(value) ? value : null
}

/**
 * The refusal itself is a school event: it answers "who tried what" on the
 * audit screen. It is written after the transaction that refused has rolled
 * back, in a fresh one, so the row survives the refusal.
 */
async function recordDenial(
  deps: ModuleDependencies,
  context: RequestContext,
  permission: PermissionKey,
  request: FastifyRequest,
  auditParam: string | undefined,
): Promise<void> {
  const route = request.routeOptions.url ?? request.url
  await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
    await writeAudit(conn, context, {
      action: permission,
      targetType: PERMISSION_CATALOGUE[permission].resourceType,
      // A refused read of one record names that record, so the person it is
      // about sees who was turned away as well as who was let in.
      targetId: auditParam === undefined ? null : optionalUuidParam(request.params, auditParam),
      result: 'denied',
      summary: `Refused: ${permission} on ${route}.`,
      safeChanges: { route, method: request.method },
    })
    const counted = await conn.client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE school_id = $1 AND actor_membership_id = $2 AND result = 'denied'
          AND created_at > now() - interval '${DENIAL_WINDOW}'`,
      [context.schoolId, context.membershipId],
    )
    const count = Number(counted.rows[0]?.count ?? '0')
    // Exactly at the threshold, never above it: one report per membership for
    // each time a window crosses, not one for every refusal after that.
    if (count === DENIAL_BURST)
      reportDenialBurst({
        schoolId: context.schoolId,
        membershipId: context.membershipId,
        count,
      })
  })
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

      let result: TResponse
      try {
        // The aggregate decision: the same evaluator, against the school as a
        // whole, so a relationship scope answers when the member has that
        // relationship at all. It runs in its own short transaction because the
        // handler owns the one its reads and writes share.
        await withTenantTransaction(deps.pools.runtime, context, (conn) =>
          authorizeSchoolAction(conn, context, definition.permission),
        )

        const body = definition.body ? parseBody(request.body, definition.body) : (undefined as TBody)
        result = await definition.handler({
          context,
          query: parseQuery(definition.query, request.query),
          body,
          permission: definition.permission,
          request,
          reply,
          param: (name: string) => requiredParam(request.params, name),
        })
      } catch (error) {
        if (isAccessDenied(error)) {
          // The refusal is recorded, never re-raised from the recording: a
          // failed audit must not turn a 403 into a 500.
          await recordDenial(
            deps,
            context,
            definition.permission,
            request,
            definition.auditRead?.param,
          ).catch((failure: unknown) =>
            request.log.error({ requestId: request.id, err: failure }, 'denied audit row failed'),
          )
        }
        throw error
      }

      const checked = definition.response.safeParse(result)
      if (!checked.success) {
        // Never send the unchecked object: an unexpected field is a leak.
        request.log.error(
          { requestId: request.id, route: `${definition.method} ${definition.path}` },
          'response failed its contract',
        )
        throw new ApiFailure('SERVICE_UNAVAILABLE')
      }

      const audit = definition.auditRead
      if (audit) {
        // After the answer, in its own transaction: a read never fails because
        // its audit row did.
        const targetId = requiredParam(request.params, audit.param)
        await withTenantTransaction(deps.pools.runtime, context, (conn) =>
          writeAudit(conn, context, {
            action: definition.permission,
            targetType: audit.targetType,
            targetId,
            summary: audit.summary,
            safeChanges: audit.detail ? audit.detail(result) : {},
          }),
        ).catch((failure: unknown) =>
          request.log.error({ requestId: request.id, err: failure }, 'read audit row failed'),
        )
      }

      const status = definition.successStatus ?? 200
      if (status === 204) return reply.status(204).send()
      return reply.status(status).send(checked.data)
    },
  })
}
