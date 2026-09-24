import { PHOTO_MAX_BYTES, type PhotoContentType } from '@erp/contracts'

/**
 * Photograph bytes, checked and cleaned before anything stores them.
 *
 * Two rules hold everywhere in this file. What a picture is comes from its
 * first bytes and never from the upload's content type or file name, so a
 * renamed program cannot become an accepted image. And a picture that is
 * accepted is rewritten here, keeping only the parts that draw it: a camera
 * writes the time, the lens and often the exact place into the file, and a
 * school photograph must not carry a child's home location.
 */

export interface CleanImage {
  /** What the bytes actually are, decided here and stored on the record. */
  readonly contentType: PhotoContentType
  /** The picture again, with the description blocks removed. */
  readonly bytes: Uint8Array
}

/**
 * The reason is for the server's own log. The caller only ever learns that
 * the request was invalid, so nothing here describes the file back to it.
 */
export type ImageCheck =
  | { readonly ok: true; readonly image: CleanImage }
  | { readonly ok: false; readonly reason: string }

function refuse(reason: string): ImageCheck {
  return { ok: false, reason }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false
  return prefix.every((value, index) => bytes[at + index] === value)
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const RIFF = [0x52, 0x49, 0x46, 0x46]
const WEBP = [0x57, 0x45, 0x42, 0x50]

/**
 * The type the bytes themselves say they are, or null for anything else. A
 * text file, an SVG and a Windows program all fall out here, because none of
 * them begin with one of these three headers.
 */
export function sniffImageType(bytes: Uint8Array): PhotoContentType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png'
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'image/webp'
  return null
}

/** Four bytes, big endian, as the image formats write their lengths. */
function readUint32BE(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] as number) << 24) +
    ((bytes[at + 1] as number) << 16) +
    ((bytes[at + 2] as number) << 8) +
    (bytes[at + 3] as number)
  ) >>> 0
}

function readUint32LE(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] as number) +
    ((bytes[at + 1] as number) << 8) +
    ((bytes[at + 2] as number) << 16) +
    ((bytes[at + 3] as number) << 24)
  ) >>> 0
}

function writeUint32LE(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff
  bytes[at + 1] = (value >>> 8) & 0xff
  bytes[at + 2] = (value >>> 16) & 0xff
  bytes[at + 3] = (value >>> 24) & 0xff
}

function fourCC(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at] as number, bytes[at + 1] as number, bytes[at + 2] as number, bytes[at + 3] as number)
}

/**
 * The JPEG markers that carry description rather than picture. APP1 holds EXIF
 * and XMP, the rest of the APP range holds whatever a camera or an editor
 * decided to put there, and COM holds free text. APP0 stays: it is the JFIF
 * header that says how big a pixel is, and it carries nothing about a person.
 */
function isJpegMetadataMarker(marker: number): boolean {
  return (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe
}

/** JPEG markers that stand alone: no length, no payload. */
function isStandaloneJpegMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)
}

/**
 * A JPEG rebuilt from its segments, with every description block dropped. The
 * scan itself is copied byte for byte, so the picture is untouched: only the
 * headers in front of it change.
 */
function cleanJpeg(bytes: Uint8Array): ImageCheck {
  const parts: Uint8Array[] = [bytes.subarray(0, 2)]
  let at = 2
  while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) return refuse('jpeg segment does not start with a marker')
    // A run of fill bytes before a marker is legal; skip to the marker itself.
    let markerAt = at + 1
    while (markerAt < bytes.length && bytes[markerAt] === 0xff) markerAt += 1
    const marker = bytes[markerAt]
    if (marker === undefined) return refuse('jpeg ends inside a marker')
    if (isStandaloneJpegMarker(marker)) {
      parts.push(bytes.subarray(at, markerAt + 1))
      at = markerAt + 1
      continue
    }
    if (marker === 0xda) {
      // Start of scan: everything from here to the end is compressed picture
      // data, which no reader may reinterpret, so it is copied as it is.
      parts.push(bytes.subarray(at))
      return done(parts, 'image/jpeg')
    }
    const lengthAt = markerAt + 1
    if (lengthAt + 1 >= bytes.length) return refuse('jpeg ends inside a segment header')
    const length = ((bytes[lengthAt] as number) << 8) + (bytes[lengthAt + 1] as number)
    if (length < 2) return refuse('jpeg segment length is too small')
    const end = lengthAt + length
    if (end > bytes.length) return refuse('jpeg segment runs past the end of the file')
    if (!isJpegMetadataMarker(marker)) parts.push(bytes.subarray(at, end))
    at = end
  }
  return refuse('jpeg has no image data')
}

/** PNG chunks that hold text or an EXIF block rather than pixels. */
const PNG_METADATA_CHUNKS = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf'])

function cleanPng(bytes: Uint8Array): ImageCheck {
  const parts: Uint8Array[] = [bytes.subarray(0, 8)]
  let at = 8
  let sawImageData = false
  while (at < bytes.length) {
    if (at + 8 > bytes.length) return refuse('png ends inside a chunk header')
    const length = readUint32BE(bytes, at)
    const type = fourCC(bytes, at + 4)
    const end = at + 12 + length
    // The length is written by the file, so it is checked against the file's
    // real size before it is used to move anywhere.
    if (length > bytes.length || end > bytes.length) return refuse('png chunk runs past the end of the file')
    if (type === 'IDAT') sawImageData = true
    if (!PNG_METADATA_CHUNKS.has(type)) parts.push(bytes.subarray(at, end))
    at = end
    if (type === 'IEND') break
  }
  if (!sawImageData) return refuse('png has no image data')
  return done(parts, 'image/png')
}

/**
 * The feature flags of an extended WebP header. A file that says it carries
 * EXIF or XMP while no such chunk is there is a file some readers refuse, so
 * the flags are cleared in step with the chunks that are dropped.
 */
const VP8X_EXIF_FLAG = 0x08
const VP8X_XMP_FLAG = 0x04

/**
 * A WebP rebuilt from the chunks that were actually walked, with the EXIF and
 * XMP blocks dropped and the extended header's flags for them cleared. The
 * RIFF size is written again from what is kept, so it always describes the
 * file that is stored. A file whose chunk walk does not finish exactly where
 * the header says it ends, or that carries bytes after it, is refused: the
 * walk and the file have to agree before anything is rewritten.
 */
function cleanWebp(bytes: Uint8Array): ImageCheck {
  if (bytes.length < 12) return refuse('webp is too short to be a file')
  const declared = readUint32LE(bytes, 4)
  // The RIFF size counts everything after the size field itself.
  if (declared + 8 > bytes.length) return refuse('webp is shorter than it claims')
  if (declared + 8 < bytes.length) return refuse('webp carries bytes after its declared end')
  const end = declared + 8
  const kept: Uint8Array[] = []
  let at = 12
  let sawImageData = false
  while (at < end) {
    if (at + 8 > end) return refuse('webp ends inside a chunk header')
    const type = fourCC(bytes, at)
    const size = readUint32LE(bytes, at + 4)
    // Every chunk is padded to an even length.
    const padded = size + (size % 2)
    if (size > bytes.length || at + 8 + padded > end) {
      return refuse('webp chunk runs past the end of the file')
    }
    const next = at + 8 + padded
    if (type === 'EXIF' || type === 'XMP ') {
      // Dropped, not refused: the description is what we do not want, the
      // picture is fine.
      at = next
      continue
    }
    if (type === 'VP8X') {
      if (size < 10) return refuse('webp extended header is too short')
      const header = bytes.slice(at, next)
      // Byte 8 of the chunk is the flags byte, the first of the payload.
      header[8] = (header[8] as number) & ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG)
      kept.push(header)
      at = next
      continue
    }
    if (type === 'VP8 ' || type === 'VP8L') sawImageData = true
    kept.push(bytes.subarray(at, next))
    at = next
  }
  if (at !== end) return refuse('webp chunks do not end where the file says they do')
  if (!sawImageData) return refuse('webp has no image data')
  const total = kept.reduce((carry, part) => carry + part.length, 0)
  const header = new Uint8Array(12)
  header.set(bytes.subarray(0, 12))
  // The size counts the "WEBP" tag and every chunk that was kept.
  writeUint32LE(header, 4, total + 4)
  return done([header, ...kept], 'image/webp')
}

function done(parts: readonly Uint8Array[], contentType: PhotoContentType): ImageCheck {
  const total = parts.reduce((carry, part) => carry + part.length, 0)
  if (total === 0) return refuse('nothing was left of the picture')
  const bytes = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    bytes.set(part, at)
    at += part.length
  }
  return { ok: true, image: { contentType, bytes } }
}

/**
 * The one entry point a route uses: what these bytes are, and the same picture
 * with its description blocks gone. Anything that is not one of the three
 * accepted formats, or that is damaged enough that its own structure cannot be
 * walked, is refused here and never reaches the store.
 */
export function cleanPhoto(bytes: Uint8Array, maxBytes: number = PHOTO_MAX_BYTES): ImageCheck {
  if (bytes.length === 0) return refuse('the upload is empty')
  // A photograph is at most one megabyte; a picture sent with a message may
  // be larger (its own limit is passed in).
  if (bytes.length > maxBytes) return refuse('the upload is larger than the limit')
  const contentType = sniffImageType(bytes)
  if (contentType === null) return refuse('the upload is not a JPEG, PNG or WebP picture')
  if (contentType === 'image/jpeg') return cleanJpeg(bytes)
  if (contentType === 'image/png') return cleanPng(bytes)
  return cleanWebp(bytes)
}
