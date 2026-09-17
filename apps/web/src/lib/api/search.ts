/** The command-menu search. Mirrors apps/api/src/modules/search/routes.ts. */
import { SearchResponse } from '@erp/contracts'
import type { z } from 'zod'
import { request } from '@/lib/http'
import { schoolPath, withQuery } from './shared'

export type SearchResults = z.infer<typeof SearchResponse>

export function search(schoolId: string, q: string) {
  return request(withQuery(schoolPath(schoolId, '/search'), { q }), { schema: SearchResponse })
}
