import { loadRelationshipFactsFor, type AuthzConnection } from '@erp/authz'
import type { RequestContext } from '@erp/contracts/server'
import type { StudentDashboard } from '@erp/contracts'
import { readPlan } from '../shared/index.ts'
import { ApiFailure } from '../../http/errors.ts'
import { buildCalendar, currentAcademicYear, optionalBlock } from './calendar.ts'
import { learningCards } from './parent.ts'

/**
 * A pupil's own home: the card a parent sees for one child, built by the same
 * function, for the pupil this login is linked to and nobody else, without
 * fees or consents, and the holidays ahead as a teacher's home lists them.
 */
export async function studentDashboard(
  conn: AuthzConnection,
  context: RequestContext,
  date: string,
): Promise<StudentDashboard> {
  const holidayPlan = await optionalBlock(() => readPlan(conn, context, 'holidays.read', 'holiday'))
  const calendar = await buildCalendar(conn, holidayPlan, date)
  const facts = await loadRelationshipFactsFor(conn, context.schoolId, context.membershipId, context.now)
  // A login with no pupil linked, or one the student plan no longer reaches,
  // has no home to draw.
  if (!facts.ownStudentId) throw new ApiFailure('RESOURCE_NOT_FOUND')
  const year = await currentAcademicYear(conn, context.schoolId)
  const [card] = await learningCards(conn, context, { studentIds: [facts.ownStudentId], calendar, year, date })
  if (card === undefined) throw new ApiFailure('RESOURCE_NOT_FOUND')

  return { audience: 'student', day: calendar.day, me: card, holidays: calendar.holidays }
}
