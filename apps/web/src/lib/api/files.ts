/** Export job status and the private student document download.
 *  Mirrors apps/api/src/modules/files/routes.ts. */
import { FilesExportJobSummary } from '@erp/contracts'
import type { z } from 'zod'
import { ApiRequestError, request } from '@/lib/http'
import { schoolPath, seg } from './shared'

export type ExportJob = z.infer<typeof FilesExportJobSummary>

/** The status of an export this member asked for. Another member's job is simply not found. */
export function exportJob(schoolId: string, jobId: string) {
  return request(schoolPath(schoolId, `/exports/${seg(jobId)}`), { schema: FilesExportJobSummary })
}

export interface DownloadedDocument {
  blob: Blob
  fileName: string
}

/** `filename="notes.pdf"` -> `notes.pdf`. A header we cannot read falls back to a neutral name. */
function fileNameFrom(disposition: string | null): string {
  if (!disposition) return 'document'
  const quoted = /filename="([^"]+)"/.exec(disposition)
  if (quoted?.[1]) return quoted[1]
  const bare = /filename=([^;]+)/.exec(disposition)
  return bare?.[1]?.trim() ?? 'document'
}

/**
 * The two routes that answer with bytes rather than JSON cannot go through `request()`.
 * This repeats the same rules by hand: same-origin credentials, and an ApiError envelope turned
 * into the ApiRequestError every screen already knows how to describe.
 */
async function downloadBytes(path: string): Promise<DownloadedDocument> {
  let response: Response
  try {
    response = await fetch(path, { credentials: 'same-origin' })
  } catch {
    throw new ApiRequestError({ code: 'NETWORK_ERROR', status: 0, message: 'We could not reach the server. Check your connection and try again.' })
  }

  if (!response.ok) {
    let code: ApiRequestError['code'] = 'UNEXPECTED_RESPONSE'
    let message = 'Something went wrong. Please try again.'
    try {
      const payload = (await response.json()) as { error?: { code?: string; message?: string } }
      if (payload.error?.code) {
        code = payload.error.code as ApiRequestError['code']
        message = payload.error.message ?? message
      }
    } catch {
      // A failure with no envelope is still a failure; the default message stands.
    }
    throw new ApiRequestError({ code, status: response.status, message })
  }

  return {
    blob: await response.blob(),
    fileName: fileNameFrom(response.headers.get('content-disposition')),
  }
}

/** One private student document. */
export function downloadStudentDocument(
  schoolId: string,
  studentId: string,
  documentId: string,
): Promise<DownloadedDocument> {
  return downloadBytes(schoolPath(schoolId, `/students/${seg(studentId)}/documents/${seg(documentId)}/content`))
}

/**
 * The file a ready export job produced. The server checks the job belongs to this member and is
 * still fresh, so a job someone else started or one that has expired is simply not found.
 */
export function downloadExportFile(schoolId: string, jobId: string): Promise<DownloadedDocument> {
  return downloadBytes(schoolPath(schoolId, `/exports/${seg(jobId)}/file`))
}
