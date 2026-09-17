/** The one dashboard a member's roles earn. Mirrors apps/api/src/modules/dashboard/routes.ts. */
import { DashboardByAudience } from '@erp/contracts'
import type { z } from 'zod'
import { request } from '@/lib/http'
import { schoolPath } from './shared'

export type Dashboard = z.infer<typeof DashboardByAudience>

export function get(schoolId: string) {
  return request(schoolPath(schoolId, '/dashboard'), { schema: DashboardByAudience })
}
