import { sql, type SQL } from 'drizzle-orm'
import {
  AuthorizationError,
  homeworkScopedTable,
  planPredicate,
  planPredicateWithout,
  scopedTableFor,
  type AuthzConnection,
} from '@erp/authz'
import {
  AccessScope,
  HOMEWORK_TEACHER_CHECK_DAYS,
  type ErrorReason,
  type HomeworkCheckWindow,
  type PermissionKey,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure, decideResource, readPlan, schoolToday } from '../shared/index.ts'

/**
 * What the homework routes share (Task 25, migration 0030).
 *
 * Every read ANDs the caller's own plans into SQL over the three faces of the
 * `homework` resource type (the item, a pupil's check-off and the pupil), so
 * a list holds an item only when its detail read would answer it. A family
 * reads an item through a child enrolled in its class on the day it was set,
 * and the child's own check-off; staff read the item with its figures. Which
 * of the two answers an item gets is decided by the plan too: an item reached
 * through a scope other than own_children and own_record is a staff item.
 */

export { schoolToday }

export type HomeworkConnection = AuthzConnection

export type HomeworkPermission = 'homework.read' | 'homework.set' | 'homework.check' | 'homework.export'

export const READ: PermissionKey = 'homework.read'
export const SET: PermissionKey = 'homework.set'
export const CHECK: PermissionKey = 'homework.check'
export const EXPORT: PermissionKey = 'homework.export'

/** The keys an item's own allowedActions may carry. Export is a list action, never one item's. */
const ITEM_ACTIONS: readonly PermissionKey[] = [READ, SET, CHECK]

const FAMILY_SCOPES: readonly AccessScope[] = ['own_children', 'own_record']
const NON_FAMILY_SCOPES: readonly AccessScope[] = AccessScope.options.filter((scope) => !FAMILY_SCOPES.includes(scope))
const NON_SCHOOL_SCOPES: readonly AccessScope[] = AccessScope.options.filter((scope) => scope !== 'school')

export const ISO_TIMESTAMP = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`

/** A timestamp column as the contract's ISO string, in UTC. */
export function isoOf(column: SQL): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', ${sql.raw(ISO_TIMESTAMP)})`
}

/** An ISO date moved by whole days, without touching the local clock. */
export function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`)
  moved.setUTCDate(moved.getUTCDate() + days)
  return moved.toISOString().slice(0, 10)
}

/** A name as a roster prints it, never longer than the contract allows. */
export function pupilName(first: string, last: string | null): string {
  return [first, last].filter((part) => part !== null && part !== '').join(' ').trim().slice(0, 160)
}

/** A stored name, or undefined when there is none to show. */
export function shownName(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim().slice(0, 160) ?? ''
  return trimmed === '' ? undefined : trimmed
}

async function orFalse(build: () => Promise<SQL>): Promise<SQL> {
  try {
    return await build()
  } catch (error) {
    if (error instanceof AuthorizationError) return sql`FALSE`
    throw error
  }
}

function scoped(kind: 'student' | 'staff') {
  const table = scopedTableFor(kind)
  if (!table) throw new Error(`the authorizer has no scoped table for ${kind}`)
  return table
}

// ---------------------------------------------------------------------------
// Plans.

export interface HomeworkReadPlans {
  /** Over `homework`: every item the caller may read. */
  readonly items: SQL
  /** Over `homework`: the items reached other than as a family (staff items, with figures). */
  readonly staffItems: SQL
  /** Over `homework_checks`: every check-off the caller may read. */
  readonly checks: SQL
  /** Over `students`: the caller's own children (or themself), AND named. */
  readonly familyPupils: SQL
  /** Over `students`: the pupils reached other than as a family, AND named. */
  readonly staffPupils: SQL
  /** Over `staff`: whose names the caller may read in the directory. */
  readonly directory: SQL
}

/** The caller's plans under homework.read. Throws when they hold it nowhere. */
export async function homeworkReadPlans(conn: HomeworkConnection, context: RequestContext): Promise<HomeworkReadPlans> {
  const plan = await readPlan(conn, context, READ, 'homework')
  const basic = await orFalse(async () =>
    planPredicate(await readPlan(conn, context, 'students.read_basic', 'student'), scoped('student')),
  )
  const directory = await orFalse(async () =>
    planPredicate(await readPlan(conn, context, 'staff.read_directory', 'staff'), scoped('staff')),
  )
  return {
    items: planPredicate(plan, homeworkScopedTable('item')),
    staffItems: planPredicateWithout(plan, homeworkScopedTable('item'), FAMILY_SCOPES),
    checks: planPredicate(plan, homeworkScopedTable('check')),
    familyPupils: sql`(${planPredicateWithout(plan, homeworkScopedTable('pupil'), NON_FAMILY_SCOPES)}) AND (${basic})`,
    staffPupils: sql`(${planPredicateWithout(plan, homeworkScopedTable('pupil'), FAMILY_SCOPES)}) AND (${basic})`,
    directory,
  }
}

export interface HomeworkWritePlans {
  /** Over `homework`: the items the caller may set (or check). */
  readonly items: SQL
  /** Over `homework_checks`: the check-offs under the same key. */
  readonly checks: SQL
  /**
   * Over `homework`: the items reached through the school-wide grant, the
   * office's. A teacher's check-off window closes HOMEWORK_TEACHER_CHECK_DAYS
   * after the due date; the office's never does. Decided by the plan, never
   * by a role name.
   */
  readonly office: SQL
}

/** The caller's plans under homework.set or homework.check; FALSE throughout when they hold it nowhere. */
export async function homeworkWritePlans(
  conn: HomeworkConnection,
  context: RequestContext,
  permission: 'homework.set' | 'homework.check',
): Promise<HomeworkWritePlans> {
  try {
    const plan = await readPlan(conn, context, permission, 'homework')
    return {
      items: planPredicate(plan, homeworkScopedTable('item')),
      checks: planPredicate(plan, homeworkScopedTable('check')),
      office: planPredicateWithout(plan, homeworkScopedTable('item'), NON_SCHOOL_SCOPES),
    }
  } catch (error) {
    if (error instanceof AuthorizationError) return { items: sql`FALSE`, checks: sql`FALSE`, office: sql`FALSE` }
    throw error
  }
}

/** Whether one item passes a predicate over the unaliased `homework` table. */
export async function itemMatches(
  conn: HomeworkConnection,
  schoolId: string,
  homeworkId: string,
  predicate: SQL,
): Promise<boolean> {
  const rows = await conn.db.execute<{ found: boolean }>(
    sql`SELECT EXISTS (SELECT 1 FROM homework
          WHERE homework.school_id = ${schoolId}::uuid AND homework.id = ${homeworkId}::uuid
            AND (${predicate})) AS found`,
  )
  return rows.rows[0]?.found === true
}

// ---------------------------------------------------------------------------
// Decisions on one item.

/**
 * Decide one key on one item. A caller who may not even read it is told it
 * is not there; one who reads it but may not do this is refused.
 */
export async function decideHomework(
  conn: HomeworkConnection,
  context: RequestContext,
  permission: HomeworkPermission,
  id: string,
): Promise<void> {
  const decision = await decideResource(conn, context, permission, 'homework', id)
  if (decision.allowed) return
  if (decision.code === 'MFA_REQUIRED') throw new ApiFailure('MFA_REQUIRED')
  if (permission !== 'homework.read' && (await decideResource(conn, context, READ, 'homework', id)).allowed) {
    throw new ApiFailure('ACCESS_DENIED')
  }
  throw new ApiFailure('RESOURCE_NOT_FOUND')
}

/** The item keys the caller holds on this item, from the evaluator's own answer. */
export function itemActions(decided: readonly PermissionKey[] | undefined, removed: boolean): PermissionKey[] {
  // A removed item stays exactly as it was: nothing more is set or checked on it.
  return (decided ?? []).filter((key) => ITEM_ACTIONS.includes(key) && (!removed || key === READ))
}

// ---------------------------------------------------------------------------
// The item's own row, for a write. The item has been decided, so the read is
// bounded by the school alone.

export interface ItemRow extends Record<string, unknown> {
  id: string
  version: number
  academic_year_id: string
  section_id: string
  subject_id: string | null
  set_on: string
  due_on: string
  year_end: string
  removed: boolean
}

export async function readItemRow(
  conn: HomeworkConnection,
  schoolId: string,
  homeworkId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<ItemRow> {
  const rows = await conn.client.query<ItemRow>(
    `SELECT homework.id, homework.version, homework.academic_year_id, homework.section_id, homework.subject_id,
            to_char(homework.set_on, 'YYYY-MM-DD') AS set_on, to_char(homework.due_on, 'YYYY-MM-DD') AS due_on,
            to_char(ay.end_date, 'YYYY-MM-DD') AS year_end, homework.removed_at IS NOT NULL AS removed
       FROM homework
       JOIN academic_years ay ON ay.school_id = homework.school_id AND ay.id = homework.academic_year_id
      WHERE homework.school_id = $1 AND homework.id = $2
      ${options.forUpdate === true ? 'FOR UPDATE OF homework' : ''}`,
    [schoolId, homeworkId],
  )
  const row = rows.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return { ...row, version: Number(row.version), removed: row.removed === true }
}

/** A removed item answers every change with the same reason. */
export function assertNotRemoved(row: ItemRow): void {
  if (row.removed) throw new ApiFailure('INVALID_REQUEST', undefined, 'homework_removed')
}

// ---------------------------------------------------------------------------
// The check-off window.

export function teacherClosesOn(dueOn: string): string {
  return addDays(dueOn, HOMEWORK_TEACHER_CHECK_DAYS)
}

/**
 * When check-offs may be saved, worked out once so the screen and the write
 * agree. Check-offs open on the due date; a teacher may change them until
 * HOMEWORK_TEACHER_CHECK_DAYS after it, the office (`office`, from the plan)
 * at any time. A caller without the key is given no reason.
 */
export function checkWindow(input: {
  readonly dueOn: string
  readonly today: string
  readonly removed: boolean
  readonly mayCheck: boolean
  readonly office: boolean
}): HomeworkCheckWindow {
  const closesOn = teacherClosesOn(input.dueOn)
  const state = input.today < input.dueOn ? 'not_due' : input.today <= closesOn ? 'open' : 'closed'
  const reason: ErrorReason | undefined = input.removed
    ? 'homework_removed'
    : state === 'not_due'
      ? 'homework_not_due_yet'
      : state === 'closed' && !input.office
        ? 'homework_check_window_closed'
        : undefined
  const check = input.mayCheck && reason === undefined
  return {
    state,
    teacherClosesOn: closesOn,
    check,
    ...(input.mayCheck && reason !== undefined ? { checkBlockedBy: reason } : {}),
  }
}

/** The same window as a refusal, for a write. */
export function assertWindowOpen(window: HomeworkCheckWindow): void {
  if (window.checkBlockedBy !== undefined) throw new ApiFailure('INVALID_REQUEST', undefined, window.checkBlockedBy)
  if (!window.check) throw new ApiFailure('ACCESS_DENIED')
}

// ---------------------------------------------------------------------------
// The roster: the pupils enrolled in the item's section on its due date.

/** FROM ... WHERE for the roster of the item named by `item` (a homework row or alias). */
export function rosterFrom(input: { readonly item: SQL; readonly pupils: SQL }): SQL {
  return sql`FROM enrollments en
      JOIN students ON students.school_id = en.school_id AND students.id = en.student_id
     WHERE en.school_id = ${input.item}.school_id
       AND en.section_id = ${input.item}.section_id
       AND en.academic_year_id = ${input.item}.academic_year_id
       AND en.joined_on <= ${input.item}.due_on
       AND (en.left_on IS NULL OR en.left_on >= ${input.item}.due_on)
       AND (${input.pupils})`
}

/** The staff name of a member, only when the caller may read that staff record in the directory. */
export function memberName(schoolId: string, membership: SQL, directory: SQL): SQL {
  return sql`(SELECT staff.first_name || COALESCE(' ' || NULLIF(staff.last_name, ''), '')
      FROM membership_staff_links msl
      JOIN staff ON staff.school_id = msl.school_id AND staff.id = msl.staff_id
     WHERE msl.school_id = ${schoolId}::uuid AND msl.membership_id = ${membership}
       AND (${directory})
     LIMIT 1)`
}
