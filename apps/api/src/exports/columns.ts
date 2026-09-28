import { sql, type SQL } from 'drizzle-orm'
import { AuthorizationError, planPredicate, scopedTableFor, type AuthzConnection } from '@erp/authz'
import type { PermissionKey, ResourceType } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { readPlan } from '../modules/shared/authorize.ts'

/**
 * The column choice on the student and staff list exports (decision 6 of the
 * admin feedback pass). A column may need a key on top of the export key; the
 * route refuses a column whose key the caller holds in no scope at all, and
 * the producer decides that key again for every row in SQL, so a row outside
 * the key's scope gets an empty cell and never the value.
 */
export interface ColumnSpec {
  readonly label: string
  readonly permission?: PermissionKey
}

/** The extra key one column needs, or undefined when the export key is enough. */
export function permissionOf<K extends string>(
  specs: Readonly<Record<K, ColumnSpec>>,
  key: K,
): PermissionKey | undefined {
  return specs[key].permission
}

/** The extra keys a column list needs, each once, in the order first named. */
function keysOf<K extends string>(
  columns: readonly K[],
  specs: Readonly<Record<K, ColumnSpec>>,
): PermissionKey[] {
  const keys: PermissionKey[] = []
  for (const column of columns) {
    const permission = permissionOf(specs, column)
    if (permission !== undefined && !keys.includes(permission)) keys.push(permission)
  }
  return keys
}

/**
 * Refuses the request when any chosen column needs a key the caller holds in
 * no scope. Building the read plan is the check: it throws ACCESS_DENIED for a
 * key with no grant at all (and MFA_REQUIRED for one only a verified session
 * may use), exactly as the list route for that key would.
 */
export async function assertColumnKeysHeld<K extends string>(
  conn: AuthzConnection,
  context: RequestContext,
  columns: readonly K[],
  specs: Readonly<Record<K, ColumnSpec>>,
  resourceType: ResourceType,
): Promise<void> {
  for (const permission of keysOf(columns, specs)) {
    await readPlan(conn, context, permission, resourceType)
  }
}

/**
 * The plan predicate of every extra key the chosen columns need, over the
 * resource's own table. A key the caller no longer holds when the file is made
 * (access changed after the job was asked for) is FALSE, so its cells are
 * empty rather than the whole file failing.
 */
export async function columnPredicates<K extends string>(
  conn: AuthzConnection,
  context: RequestContext,
  columns: readonly K[],
  specs: Readonly<Record<K, ColumnSpec>>,
  resourceType: ResourceType,
): Promise<ReadonlyMap<PermissionKey, SQL>> {
  const table = scopedTableFor(resourceType)
  if (!table) throw new Error(`the authorizer has no scoped table for ${resourceType}`)
  const predicates = new Map<PermissionKey, SQL>()
  for (const permission of keysOf(columns, specs)) {
    try {
      predicates.set(permission, planPredicate(await readPlan(conn, context, permission, resourceType), table))
    } catch (error) {
      if (error instanceof AuthorizationError) predicates.set(permission, sql`FALSE`)
      else throw error
    }
  }
  return predicates
}

/** The value when the row passes the column's key, else NULL (an empty cell). */
export function guarded(
  value: SQL,
  permission: PermissionKey | undefined,
  predicates: ReadonlyMap<PermissionKey, SQL>,
): SQL {
  if (permission === undefined) return value
  const predicate = predicates.get(permission) ?? sql`FALSE`
  return sql`CASE WHEN (${predicate}) THEN ${value} END`
}

/** The chosen columns in the order of the column list, whatever order the request used. */
export function inListOrder<K extends string>(
  columns: readonly K[],
  specs: Readonly<Record<K, unknown>>,
): K[] {
  const chosen = new Set(columns)
  return (Object.keys(specs) as K[]).filter((key) => chosen.has(key))
}
