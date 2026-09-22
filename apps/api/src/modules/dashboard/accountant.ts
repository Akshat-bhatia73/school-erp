import type { AuthzConnection } from '@erp/authz'
import type { RequestContext } from '@erp/contracts/server'
import type { AccountantDashboard } from '@erp/contracts'
import { readPlan } from '../shared/index.ts'
import { readFeeSummary } from '../fees/statement.ts'
import { buildCalendar, currentAcademicYear, optionalBlock } from './calendar.ts'
import { classStrength, studentGlance } from './office.ts'

/**
 * The accountant dashboard: what came in today and this month, what the
 * school is still owed, and the roll strength behind those figures. The money
 * card needs a year to be about, so a school with no current year simply does
 * not show one, and neither does a caller with no fee read grant.
 */
export async function accountantDashboard(
  conn: AuthzConnection,
  context: RequestContext,
  date: string,
): Promise<AccountantDashboard> {
  const holidayPlan = await optionalBlock(() => readPlan(conn, context, 'holidays.read', 'holiday'))
  const calendar = await buildCalendar(conn, holidayPlan, date)
  const year = await currentAcademicYear(conn, context.schoolId)
  const glance = await optionalBlock(() => studentGlance(conn, context, date))
  const strengths = await optionalBlock(() => classStrength(conn, context, year?.id ?? null))
  const fees =
    year === null
      ? undefined
      : // The day the rest of the dashboard is about, so the money card and
        // the calendar above it always speak about the same "today".
        await optionalBlock(() => readFeeSummary(conn, context, year.id, date))
  return {
    audience: 'accountant',
    day: calendar.day,
    ...(glance === undefined ? {} : { glance }),
    ...(fees === undefined ? {} : { fees }),
    ...(strengths === undefined ? {} : { classStrength: strengths }),
  }
}
