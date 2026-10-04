import { sql, type SQL } from 'drizzle-orm'
import {
  HOMEWORK_LIST_MAX,
  HOMEWORK_ROSTER_MAX,
  HOMEWORK_TEACHER_CHECK_DAYS,
  type DashboardHomeworkDue,
  type DashboardHomeworkDueItem,
  type DashboardHomeworkToCheckItem,
  type HomeworkAttachmentView,
  type HomeworkCheckSheet,
  type HomeworkCheckStatus,
  type HomeworkChildStatus,
  type HomeworkDetail,
  type HomeworkListItem,
  type HomeworkListRequest,
  type HomeworkListResponse,
  type HomeworkPupilStatus,
  type PermissionKey,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { allowedActionsForMany, ApiFailure, decideSchoolAction } from '../shared/index.ts'
import {
  addDays,
  CHECK,
  checkWindow,
  EXPORT,
  homeworkReadPlans,
  homeworkWritePlans,
  isoOf,
  itemActions,
  itemMatches,
  memberName,
  pupilName,
  READ,
  rosterFrom,
  schoolToday,
  SET,
  shownName,
  type HomeworkConnection,
  type HomeworkReadPlans,
} from './common.ts'

/**
 * The readers behind the homework screens: the list, one item, and the
 * check-off sheet. Every statement ANDs the caller's own plans into SQL;
 * nothing is fetched school-wide and filtered in JavaScript.
 *
 * One row per item for staff, with the item's figures over its roster; one
 * row per child and item for a family, with that child's own status.
 */

const HOMEWORK = sql.raw('homework')

interface ItemListRow extends Record<string, unknown> {
  id: string
  version: number
  academic_year_id: string
  year_name: string
  section_id: string
  section_name: string
  grade_id: string
  grade_name: string
  subject_id: string | null
  subject_name: string | null
  title: string
  set_on: string
  due_on: string
  set_by: string | null
  attachment_count: number
  removed_at: string | null
  staff_view: boolean
  child_id: string | null
  child_first_name: string | null
  child_last_name: string | null
  child_status: HomeworkCheckStatus | null
  child_remark: string | null
  child_checked_at: string | null
  pupils: number | null
  done: number | null
  partly_done: number | null
  not_done: number | null
  // Detail only.
  instructions?: string
  updated_at?: string
  updated_by?: string | null
  removed_by?: string | null
}

interface SelectInput {
  readonly schoolId: string
  readonly plans: HomeworkReadPlans
  /** Extra conditions over the unaliased `homework` row. */
  readonly where: SQL
  /** Narrow to this pupil: a family's chosen child, or staff reading one pupil. */
  readonly studentId?: string
  /** Only items with a roster pupil not checked yet (staff items). */
  readonly toCheck?: { readonly today: string }
  readonly order: SQL
  readonly limit: number
  /** Also select the words and who changed them, for the detail. */
  readonly detail?: boolean
}

/**
 * The item rows the caller may read, with the family's child (one row each)
 * or the staff figures. A family reads an item through a child enrolled in
 * its class on the day it was set (the plan's own rule); the child's status
 * comes from the child's own check-off, read through the plan.
 */
async function selectItems(conn: HomeworkConnection, input: SelectInput): Promise<ItemListRow[]> {
  const { plans, schoolId } = input
  const kidCondition =
    input.studentId === undefined
      ? sql`NOT sv.staff_view AND (${plans.familyPupils})`
      : sql`students.id = ${input.studentId}::uuid
            AND ((NOT sv.staff_view AND (${plans.familyPupils})) OR (sv.staff_view AND (${plans.staffPupils})))`
  const reached =
    input.studentId === undefined ? sql`(sv.staff_view OR kid.id IS NOT NULL)` : sql`kid.id IS NOT NULL`
  const toCheck =
    input.toCheck === undefined
      ? sql`TRUE`
      : sql`sv.staff_view AND homework.due_on <= ${input.toCheck.today}::date
            AND prog.pupils > prog.done + prog.partly_done + prog.not_done`
  const detailColumns =
    input.detail === true
      ? sql`, homework.instructions, ${isoOf(sql`homework.updated_at`)} AS updated_at,
           ${memberName(schoolId, sql`homework.updated_by_membership_id`, plans.directory)} AS updated_by,
           ${memberName(schoolId, sql`homework.removed_by_membership_id`, plans.directory)} AS removed_by`
      : sql``

  const rows = await conn.db.execute<ItemListRow>(
    sql`SELECT homework.id, homework.version, homework.academic_year_id, ay.name AS year_name,
               homework.section_id, sec.name AS section_name, g.id AS grade_id, g.name AS grade_name,
               homework.subject_id, sub.name AS subject_name, homework.title,
               to_char(homework.set_on, 'YYYY-MM-DD') AS set_on, to_char(homework.due_on, 'YYYY-MM-DD') AS due_on,
               (SELECT staff.first_name || COALESCE(' ' || NULLIF(staff.last_name, ''), '') FROM staff
                 WHERE staff.school_id = homework.school_id AND staff.id = homework.created_by_staff_id
                   AND (${plans.directory})) AS set_by,
               (SELECT count(*)::int FROM homework_attachments att
                 WHERE att.school_id = homework.school_id AND att.homework_id = homework.id) AS attachment_count,
               ${isoOf(sql`homework.removed_at`)} AS removed_at,
               sv.staff_view,
               kid.id AS child_id, kid.first_name AS child_first_name, kid.last_name AS child_last_name,
               kc.status AS child_status, kc.remark AS child_remark, kc.checked_at AS child_checked_at,
               prog.pupils, prog.done, prog.partly_done, prog.not_done
               ${detailColumns}
          FROM homework
          JOIN sections sec ON sec.school_id = homework.school_id AND sec.id = homework.section_id
          JOIN grades g ON g.school_id = sec.school_id AND g.id = sec.grade_id
          JOIN academic_years ay ON ay.school_id = homework.school_id AND ay.id = homework.academic_year_id
          LEFT JOIN subjects sub ON sub.school_id = homework.school_id AND sub.id = homework.subject_id
          CROSS JOIN LATERAL (SELECT COALESCE((${plans.staffItems}), FALSE) AS staff_view) sv
          LEFT JOIN LATERAL (
            SELECT DISTINCT students.id, students.first_name, students.last_name
              FROM enrollments en
              JOIN students ON students.school_id = en.school_id AND students.id = en.student_id
             WHERE en.school_id = homework.school_id AND en.section_id = homework.section_id
               AND en.academic_year_id = homework.academic_year_id
               AND en.joined_on <= homework.set_on AND (en.left_on IS NULL OR en.left_on >= homework.set_on)
               AND ${kidCondition}
          ) kid ON TRUE
          LEFT JOIN LATERAL (
            SELECT homework_checks.status, homework_checks.remark,
                   ${isoOf(sql`homework_checks.checked_at`)} AS checked_at
              FROM homework_checks
             WHERE homework_checks.school_id = homework.school_id AND homework_checks.homework_id = homework.id
               AND homework_checks.student_id = kid.id AND (${plans.checks})
          ) kc ON kid.id IS NOT NULL
          LEFT JOIN LATERAL (
            SELECT count(DISTINCT students.id)::int AS pupils,
                   count(DISTINCT students.id) FILTER (WHERE homework_checks.status = 'done')::int AS done,
                   count(DISTINCT students.id) FILTER (WHERE homework_checks.status = 'partly_done')::int AS partly_done,
                   count(DISTINCT students.id) FILTER (WHERE homework_checks.status = 'not_done')::int AS not_done
              FROM (SELECT students.id ${rosterFrom({ item: HOMEWORK, pupils: plans.staffPupils })}) students
              LEFT JOIN homework_checks ON homework_checks.school_id = homework.school_id
                   AND homework_checks.homework_id = homework.id AND homework_checks.student_id = students.id
                   AND (${plans.checks})
          ) prog ON sv.staff_view
         WHERE homework.school_id = ${schoolId}::uuid
           AND (${plans.items})
           AND (${input.where})
           AND ${reached}
           AND ${toCheck}
         ORDER BY ${input.order}, kid.first_name, kid.id
         LIMIT ${input.limit}`,
  )
  return rows.rows
}

function childStatusOf(row: ItemListRow, today: string): HomeworkPupilStatus {
  if (row.child_status !== null) return row.child_status
  return today < row.due_on ? 'not_due' : 'not_checked'
}

function childOf(row: ItemListRow, today: string): HomeworkChildStatus | undefined {
  if (row.child_id === null) return undefined
  return {
    student: { id: row.child_id, name: pupilName(row.child_first_name ?? '', row.child_last_name) },
    status: childStatusOf(row, today),
    ...(row.child_status !== null && row.child_remark !== null ? { remark: row.child_remark } : {}),
    ...(row.child_status !== null && row.child_checked_at !== null ? { checkedAt: row.child_checked_at } : {}),
  }
}

function toListItem(row: ItemListRow, today: string, actions: readonly PermissionKey[]): HomeworkListItem {
  const setBy = shownName(row.set_by)
  const child = childOf(row, today)
  const pupils = Number(row.pupils ?? 0)
  const done = Number(row.done ?? 0)
  const partlyDone = Number(row.partly_done ?? 0)
  const notDone = Number(row.not_done ?? 0)
  return {
    id: row.id,
    version: Number(row.version),
    academicYear: { id: row.academic_year_id, name: row.year_name },
    section: { id: row.section_id, name: row.section_name },
    grade: { id: row.grade_id, name: row.grade_name },
    ...(row.subject_id !== null && row.subject_name !== null
      ? { subject: { id: row.subject_id, name: row.subject_name } }
      : {}),
    title: row.title,
    setOn: row.set_on,
    dueOn: row.due_on,
    ...(setBy === undefined ? {} : { setBy }),
    attachmentCount: Number(row.attachment_count),
    ...(row.staff_view && row.removed_at !== null ? { removedAt: row.removed_at } : {}),
    ...(row.staff_view
      ? { progress: { pupils, done, partlyDone, notDone, notChecked: Math.max(0, pupils - done - partlyDone - notDone) } }
      : {}),
    ...(child === undefined ? {} : { child }),
    allowedActions: [...actions],
  }
}

async function actionsFor(
  conn: HomeworkConnection,
  context: RequestContext,
  rows: readonly ItemListRow[],
): Promise<Map<string, PermissionKey[]>> {
  const decided = await allowedActionsForMany(
    conn,
    context,
    'homework',
    rows.map((row) => row.id),
  )
  return new Map(rows.map((row) => [row.id, itemActions(decided.get(row.id), row.removed_at !== null)]))
}

/**
 * Whether the caller holds homework.check on this one item, removed or not:
 * a removed item offers no check, but the window still says why.
 */
async function holdsCheck(conn: HomeworkConnection, context: RequestContext, homeworkId: string): Promise<boolean> {
  const decided = await allowedActionsForMany(conn, context, 'homework', [homeworkId])
  return (decided.get(homeworkId) ?? []).includes(CHECK)
}

/** Which keys the caller may use anywhere: whether to offer "Set homework" and the report. */
async function listActions(conn: HomeworkConnection, context: RequestContext): Promise<PermissionKey[]> {
  const actions: PermissionKey[] = [READ]
  for (const key of [SET, CHECK, EXPORT]) {
    if ((await decideSchoolAction(conn, context, key)).allowed) actions.push(key)
  }
  return actions
}

// ---------------------------------------------------------------------------
// The list.

function listWhere(query: HomeworkListRequest, today: string): { where: SQL; order: SQL } {
  const parts: SQL[] = [sql`TRUE`]
  if (query.academicYearId !== undefined) parts.push(sql`homework.academic_year_id = ${query.academicYearId}::uuid`)
  if (query.sectionId !== undefined) parts.push(sql`homework.section_id = ${query.sectionId}::uuid`)
  if (query.subjectId !== undefined) parts.push(sql`homework.subject_id = ${query.subjectId}::uuid`)
  if (query.general === 'true') parts.push(sql`homework.subject_id IS NULL`)
  if (query.general === 'false') parts.push(sql`homework.subject_id IS NOT NULL`)
  if (query.from !== undefined) parts.push(sql`homework.due_on >= ${query.from}::date`)
  if (query.to !== undefined) parts.push(sql`homework.due_on <= ${query.to}::date`)
  switch (query.status) {
    case 'removed':
      // Removed items are staff records; a family's plan never reaches one.
      parts.push(sql`homework.removed_at IS NOT NULL AND sv.staff_view`)
      break
    case 'upcoming':
      parts.push(sql`homework.removed_at IS NULL AND homework.due_on >= ${today}::date`)
      break
    case 'past':
      parts.push(sql`homework.removed_at IS NULL AND homework.due_on < ${today}::date`)
      break
    default:
      parts.push(sql`homework.removed_at IS NULL`)
  }
  const order =
    query.status === 'upcoming'
      ? sql`homework.due_on ASC, homework.created_at ASC, homework.id`
      : sql`homework.due_on DESC, homework.created_at DESC, homework.id`
  return { where: sql.join(parts, sql` AND `), order }
}

export async function listHomework(
  conn: HomeworkConnection,
  context: RequestContext,
  query: HomeworkListRequest,
): Promise<HomeworkListResponse> {
  const today = await schoolToday(conn, context.schoolId)
  const plans = await homeworkReadPlans(conn, context)
  const listed = listWhere(query, today)
  // "To check" lists what the caller may still check, as the dashboard card
  // does: items the check plan reaches, inside the teacher's window unless
  // the school-wide grant reaches them.
  let where = listed.where
  if (query.status === 'to_check') {
    const check = await homeworkWritePlans(conn, context, 'homework.check')
    const opened = addDays(today, -HOMEWORK_TEACHER_CHECK_DAYS)
    where = sql`${where} AND (${check.items}) AND (homework.due_on >= ${opened}::date OR (${check.office}))`
  }
  const order = listed.order
  const rows = await selectItems(conn, {
    schoolId: context.schoolId,
    plans,
    where,
    ...(query.studentId === undefined ? {} : { studentId: query.studentId }),
    ...(query.status === 'to_check' ? { toCheck: { today } } : {}),
    order,
    limit: HOMEWORK_LIST_MAX + 1,
  })
  const shown = rows.slice(0, HOMEWORK_LIST_MAX)
  const actions = await actionsFor(conn, context, shown)
  return {
    today,
    items: shown.map((row) => toListItem(row, today, actions.get(row.id) ?? [])),
    truncated: rows.length > HOMEWORK_LIST_MAX,
    allowedActions: await listActions(conn, context),
  }
}

// ---------------------------------------------------------------------------
// One item.

async function attachmentsOf(
  conn: HomeworkConnection,
  schoolId: string,
  homeworkId: string,
): Promise<HomeworkAttachmentView[]> {
  const rows = await conn.client.query<{ id: string; file_name: string; content_type: string; size_bytes: number }>(
    `SELECT id, file_name, content_type, size_bytes FROM homework_attachments
      WHERE school_id = $1 AND homework_id = $2 ORDER BY created_at, id`,
    [schoolId, homeworkId],
  )
  return rows.rows.map((row) => ({
    id: row.id,
    fileName: row.file_name,
    contentType: row.content_type as HomeworkAttachmentView['contentType'],
    sizeBytes: Number(row.size_bytes),
  }))
}

/**
 * One item as the caller may read it, after the record has been decided. It
 * is read through the same plan as the list, so a family never receives a
 * removed item and a detail answers exactly what the list would.
 */
export async function readHomeworkDetail(
  conn: HomeworkConnection,
  context: RequestContext,
  homeworkId: string,
): Promise<HomeworkDetail> {
  const schoolId = context.schoolId
  const today = await schoolToday(conn, schoolId)
  const plans = await homeworkReadPlans(conn, context)
  const rows = await selectItems(conn, {
    schoolId,
    plans,
    where: sql`homework.id = ${homeworkId}::uuid`,
    order: sql`homework.id`,
    limit: 21,
    detail: true,
  })
  const first = rows[0]
  if (!first) throw new ApiFailure('RESOURCE_NOT_FOUND')
  const actions = (await actionsFor(conn, context, [first])).get(first.id) ?? []
  const item = toListItem(first, today, actions)
  const removed = first.removed_at !== null
  const updatedBy = first.staff_view ? shownName(first.updated_by) : undefined
  const removedBy = first.staff_view && removed ? shownName(first.removed_by) : undefined
  let window: HomeworkDetail['checkWindow']
  if (first.staff_view && (await holdsCheck(conn, context, homeworkId))) {
    const office = await itemMatches(conn, schoolId, homeworkId, (await homeworkWritePlans(conn, context, 'homework.check')).office)
    window = checkWindow({ dueOn: first.due_on, today, removed, mayCheck: true, office })
  }
  const children = first.staff_view
    ? undefined
    : rows.map((row) => childOf(row, today)).filter((child): child is HomeworkChildStatus => child !== undefined)
  return {
    ...item,
    instructions: first.instructions ?? '',
    attachments: await attachmentsOf(conn, schoolId, homeworkId),
    updatedAt: first.updated_at ?? '',
    ...(updatedBy === undefined ? {} : { updatedBy }),
    ...(removedBy === undefined ? {} : { removedBy }),
    ...(window === undefined ? {} : { checkWindow: window }),
    ...(children === undefined ? {} : { children: children.slice(0, 20) }),
  }
}

// ---------------------------------------------------------------------------
// The check-off sheet.

interface SheetRow extends Record<string, unknown> {
  id: string
  first_name: string
  last_name: string | null
  admission_number: string
  roll_number: number | null
  check_id: string | null
  check_version: number | null
  status: HomeworkCheckStatus | null
  remark: string | null
  checked_at: string | null
  checked_by: string | null
}

/**
 * The roster down, each pupil with their check-off. Staff only: an item the
 * caller reads only as a family has no sheet for them.
 */
export async function readCheckSheet(
  conn: HomeworkConnection,
  context: RequestContext,
  homeworkId: string,
): Promise<HomeworkCheckSheet> {
  const schoolId = context.schoolId
  const today = await schoolToday(conn, schoolId)
  const plans = await homeworkReadPlans(conn, context)
  const rows = await selectItems(conn, {
    schoolId,
    plans,
    where: sql`homework.id = ${homeworkId}::uuid`,
    order: sql`homework.id`,
    limit: 21,
  })
  const first = rows[0]
  if (!first) throw new ApiFailure('RESOURCE_NOT_FOUND')
  if (!first.staff_view) throw new ApiFailure('ACCESS_DENIED')
  const actions = (await actionsFor(conn, context, [first])).get(first.id) ?? []
  const mayCheck = await holdsCheck(conn, context, homeworkId)
  const office = mayCheck
    ? await itemMatches(conn, schoolId, homeworkId, (await homeworkWritePlans(conn, context, 'homework.check')).office)
    : false
  const window = checkWindow({ dueOn: first.due_on, today, removed: first.removed_at !== null, mayCheck, office })

  const sheet = await conn.db.execute<SheetRow>(
    sql`SELECT students.id, students.first_name, students.last_name, students.admission_number, en.roll_number,
               homework_checks.id AS check_id, homework_checks.version AS check_version, homework_checks.status,
               homework_checks.remark, ${isoOf(sql`homework_checks.checked_at`)} AS checked_at,
               ${memberName(schoolId, sql`homework_checks.checked_by_membership_id`, plans.directory)} AS checked_by
          FROM homework
          JOIN enrollments en ON en.school_id = homework.school_id AND en.section_id = homework.section_id
               AND en.academic_year_id = homework.academic_year_id
               AND en.joined_on <= homework.due_on AND (en.left_on IS NULL OR en.left_on >= homework.due_on)
          JOIN students ON students.school_id = en.school_id AND students.id = en.student_id
          LEFT JOIN homework_checks ON homework_checks.school_id = homework.school_id
               AND homework_checks.homework_id = homework.id AND homework_checks.student_id = students.id
               AND (${plans.checks})
         WHERE homework.school_id = ${schoolId}::uuid AND homework.id = ${homeworkId}::uuid
           AND (${plans.staffPupils})
         ORDER BY en.roll_number NULLS LAST, students.first_name, students.last_name, students.id
         LIMIT ${HOMEWORK_ROSTER_MAX}`,
  )
  return {
    homework: toListItem(first, today, actions),
    window,
    rows: sheet.rows.map((row) => {
      const checkedBy = shownName(row.checked_by)
      return {
        student: {
          id: row.id,
          name: pupilName(row.first_name, row.last_name),
          admissionNumber: row.admission_number,
          ...(row.roll_number === null || Number(row.roll_number) <= 0 ? {} : { rollNumber: Number(row.roll_number) }),
        },
        ...(row.check_id !== null && row.status !== null && row.checked_at !== null
          ? {
              check: {
                id: row.check_id,
                version: Number(row.check_version),
                status: row.status,
                ...(row.remark === null ? {} : { remark: row.remark }),
                checkedAt: row.checked_at,
                ...(checkedBy === undefined ? {} : { checkedBy }),
              },
            }
          : {}),
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// The dashboard cards. Both read through selectItems, so a card holds an item
// only when the list would.

const DASHBOARD_CARD_MAX = 50

/**
 * "Homework due" for one child (or a pupil themself): the items due on `date`
 * and the day after, not removed, with the child's own status, soonest first.
 * Throws AuthorizationError when the caller holds homework.read nowhere, which
 * the dashboard turns into an absent card.
 */
export async function readHomeworkDue(
  conn: HomeworkConnection,
  context: RequestContext,
  studentId: string,
  date: string,
): Promise<DashboardHomeworkDue> {
  const plans = await homeworkReadPlans(conn, context)
  const tomorrow = addDays(date, 1)
  const rows = await selectItems(conn, {
    schoolId: context.schoolId,
    plans,
    where: sql`homework.removed_at IS NULL AND homework.due_on >= ${date}::date AND homework.due_on <= ${tomorrow}::date`,
    studentId,
    order: sql`homework.due_on ASC, homework.created_at ASC, homework.id`,
    limit: DASHBOARD_CARD_MAX * 2,
  })
  const toItem = (row: ItemListRow): DashboardHomeworkDueItem => ({
    homeworkId: row.id,
    ...(row.subject_id !== null && row.subject_name !== null
      ? { subject: { id: row.subject_id, name: row.subject_name } }
      : {}),
    title: row.title,
    dueOn: row.due_on,
    status: childStatusOf(row, date),
  })
  return {
    today: rows.filter((row) => row.due_on === date).slice(0, DASHBOARD_CARD_MAX).map(toItem),
    tomorrow: rows.filter((row) => row.due_on === tomorrow).slice(0, DASHBOARD_CARD_MAX).map(toItem),
  }
}

/**
 * "To check": the items the caller may check, due on or before `date` and
 * still inside the teacher's window (any age when the school-wide grant
 * reaches them), with a roster pupil not checked yet. Oldest due first.
 * Throws AuthorizationError when the caller holds homework.read nowhere; an
 * empty list when they read but check nothing.
 */
export async function readHomeworkToCheck(
  conn: HomeworkConnection,
  context: RequestContext,
  date: string,
): Promise<DashboardHomeworkToCheckItem[]> {
  const plans = await homeworkReadPlans(conn, context)
  const check = await homeworkWritePlans(conn, context, 'homework.check')
  const opened = addDays(date, -HOMEWORK_TEACHER_CHECK_DAYS)
  const rows = await selectItems(conn, {
    schoolId: context.schoolId,
    plans,
    where: sql`homework.removed_at IS NULL AND (${check.items})
               AND (homework.due_on >= ${opened}::date OR (${check.office}))`,
    toCheck: { today: date },
    order: sql`homework.due_on ASC, homework.created_at ASC, homework.id`,
    limit: DASHBOARD_CARD_MAX,
  })
  return rows.map((row) => {
    const pupils = Number(row.pupils ?? 0)
    const checked = Number(row.done ?? 0) + Number(row.partly_done ?? 0) + Number(row.not_done ?? 0)
    return {
      homeworkId: row.id,
      section: { id: row.section_id, name: row.section_name },
      grade: { id: row.grade_id, name: row.grade_name },
      ...(row.subject_id !== null && row.subject_name !== null
        ? { subject: { id: row.subject_id, name: row.subject_name } }
        : {}),
      title: row.title,
      dueOn: row.due_on,
      pupils,
      notChecked: Math.max(0, pupils - checked),
    }
  })
}
