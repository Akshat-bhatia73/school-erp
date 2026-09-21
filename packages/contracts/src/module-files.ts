/** Task 5 request and response contracts owned by the files module. */
import { z } from 'zod'

import { Id } from './common.ts'
import { ExportFileFormat, ExportJobSummary } from './response-families.ts'

/**
 * A job this size or smaller is produced in the request that asks for it, so
 * the caller gets a ready file instead of something to poll for. Anything
 * bigger waits for the daily maintenance route.
 */
export const EXPORT_INLINE_MAX_ROWS = 5000

/**
 * A photograph of a student or a staff member. One megabyte is enough for a
 * passport picture and small enough to accept in the request that sends it.
 * The type is decided by the API from the first bytes of the file, never from
 * what the upload claimed, so this list is what those bytes may turn out to
 * be rather than a list of accepted headers.
 */
export const PHOTO_MAX_BYTES = 1_048_576
export const PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export const PhotoContentType = z.enum(PHOTO_CONTENT_TYPES)
export type PhotoContentType = z.infer<typeof PhotoContentType>

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

/**
 * A profile export names its record in the path, so the body carries nothing.
 * It is still a strict object, so a request that tries to smuggle a filter or
 * a field list past the producer is refused rather than ignored.
 */
export const StudentProfileExportRequest = z.strictObject({})
export type StudentProfileExportRequest = z.infer<typeof StudentProfileExportRequest>

export const StaffProfileExportRequest = z.strictObject({})
export type StaffProfileExportRequest = z.infer<typeof StaffProfileExportRequest>

/**
 * A timetable export is the same read the grid routes answer today, in another
 * format: one academic year, and either one section or one teacher. The two
 * are separate cases rather than two optional ids, so "neither" and "both"
 * cannot be asked for at all.
 */
export const TimetableExportView = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('section'), sectionId: Id }),
  z.strictObject({ kind: z.literal('teacher'), staffId: Id }),
])
export type TimetableExportView = z.infer<typeof TimetableExportView>

export const TimetableExportRequest = z.strictObject({
  academicYearId: Id,
  format: ExportFileFormat,
  view: TimetableExportView,
})
export type TimetableExportRequest = z.infer<typeof TimetableExportRequest>
