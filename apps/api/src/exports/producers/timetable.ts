import { sql, type SQL } from 'drizzle-orm'
import { planPredicate, scopedTableFor, type AuthzConnection } from '@erp/authz'
import { BellPeriod, TimetableExportRequest } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../../http/errors.ts'
import { decideResource, readPlan } from '../../modules/shared/authorize.ts'
import {
  CELL_COLUMNS,
  CELL_JOINS,
  personName,
  queryRows,
  sectionName,
  toCell,
  type CellRow,
  type TimetableCellDto,
} from '../../modules/timetable/shared.ts'
import { exportFileName, fileNameDate } from '../naming.ts'
import { openDocument } from '../pdf/document.ts'
import { PDF_CONTENT_TYPE } from '../pdf/kit.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile } from '../types.ts'
import { buildWorkbook, XLSX_CONTENT_TYPE } from '../xlsx.ts'

/** The whole request is the criteria: one year, one view, one format. */
const Criteria = TimetableExportRequest

/** The same short day names the week on screen uses. */
const DAY_NAMES: Readonly<Record<number, string>> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
}

/**
 * The cells of one week, read again under the timetable read plan. A teacher
 * therefore exports their own week and nothing more, and an office role
 * exports only the classes it may read.
 */
async function readCells(
  conn: AuthzConnection,
  context: RequestContext,
  where: SQL,
): Promise<TimetableCellDto[]> {
  const table = scopedTableFor('timetable')
  if (!table) throw new ApiFailure('SERVICE_UNAVAILABLE')
  const predicate = planPredicate(
    await readPlan(conn, context, 'timetable.read', 'timetable'),
    table,
  )
  const rows = await queryRows<CellRow>(
    conn,
    sql`SELECT ${CELL_COLUMNS} ${CELL_JOINS} WHERE ${predicate} AND ${where}
        ORDER BY timetable_entries.day_of_week, timetable_entries.period_index`,
  )
  return rows.map(toCell)
}

/**
 * What each row of the grid is called. The bell schedules of the year are
 * merged by period index exactly as the screen merges them, so a week that
 * spans grades still reads as one list of periods.
 */
async function periodNames(
  conn: AuthzConnection,
  schoolId: string,
  academicYearId: string,
): Promise<Map<number, PeriodLabel>> {
  const schedules = await queryRows<{ periods: unknown }>(
    conn,
    sql`SELECT periods FROM bell_schedules
         WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${academicYearId}::uuid
         ORDER BY name`,
  )
  const names = new Map<number, PeriodLabel>()
  for (const row of schedules) {
    const parsed = BellPeriod.array().safeParse(row.periods)
    if (!parsed.success) continue
    for (const period of parsed.data) {
      if (names.has(period.index)) continue
      names.set(period.index, {
        name: period.name,
        time:
          period.endTime === '' ? clockTime(period.startTime) : `${clockTime(period.startTime)} to ${clockTime(period.endTime)}`,
      })
    }
  }
  return names
}

/** What one row of the grid is called and when it runs. */
interface PeriodLabel {
  readonly name: string
  readonly time: string
}

/** "08:45" is how the schedule stores it, "8:45" is how a person says it. */
function clockTime(value: string): string {
  return value.replace(/^0/, '')
}

/** The heading of the document: which class or whose week this is. */
async function viewLabel(
  conn: AuthzConnection,
  context: RequestContext,
  view: TimetableExportRequest['view'],
): Promise<string> {
  if (view.kind === 'section') {
    const found = await queryRows<{ sectionName: string; gradeName: string }>(
      conn,
      sql`SELECT sections.name AS "sectionName", grades.name AS "gradeName"
            FROM sections
            JOIN grades ON grades.school_id = sections.school_id AND grades.id = sections.grade_id
           WHERE sections.school_id = ${context.schoolId}::uuid AND sections.id = ${view.sectionId}::uuid`,
    )
    const row = found[0]
    if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
    return sectionName(row.gradeName, row.sectionName)
  }
  const found = await queryRows<{ firstName: string; lastName: string | null }>(
    conn,
    sql`SELECT first_name AS "firstName", last_name AS "lastName" FROM staff
         WHERE school_id = ${context.schoolId}::uuid AND id = ${view.staffId}::uuid`,
  )
  const row = found[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return personName(row.firstName, row.lastName)
}

/** A space that never breaks, so "Room 101" stays on one line. */
const NBSP = ' '

/**
 * One slot as a person reads it. A class week names the teacher of each
 * period; a teacher's week names the class they are standing in front of,
 * because that is the part that changes. The room is a line of its own.
 */
function slot(cell: TimetableCellDto, kind: 'section' | 'teacher'): Slot {
  const second = kind === 'section' ? (cell.teacher?.name ?? '') : cell.section.name
  return {
    title: cell.subject.name,
    lines: [
      ...(second === '' ? [] : [second]),
      ...(cell.roomNumber === undefined ? [] : [`Room${NBSP}${cell.roomNumber}`]),
    ],
  }
}

/** A slot on the printed grid: the subject, then the smaller facts about it. */
interface Slot {
  readonly title: string
  readonly lines: readonly string[]
}

interface Grid {
  readonly days: number[]
  readonly periods: number[]
  readonly slot: (day: number, period: number) => Slot | undefined
  readonly text: (day: number, period: number) => string
}

/** The week arranged as it is printed: one row per period, one column per day. */
function toGrid(cells: readonly TimetableCellDto[], kind: 'section' | 'teacher'): Grid {
  const bySlot = new Map<string, Slot>()
  const days = new Set<number>()
  const periods = new Set<number>()
  for (const cell of cells) {
    days.add(cell.dayOfWeek)
    periods.add(cell.periodIndex)
    bySlot.set(`${cell.dayOfWeek}|${cell.periodIndex}`, slot(cell, kind))
  }
  // An empty week still prints a readable Monday to Friday grid rather than a
  // table with no columns at all.
  const sorted = (values: Set<number>, fallback: number[]) =>
    values.size === 0 ? fallback : [...values].sort((left, right) => left - right)
  return {
    days: sorted(days, [1, 2, 3, 4, 5]),
    periods: sorted(periods, [0]),
    slot: (day, period) => bySlot.get(`${day}|${period}`),
    // A spreadsheet cell is one line, so the parts sit side by side there.
    text: (day, period) => {
      const found = bySlot.get(`${day}|${period}`)
      if (!found) return ''
      return [found.title, ...found.lines].join(' · ').replace(new RegExp(NBSP, 'g'), ' ')
    },
  }
}

async function produce(
  conn: AuthzConnection,
  context: RequestContext,
  criteria: unknown,
): Promise<ExportFile> {
  const parsed = Criteria.safeParse(criteria)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  const { academicYearId, format, view } = parsed.data

  const cells = await readCells(
    conn,
    context,
    view.kind === 'section'
      ? sql`timetable_entries.academic_year_id = ${academicYearId}::uuid
            AND timetable_entries.section_id = ${view.sectionId}::uuid`
      : sql`timetable_entries.academic_year_id = ${academicYearId}::uuid
            AND timetable_entries.staff_id = ${view.staffId}::uuid`,
  )
  if (cells.length === 0) {
    // The grid routes answer an empty week only to somebody who may see the
    // class or the person at all; to anyone else it is simply not there.
    const decision =
      view.kind === 'section'
        ? await decideResource(conn, context, 'sections.read', 'section', view.sectionId)
        : await decideResource(conn, context, 'staff.read_directory', 'staff', view.staffId)
    if (!decision.allowed) throw new ApiFailure('RESOURCE_NOT_FOUND')
  }

  const label = await viewLabel(conn, context, view)
  const names = await periodNames(conn, context.schoolId, academicYearId)
  const grid = toGrid(cells, view.kind)
  const periodLabel = (index: number): PeriodLabel =>
    names.get(index) ?? { name: `Period ${index + 1}`, time: '' }
  const dayName = (day: number) => DAY_NAMES[day] ?? `Day ${day}`
  const fileName = exportFileName(['timetable', label, fileNameDate(context.now)], format)

  if (format === 'xlsx') {
    const columns = [
      { header: 'Period', key: 'period', width: 22 },
      ...grid.days.map((day) => ({ header: dayName(day), key: `day${day}`, width: 26 })),
    ]
    const rows = grid.periods.map((period) => {
      const label = periodLabel(period)
      const row: Record<string, string> = {
        period: label.time === '' ? label.name : `${label.name} (${label.time})`,
      }
      for (const day of grid.days) {
        row[`day${day}`] = grid.text(day, period)
      }
      return row
    })
    return {
      bytes: await buildWorkbook({ sheetName: 'Timetable', columns, rows }),
      contentType: XLSX_CONTENT_TYPE,
      fileName,
      rowCount: cells.length,
    }
  }

  // A week is wider than it is tall, so the document turns on its side.
  const document = await openDocument(conn, context, { title: 'Timetable', landscape: true })
  document.personHeader({ name: label, subtitle: 'Weekly timetable', tags: [] })
  // The period column only holds a name and a time, so it takes a narrow fixed
  // share and the days split the rest evenly between them.
  const periodShare = 0.12
  const dayShare = (1 - periodShare) / grid.days.length
  document.panel('The week', {
    kind: 'table',
    columns: [
      { header: 'Period', width: periodShare },
      ...grid.days.map((day) => ({
        header: dayName(day),
        width: dayShare,
        emphasis: 'primary' as const,
      })),
    ],
    rows: grid.periods.map((period) => {
      const label = periodLabel(period)
      return [
        { title: label.name, lines: label.time === '' ? [] : [label.time] },
        ...grid.days.map((day) => grid.slot(day, period) ?? ''),
      ]
    }),
  })

  return {
    bytes: await document.finish(),
    contentType: PDF_CONTENT_TYPE,
    fileName,
    rowCount: cells.length,
  }
}

registerProducer({ kind: 'timetable', produce })
