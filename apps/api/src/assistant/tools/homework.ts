import { z } from 'zod'
import {
  HOMEWORK_PUPIL_STATUS_LABELS,
  HomeworkCheckSheet,
  HomeworkListResponse,
  type HomeworkListItem,
  type HomeworkPupilStatus,
} from '@erp/contracts'
import { readTool, type ReadToolOutcome, type ToolCallContext } from './types.ts'
import {
  DateInput,
  IdInput,
  appPath,
  capped,
  className,
  date,
  fetchParsed,
  num,
  ok,
  seg,
  source,
  tableCard,
  tag,
  text,
  toolList,
} from './present.ts'

/** The word the screens use for an item with no subject. */
const GENERAL = 'General'

const STATUS_FILTERS = ['upcoming', 'past', 'to_check'] as const

function subjectOf(item: Pick<HomeworkListItem, 'subject'>): string {
  return item.subject?.name ?? GENERAL
}

/** What one row says about where it stands: the child's own status for a family, the figures for staff. */
function standing(item: HomeworkListItem): string {
  if (item.child !== undefined) return HOMEWORK_PUPIL_STATUS_LABELS[item.child.status]
  if (item.progress !== undefined) {
    const checked = item.progress.done + item.progress.partlyDone + item.progress.notDone
    return `${checked} of ${item.progress.pupils} checked`
  }
  return ''
}

/**
 * The homework the person may read, through the same list route as the
 * Homework screen (so a family sees their own child's items and status, a
 * teacher their own sections and subjects). With `homeworkId` it opens that
 * one item's check-off sheet instead, which names each pupil's status: the
 * sheet route answers staff only, so a family is told it is not available.
 * It never sets or checks anything.
 */
export const listHomework = readTool({
  name: 'list_homework',
  description:
    "Homework you may see: title, class, subject, set and due dates, and for a parent or pupil the child's own status (done, partly done, not done, not checked). Filter by child, section, subject, due dates or status. Staff may pass homeworkId to see each pupil's status on that item.",
  permission: 'homework.read',
  input: z.object({
    studentId: IdInput('Only this child (a parent) or this pupil.').optional(),
    sectionId: IdInput('Only this section.').optional(),
    subjectId: IdInput('Only this subject.').optional(),
    general: z.boolean().optional().describe('Only general homework with no subject.'),
    status: z
      .enum(STATUS_FILTERS)
      .optional()
      .describe('upcoming: due today or later; past: due before today; to_check: due, with pupils not checked yet (staff).'),
    dueFrom: DateInput('Due on or after this day.').optional(),
    dueTo: DateInput('Due on or before this day.').optional(),
    homeworkId: IdInput("One item: each pupil's status on it, for staff. Use an id from an earlier answer.").optional(),
  }),
  async run(input, context) {
    if (input.homeworkId !== undefined) return checkSheet(input.homeworkId, context)
    const found = await fetchParsed(context, HomeworkListResponse, '/homework', {
      studentId: input.studentId,
      sectionId: input.sectionId,
      subjectId: input.general === true ? undefined : input.subjectId,
      general: input.general === true ? 'true' : undefined,
      status: input.status,
      from: input.dueFrom,
      to: input.dueTo,
    })
    if (!found.ok) return found.outcome
    const body = found.body
    const list = capped(body.items)
    return ok(
      {
        today: body.today,
        items: list.items.map((item) => ({
          homeworkId: item.id,
          title: item.title,
          class: className(item.grade, item.section),
          subject: subjectOf(item),
          setOn: item.setOn,
          dueOn: item.dueOn,
          files: item.attachmentCount,
          ...(item.child === undefined
            ? {}
            : { child: item.child.student.name, childId: item.child.student.id, status: item.child.status }),
          ...(item.progress === undefined ? {} : { progress: item.progress }),
        })),
        shown: list.items.length,
        total: list.total,
        more: list.more || body.truncated,
      },
      tableCard({
        title: 'Homework',
        columns: [
          { key: 'title', label: 'Homework' },
          { key: 'class', label: 'Class' },
          { key: 'subject', label: 'Subject' },
          { key: 'due', label: 'Due' },
          ...(list.items.some((item) => item.child !== undefined) ? [{ key: 'child', label: 'Child' }] : []),
          { key: 'status', label: 'Status' },
        ],
        rows: list.items.map((item) => ({
          cells: {
            title: text(item.title),
            class: text(className(item.grade, item.section)),
            subject: text(subjectOf(item)),
            due: date(item.dueOn),
            child: text(item.child?.student.name),
            status: tag(standing(item)),
          },
          href: `/homework/${seg(item.id)}`,
        })),
        total: list.total,
      }),
      source(
        'Homework',
        appPath('/homework', { status: input.status, sectionId: input.sectionId, studentId: input.studentId }),
      ),
    )
  },
})

const STATUS_ORDER: Readonly<Record<HomeworkPupilStatus, number>> = {
  not_done: 0,
  not_checked: 1,
  partly_done: 2,
  done: 3,
  not_due: 4,
}

async function checkSheet(homeworkId: string, context: ToolCallContext): Promise<ReadToolOutcome> {
  const found = await fetchParsed(context, HomeworkCheckSheet, `/homework/${seg(homeworkId)}/checks`)
  if (!found.ok) return found.outcome
  const { homework, window, rows } = found.body
  const due = window.state !== 'not_due'
  const pupils = rows
    .map((row) => ({
      studentId: row.student.id,
      name: row.student.name,
      rollNumber: row.student.rollNumber,
      status: (row.check?.status ?? (due ? 'not_checked' : 'not_due')) as HomeworkPupilStatus,
    }))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name))
  const list = capped(pupils)
  const count = (status: HomeworkPupilStatus) => pupils.filter((pupil) => pupil.status === status).length
  return ok(
    {
      homeworkId: homework.id,
      title: homework.title,
      class: className(homework.grade, homework.section),
      subject: subjectOf(homework),
      dueOn: homework.dueOn,
      counts: {
        pupils: pupils.length,
        done: count('done'),
        partlyDone: count('partly_done'),
        notDone: count('not_done'),
        notChecked: count('not_checked'),
      },
      pupils: list.items,
      shown: list.items.length,
      total: list.total,
    },
    tableCard({
      title: `${homework.title}, ${className(homework.grade, homework.section) ?? ''}`.trim(),
      columns: [
        { key: 'roll', label: 'Roll', align: 'end' },
        { key: 'name', label: 'Pupil' },
        { key: 'status', label: 'Status' },
      ],
      rows: list.items.map((pupil) => ({
        cells: {
          roll: num(pupil.rollNumber),
          name: text(pupil.name),
          status: tag(HOMEWORK_PUPIL_STATUS_LABELS[pupil.status]),
        },
      })),
      total: list.total,
    }),
    source(homework.title, `/homework/${seg(homework.id)}`),
  )
}

export const HOMEWORK_TOOLS = toolList(listHomework)
