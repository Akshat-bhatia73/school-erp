import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import test from 'node:test'
import { cleanPhoto, sniffImageType } from '../src/files/images.ts'

/** A JPEG segment: marker, then its big endian length including the length. */
function jpegSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header[0] = 0xff
  header[1] = marker
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([header, payload])
}

/** A tiny but structurally real JPEG: JFIF header, the blocks asked for, scan. */
function jpeg(extra: readonly Buffer[] = []): Buffer {
  const soi = Buffer.from([0xff, 0xd8])
  const app0 = jpegSegment(0xe0, Buffer.from('JFIF\0\x01\x02\0\0\x01\0\x01\0\0', 'latin1'))
  const sos = Buffer.concat([
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    // Entropy coded data, then the end of image marker.
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]),
  ])
  return Buffer.concat([soi, app0, ...extra, sos])
}

const EXIF_WITH_A_PLACE = jpegSegment(
  0xe1,
  Buffer.from('Exif\0\0MM\0*GPSLatitude 12.9716 GPSLongitude 77.5946', 'latin1'),
)
const COMMENT = jpegSegment(0xfe, Buffer.from('Taken at home', 'latin1'))

/** A PNG chunk: length, type, data, and a checksum we do not need to verify. */
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, data, Buffer.alloc(4)])
}

function png(extra: readonly Buffer[] = []): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 0
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    ...extra,
    pngChunk('IDAT', deflateSync(Buffer.from([0x00, 0x00]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

test('the type comes from the first bytes, never from a name or a claim', () => {
  assert.equal(sniffImageType(jpeg()), 'image/jpeg')
  assert.equal(sniffImageType(png()), 'image/png')
  // A Windows program called photo.jpg is still a program.
  assert.equal(sniffImageType(Buffer.from('MZ\x90\0this is an exe', 'latin1')), null)
  // So is an SVG, which a browser would happily run as a document.
  assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null)
})

test('a renamed program or an SVG is refused, with nothing stored', () => {
  for (const bytes of [
    Buffer.from('MZ\x90\0this is an exe', 'latin1'),
    Buffer.from('<svg onload="alert(1)"></svg>'),
    Buffer.from(''),
  ]) {
    const checked = cleanPhoto(bytes)
    assert.equal(checked.ok, false)
  }
})

test('a JPEG keeps its picture and loses the place it was taken', () => {
  const checked = cleanPhoto(jpeg([EXIF_WITH_A_PLACE, COMMENT]))
  assert.equal(checked.ok, true)
  if (!checked.ok) return
  assert.equal(checked.image.contentType, 'image/jpeg')
  const text = Buffer.from(checked.image.bytes).toString('latin1')
  assert.equal(text.includes('Exif'), false)
  assert.equal(text.includes('GPSLatitude'), false)
  assert.equal(text.includes('Taken at home'), false)
  // The JFIF header and the scan itself are untouched.
  assert.equal(text.includes('JFIF'), true)
  assert.equal(checked.image.bytes.length, jpeg().length)
})

test('a JPEG with nothing to remove comes back exactly as it was', () => {
  const original = jpeg()
  const checked = cleanPhoto(original)
  assert.equal(checked.ok, true)
  if (!checked.ok) return
  assert.deepEqual(Buffer.from(checked.image.bytes), original)
})

test('a PNG loses its text and EXIF chunks and keeps its pixels', () => {
  const withText = png([
    pngChunk('tEXt', Buffer.from('Author\0Ravi Kumar', 'latin1')),
    pngChunk('eXIf', Buffer.from('MM\0*GPSLatitude', 'latin1')),
  ])
  const checked = cleanPhoto(withText)
  assert.equal(checked.ok, true)
  if (!checked.ok) return
  assert.equal(checked.image.contentType, 'image/png')
  const text = Buffer.from(checked.image.bytes).toString('latin1')
  assert.equal(text.includes('Ravi Kumar'), false)
  assert.equal(text.includes('GPSLatitude'), false)
  assert.equal(text.includes('IDAT'), true)
  assert.equal(text.includes('IEND'), true)
  assert.deepEqual(Buffer.from(checked.image.bytes), png())
})

test('a damaged file is refused rather than half read', () => {
  // A JPEG that claims a segment longer than the file it is in.
  const lying = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe2, 0x7f, 0xff]),
    Buffer.from('short'),
  ])
  assert.equal(cleanPhoto(lying).ok, false)
  // A PNG header with no image data at all.
  const empty = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  assert.equal(cleanPhoto(empty).ok, false)
})

test('anything over one megabyte is refused before it is looked at', () => {
  const big = Buffer.concat([jpeg(), Buffer.alloc(1_048_576)])
  assert.equal(cleanPhoto(big).ok, false)
})

/** A RIFF chunk: the four letter tag, its little endian size, the payload. */
function webpChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.write(type, 0, 'latin1')
  head.writeUInt32LE(data.length, 4)
  // Every chunk is padded to an even length.
  const pad = data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)
  return Buffer.concat([head, data, pad])
}

/** The extended header, saying the file carries EXIF and XMP blocks. */
function vp8x(flags: number): Buffer {
  const payload = Buffer.alloc(10)
  payload[0] = flags
  return webpChunk('VP8X', payload)
}

function webp(chunks: readonly Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks])
  const header = Buffer.alloc(8)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(body.length, 4)
  return Buffer.concat([header, body])
}

const VP8 = webpChunk('VP8 ', Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]))

test('a plain WebP comes back as a file that describes itself correctly', () => {
  const original = webp([VP8])
  const checked = cleanPhoto(original)
  assert.equal(checked.ok, true)
  if (!checked.ok) return
  assert.equal(checked.image.contentType, 'image/webp')
  assert.deepEqual(Buffer.from(checked.image.bytes), original)
})

test('a WebP loses its EXIF and XMP blocks and stops claiming to have them', () => {
  const dirty = webp([
    vp8x(0x08 | 0x04 | 0x10),
    VP8,
    webpChunk('EXIF', Buffer.from('MM\0*GPSLatitude 12.9716', 'latin1')),
    webpChunk('XMP ', Buffer.from('<x:xmpmeta>Ravi Kumar</x:xmpmeta>', 'latin1')),
  ])
  const checked = cleanPhoto(dirty)
  assert.equal(checked.ok, true)
  if (!checked.ok) return
  const cleaned = Buffer.from(checked.image.bytes)
  const text = cleaned.toString('latin1')
  assert.equal(text.includes('GPSLatitude'), false)
  assert.equal(text.includes('Ravi Kumar'), false)
  assert.equal(text.includes('EXIF'), false)
  assert.equal(text.includes('XMP'), false)
  // The alpha flag stays; the two description flags are cleared.
  assert.equal(cleaned[20], 0x10)
  // The size in the header is the file that is actually here.
  assert.equal(cleaned.readUInt32LE(4), cleaned.length - 8)
  assert.deepEqual(cleaned, webp([vp8x(0x10), VP8]))
})

test('a WebP with anything after its declared end is refused', () => {
  const trailing = Buffer.concat([webp([VP8]), Buffer.from('a whole second file')])
  assert.equal(cleanPhoto(trailing).ok, false)
})

test('a WebP whose chunk lies about its size is refused', () => {
  const lying = webp([VP8])
  // The first chunk now claims far more payload than the file holds.
  lying.writeUInt32LE(4096, 16)
  assert.equal(cleanPhoto(lying).ok, false)

  // A chunk that ends one byte short of the declared end is refused too: the
  // walk and the file have to agree exactly.
  const short = webp([VP8])
  short.writeUInt32LE(short.readUInt32LE(16) - 1, 16)
  assert.equal(cleanPhoto(short).ok, false)
})

test('a WebP with no picture in it is refused', () => {
  assert.equal(cleanPhoto(webp([vp8x(0)])).ok, false)
})
