import type { AuthzConnection } from '@erp/authz'
import type { RequestContext } from '@erp/contracts/server'
import type { AccountantDashboard } from '@erp/contracts'
import { readPlan } from '../shared/index.ts'
import { buildCalendar, currentAcademicYear, optionalBlock } from './calendar.ts'
import { classStrength, studentGlance } from './office.ts'

/**
 * The accountant dashboard. Fees do not exist yet, so the screen says so in
 * plain words instead of showing an empty money card; what it does show is the
 * roll strength the fee module will be built on.
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
  return {
    audience: 'accountant',
    day: calendar.day,
    ...(glance === undefined ? {} : { glance }),
    ...(strengths === undefined ? {} : { classStrength: strengths }),
  }
}
