/** The one dashboard a member's roles earn. Mirrors apps/api/src/modules/dashboard/routes.ts. */
import { DashboardByAudience, type DashboardAudienceKey } from '@erp/contracts'
import type { z } from 'zod'
import { request } from '@/lib/http'
import { schoolPath, withQuery } from './shared'

export type Dashboard = z.infer<typeof DashboardByAudience>

/**
 * The date only moves the calendar, and the audience only picks which of the caller's own homes
 * is drawn; the server refuses an audience the caller's roles do not earn. Neither widens a read.
 */
export function get(schoolId: string, params?: { date?: string; audience?: DashboardAudienceKey }) {
  return request(withQuery(schoolPath(schoolId, '/dashboard'), params ?? {}), {
    schema: DashboardByAudience,
  })
}
