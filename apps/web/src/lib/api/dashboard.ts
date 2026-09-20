/** The one dashboard a member's roles earn. Mirrors apps/api/src/modules/dashboard/routes.ts. */
import { DashboardByAudience } from '@erp/contracts'
import type { z } from 'zod'
import { request } from '@/lib/http'
import { schoolPath, withQuery } from './shared'

export type Dashboard = z.infer<typeof DashboardByAudience>

/** The date only moves the calendar; it never widens what the server reads. */
export function get(schoolId: string, params?: { date?: string }) {
  return request(withQuery(schoolPath(schoolId, '/dashboard'), params ?? {}), {
    schema: DashboardByAudience,
  })
}
