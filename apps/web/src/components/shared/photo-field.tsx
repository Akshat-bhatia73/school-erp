/**
 * The photograph of one person, with the controls to change or remove it.
 *
 * The screen renders this only when the person may update that record, so there is no disabled
 * control here. Nothing is decided in the browser: the server checks the permission, the type and
 * the size again, refuses anything it does not like and is the only place the bytes are kept. The
 * picture is shrunk and re-encoded as JPEG before it is sent, which keeps the upload small and
 * drops whatever the camera wrote into the file along with the image.
 */
import { useRef, useState } from 'react'
import { ImageUp, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { PHOTO_CONTENT_TYPES, PHOTO_MAX_BYTES } from '@erp/contracts'
import { UserAvatar } from '@/components/shared/avatar'
import { Button } from '@/components/ui/button'
import { describeError, isApiError } from '@/lib/api-errors'

/** The longest side of a stored photograph. A class photo needs no more than this. */
const MAX_SIDE = 600
const ACCEPT = PHOTO_CONTENT_TYPES.join(',')

const TOO_BIG = 'Choose a photo smaller than 1 MB.'
const NOT_READABLE = 'Save the photo as JPEG or PNG and try again.'

/** The browser could not open or rewrite the picture, so nothing was sent. */
export class PhotoEncodeError extends Error {
  constructor() {
    super('The browser could not rewrite this picture.')
    this.name = 'PhotoEncodeError'
  }
}

/**
 * What to say about a refused picture.
 *
 * Every upload is re-encoded as JPEG here first, so the server's own checks on the type and on
 * the description blocks a WebP may carry are only ever reached when that re-encoding failed.
 * The server's sentence is used when it sent a useful one; otherwise these plain words stand.
 */
export function photoProblem(error: unknown): string {
  if (error instanceof PhotoEncodeError) return NOT_READABLE
  if (isApiError(error)) {
    if (error.status === 413) return TOO_BIG
    if (error.code === 'INVALID_REQUEST') return NOT_READABLE
  }
  return describeError(error)
}

/** A picture that is already small enough still goes through the canvas, so nothing else travels. */
export async function toUploadableJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => { throw new PhotoEncodeError() })
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new PhotoEncodeError()
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
  if (!blob) throw new PhotoEncodeError()
  return blob
}

export function PhotoField({ name, src, note, onUpload, onRemove }: {
  name: string
  /** The address of the picture on file, or nothing when there is none yet. */
  src?: string
  /** A plain sentence instead of the controls, for example when consent is missing. */
  note?: string
  onUpload: (file: Blob) => Promise<unknown>
  onRemove: () => Promise<unknown>
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null)

  const choose = async (file: File) => {
    if (!(PHOTO_CONTENT_TYPES as readonly string[]).includes(file.type)) {
      toast.error('Choose a JPEG, PNG or WebP picture.')
      return
    }
    if (file.size > PHOTO_MAX_BYTES * 8) {
      // Far too big to be worth opening. What is sent is checked again below.
      toast.error('That picture is too large. Choose one under 8 MB.')
      return
    }
    setBusy('upload')
    try {
      const prepared = await toUploadableJpeg(file)
      if (prepared.size > PHOTO_MAX_BYTES) {
        toast.error(TOO_BIG)
        return
      }
      await onUpload(prepared)
      toast.success('Photo saved')
    } catch (error) {
      toast.error(photoProblem(error))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    setBusy('remove')
    try {
      await onRemove()
      toast.success('Photo removed')
    } catch (error) {
      toast.error(describeError(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex items-center gap-3">
      <UserAvatar name={name} src={src} size="xl" className="size-16" />
      {note ? (
        <p className="text-[12.5px] text-muted-foreground">{note}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            className="hidden"
            aria-label={src ? 'Change photo' : 'Add photo'}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void choose(file)
            }}
          />
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => input.current?.click()}>
            <ImageUp />{busy === 'upload' ? 'Saving…' : src ? 'Change photo' : 'Add photo'}
          </Button>
          {src && (
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void remove()}>
              <Trash2 />{busy === 'remove' ? 'Removing…' : 'Remove photo'}
            </Button>
          )}
          <p className="w-full text-[12px] text-muted-foreground">JPEG, PNG or WebP. The picture is made smaller before it is saved.</p>
        </div>
      )}
    </div>
  )
}
