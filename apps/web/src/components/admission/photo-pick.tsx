/**
 * The photograph on the admission form. Nothing is sent from here: the picture is checked, shrunk
 * and held until the pupil has been admitted, because the photo route needs the new pupil's id.
 * The same rules as the profile's photo field apply: JPEG, PNG or WebP, and under 1 MB once it has
 * been made smaller.
 */
import { useRef, useState } from 'react'
import { ImageUp, Trash2 } from 'lucide-react'
import { PHOTO_CONTENT_TYPES, PHOTO_MAX_BYTES } from '@erp/contracts'
import { UserAvatar } from '@/components/shared/avatar'
import { photoProblem, toUploadableJpeg } from '@/components/shared/photo-field'
import { Button } from '@/components/ui/button'
import type { ChosenPhoto } from './admit-state'

const ACCEPT = PHOTO_CONTENT_TYPES.join(',')

function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('The picture could not be read.'))
    reader.readAsDataURL(blob)
  })
}

export function AdmissionPhotoField({ name, photo, onChange }: {
  name: string
  photo: ChosenPhoto | null
  onChange: (photo: ChosenPhoto | null) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const choose = async (file: File) => {
    setProblem(null)
    if (!(PHOTO_CONTENT_TYPES as readonly string[]).includes(file.type)) {
      setProblem('Choose a JPEG, PNG or WebP picture.')
      return
    }
    if (file.size > PHOTO_MAX_BYTES * 8) {
      setProblem('That picture is too large. Choose one under 8 MB.')
      return
    }
    setBusy(true)
    try {
      const prepared = await toUploadableJpeg(file)
      if (prepared.size > PHOTO_MAX_BYTES) {
        setProblem('Choose a photo smaller than 1 MB.')
        return
      }
      onChange({ prepared, preview: await dataUrlOf(prepared), fileName: file.name })
    } catch (error) {
      setProblem(photoProblem(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-3">
      <UserAvatar name={name} src={photo?.preview} size="xl" className="size-16" />
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="hidden"
          aria-label={photo ? 'Change photograph' : 'Choose photograph'}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void choose(file)
          }}
        />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>
          <ImageUp />{busy ? 'Preparing…' : photo ? 'Change photograph' : 'Choose photograph'}
        </Button>
        {photo && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setProblem(null); onChange(null) }}>
            <Trash2 />Remove
          </Button>
        )}
        {problem ? (
          <p role="alert" className="w-full text-[12px] text-destructive">{problem}</p>
        ) : (
          <p className="w-full text-[12px] text-muted-foreground">
            Optional. JPEG, PNG or WebP, under 1 MB once it is made smaller.
          </p>
        )}
      </div>
    </div>
  )
}
