/** Task 5 request and response contracts owned by the files module. */
import { z } from 'zod'

import { Id } from './common.ts'
import { ExportJobSummary } from './response-families.ts'

/**
 * Record identifiers in this module are database uuids. Validating that exact
 * shape here means every malformed id fails in one place and gets one answer,
 * instead of a second regex in the route producing a different error code for
 * a different kind of malformed value.
 */
export const FilesUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

/**
 * Path parameters for the private document download. They are validated as
 * identifiers before any query runs, so a malformed id answers like a missing
 * record instead of reaching the database.
 */
export const FilesDocumentParams = z.strictObject({
  schoolId: Id,
  studentId: FilesUuid,
  documentId: FilesUuid,
})
export type FilesDocumentParams = z.infer<typeof FilesDocumentParams>

export const FilesExportJobParams = z.strictObject({
  schoolId: Id,
  jobId: FilesUuid,
})
export type FilesExportJobParams = z.infer<typeof FilesExportJobParams>

/**
 * The export job response is the shared family; it is re-exported here only so
 * the module has one import for its own contracts.
 */
export const FilesExportJobSummary = ExportJobSummary
export type FilesExportJobSummary = z.infer<typeof FilesExportJobSummary>
