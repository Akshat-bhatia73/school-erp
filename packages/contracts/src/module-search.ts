/** Task 5 request and response contracts owned by the search module. */
import { z } from 'zod'
import { StaffSearchResults, StudentSearchResults } from './response-families.ts'

/**
 * The command menu term. It is trimmed and bounded so a stray blank or a huge
 * string never reaches the database, and it is the only input this module takes.
 */
export const SearchQueryRequest = z.strictObject({
  q: z.string().trim().min(1).max(100),
})

/**
 * Two short lists, each decided by its own read plan. A caller who may read one
 * kind of record and not the other still gets an answer for the kind it may read.
 */
export const SearchResponse = z.strictObject({
  students: StudentSearchResults,
  staff: StaffSearchResults,
})

export type SearchQueryRequest = z.infer<typeof SearchQueryRequest>
export type SearchResponse = z.infer<typeof SearchResponse>
