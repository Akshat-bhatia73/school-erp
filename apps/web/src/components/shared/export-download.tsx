/**
 * One export, from the moment it is asked for to the file landing in the browser.
 *
 * Every screen that exports something behaves the same way: poll the job while it is being
 * prepared, save the file once it is ready, and say in plain English what is happening. That
 * belongs in one place, so a screen only has to say which job it started and where the line of
 * text goes.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { ExportJob } from '@/lib/api/files'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { cn } from '@/lib/utils'

/** Hands the browser the bytes it just fetched, without the file ever reaching the query cache. */
function saveFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

const MESSAGE: Record<ExportJob['status'], string> = {
  queued: 'Preparing your file…',
  ready: 'Your file is ready.',
  failed: 'We could not prepare that file. Try again.',
  expired: 'That file is no longer available. Start a new export.',
}

export interface ExportDownload {
  /** Call with the job the server just created. */
  start: (job: ExportJob) => void
  /** The status line, or null while nothing has been asked for. */
  status: ReactNode
  /** The job as the server last described it, for a screen that wants to react to it. */
  job: ExportJob | undefined
}

/**
 * Follows one export job at a time. A file that is ready saves itself once, because the person
 * already asked for it; the button is there to get it again.
 */
export function useExportDownload(options: { className?: string } = {}): ExportDownload {
  const { schoolId } = useSchoolContext()
  const [jobId, setJobId] = useState<string | null>(null)
  // Which job has already been saved, so a re-render or a later poll does not save it twice.
  const savedRef = useRef<string | null>(null)

  const jobQuery = useQuery({
    queryKey: qk.exportJob(schoolId, jobId ?? 'none'),
    queryFn: () => api.files.exportJob(schoolId, jobId as string),
    enabled: jobId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'queued' ? 3000 : false),
  })

  const download = useMutation({
    mutationFn: (job: ExportJob) => api.files.downloadExportFile(schoolId, job.id),
    onSuccess: (file) => saveFile(file.blob, file.fileName),
    onError: (error) => toast.error(describeError(error)),
  })

  // A small job is ready in the response that created it, so this also covers the inline case.
  const job = jobQuery.data
  const downloadMutate = download.mutate
  useEffect(() => {
    if (!job || job.status !== 'ready' || savedRef.current === job.id) return
    savedRef.current = job.id
    downloadMutate(job)
  }, [job, downloadMutate])

  const start = (created: ExportJob) => {
    savedRef.current = null
    setJobId(created.id)
  }

  const status = job ? (
    <div className={cn('flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground', options.className)}>
      <span>{download.isPending ? 'Downloading…' : MESSAGE[job.status]}</span>
      {job.status === 'ready' && (
        <Button variant="ghost" size="sm" disabled={download.isPending} onClick={() => download.mutate(job)}>
          <Download />Download file
        </Button>
      )}
    </div>
  ) : null

  return { start, status, job }
}
