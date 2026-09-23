/**
 * The school logo on the profile, with the controls to change or remove it for somebody who may
 * update the school. The file is sent as it is (PNG or JPEG, up to 512 KB); the server checks the
 * type and size again and cleans the picture before it keeps it.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { LOGO_CONTENT_TYPES, LOGO_MAX_BYTES } from '@erp/contracts'
import { ImageUp, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { describeError, isApiError } from '@/lib/api-errors'
import { useSchoolContext } from '@/lib/session'

const TOO_BIG = 'Choose a logo smaller than 512 KB.'

function logoProblem(error: unknown): string {
  if (isApiError(error) && error.status === 413) return TOO_BIG
  if (isApiError(error, 'INVALID_REQUEST')) return 'Save the logo as PNG or JPEG and try again.'
  return describeError(error)
}

export function SchoolLogo({ shortName, logo, version, canEdit }: {
  shortName: string
  logo?: { updatedAt: string }
  version: number
  canEdit: boolean
}) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [failed, setFailed] = useState(false)

  const done = (message: string) => {
    setFailed(false)
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'school'] })
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'reportCards'] })
    toast.success(message)
  }
  const upload = useMutation({
    mutationFn: (file: File) => api.logo.upload(schoolId, file, version),
    onSuccess: () => done('Logo saved'),
    onError: (error) => toast.error(logoProblem(error)),
  })
  const remove = useMutation({
    mutationFn: () => api.logo.remove(schoolId, version),
    onSuccess: () => done('Logo removed'),
    onError: (error) => toast.error(describeError(error)),
  })

  const choose = (file: File) => {
    if (!(LOGO_CONTENT_TYPES as readonly string[]).includes(file.type)) {
      toast.error('Choose a PNG or JPEG picture.')
      return
    }
    if (file.size > LOGO_MAX_BYTES) {
      toast.error(TOO_BIG)
      return
    }
    upload.mutate(file)
  }

  const busy = upload.isPending || remove.isPending
  return (
    <div className="flex flex-wrap items-center gap-3">
      {logo && !failed ? (
        <img src={api.logo.url(schoolId, logo.updatedAt)} alt="School logo" onError={() => setFailed(true)} className="size-16 rounded-xl border bg-card object-contain p-1" />
      ) : (
        <div className="flex size-16 items-center justify-center rounded-xl border bg-muted/60 text-[20px] font-semibold tracking-tight">{shortName}</div>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={input}
            type="file"
            accept={LOGO_CONTENT_TYPES.join(',')}
            className="hidden"
            aria-label="Upload logo"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) choose(file)
            }}
          />
          <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>
            <ImageUp />{upload.isPending ? 'Saving…' : 'Upload logo'}
          </Button>
          {logo && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove.mutate()}>
              <Trash2 />{remove.isPending ? 'Removing…' : 'Remove logo'}
            </Button>
          )}
          <p className="w-full text-[12px] text-muted-foreground">PNG or JPEG, up to 512 KB. It is printed on report cards.</p>
        </div>
      )}
    </div>
  )
}
