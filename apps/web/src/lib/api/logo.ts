/** The school logo: raw image bytes in and out, sent the way a student photo is. */
import { deletePhoto, photoSrc, putPhoto } from './photo'
import { schoolPath } from './shared'

const logoPath = (schoolId: string) => schoolPath(schoolId, '/school/logo')

/** The address an `<img>` can use; the moment it last changed busts the cache. */
export function url(schoolId: string, updatedAt?: string): string {
  return photoSrc(logoPath(schoolId), updatedAt)
}

/** Replaces the logo. The type is the file's own (PNG or JPEG), the version the profile's. */
export function upload(schoolId: string, file: Blob, expectedVersion: number) {
  return putPhoto(logoPath(schoolId), file, expectedVersion)
}

export function remove(schoolId: string, expectedVersion: number) {
  return deletePhoto(logoPath(schoolId), expectedVersion)
}
