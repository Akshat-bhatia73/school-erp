/**
 * A very small QR encoder, written here so enrolment can show a scannable code without adding a
 * dependency for one screen. Byte mode, error correction level L, versions 1 to 12 — an
 * `otpauth://` URI is always well inside that. Everything below follows ISO/IEC 18004.
 */

/** Total codewords per version (1 to 12), data plus error correction. */
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466]
/** Error correction codewords in each block, level L. */
const EC_PER_BLOCK = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24]
/** Number of blocks the data is split into, level L. */
const BLOCKS = [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4]
/** Row and column centres of the alignment patterns. */
const ALIGNMENT: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58],
]

export interface QrMatrix {
  /** Modules per side, without the quiet zone. */
  size: number
  /** `modules[y][x]` — true is a dark module. */
  modules: boolean[][]
}

// ---------- GF(256) arithmetic ----------

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!
}

function mul(a: number, b: number) {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a]! + LOG[b]!]!
}

function generatorPoly(degree: number): number[] {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ poly[j]!
      next[j + 1] = (next[j + 1] ?? 0) ^ mul(poly[j]!, EXP[i]!)
    }
    poly = next
  }
  return poly
}

/** Reed-Solomon remainder: the error correction codewords for one block. */
export function errorCorrection(data: number[], ecLength: number): number[] {
  const gen = generatorPoly(ecLength)
  const remainder = new Array<number>(ecLength).fill(0)
  for (const byte of data) {
    const factor = byte ^ remainder[0]!
    remainder.shift()
    remainder.push(0)
    if (factor !== 0) {
      for (let i = 0; i < ecLength; i++) remainder[i] = remainder[i]! ^ mul(gen[i + 1]!, factor)
    }
  }
  return remainder
}

// ---------- format and version information ----------

/** The 15 bit format string for level L and the given mask. A published constant per mask. */
export function formatBits(mask: number): number {
  const data = (0b01 << 3) | mask
  let rest = data << 10
  for (let i = 14; i >= 10; i--) {
    if ((rest >> i) & 1) rest ^= 0b10100110111 << (i - 10)
  }
  return ((data << 10) | rest) ^ 0b101010000010010
}

function versionBits(version: number): number {
  let rest = version << 12
  for (let i = 17; i >= 12; i--) {
    if ((rest >> i) & 1) rest ^= 0b1111100100 << (i - 12)
  }
  return (version << 12) | rest
}

// ---------- bit stream ----------

function dataCodewordCount(version: number) {
  const index = version - 1
  return TOTAL_CODEWORDS[index]! - EC_PER_BLOCK[index]! * BLOCKS[index]!
}

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= 12; version++) {
    const headerBits = 4 + (version < 10 ? 8 : 16)
    if (dataCodewordCount(version) * 8 >= headerBits + byteLength * 8) return version
  }
  throw new Error('Text is too long for this QR encoder')
}

function buildCodewords(bytes: number[], version: number): number[] {
  const capacity = dataCodewordCount(version)
  const bits: number[] = []
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, version < 10 ? 8 : 16)
  for (const byte of bytes) push(byte, 8)
  const terminator = Math.min(4, capacity * 8 - bits.length)
  push(0, terminator)
  while (bits.length % 8 !== 0) bits.push(0)

  const codewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!
    codewords.push(byte)
  }
  const padding = [0xec, 0x11]
  while (codewords.length < capacity) codewords.push(padding[(codewords.length - bits.length / 8) % 2]!)
  return codewords
}

/** Split into blocks, add error correction, then interleave as the standard requires. */
function interleave(codewords: number[], version: number): number[] {
  const index = version - 1
  const blockCount = BLOCKS[index]!
  const ecLength = EC_PER_BLOCK[index]!
  const total = dataCodewordCount(version)
  const shortLength = Math.floor(total / blockCount)
  const longCount = total % blockCount

  const dataBlocks: number[][] = []
  const ecBlocks: number[][] = []
  let offset = 0
  for (let b = 0; b < blockCount; b++) {
    const length = shortLength + (b >= blockCount - longCount ? 1 : 0)
    const block = codewords.slice(offset, offset + length)
    offset += length
    dataBlocks.push(block)
    ecBlocks.push(errorCorrection(block, ecLength))
  }

  const out: number[] = []
  for (let i = 0; i < shortLength + 1; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]!)
  }
  for (let i = 0; i < ecLength; i++) {
    for (const block of ecBlocks) out.push(block[i]!)
  }
  return out
}

// ---------- matrix ----------

type Grid = Array<Array<boolean | null>>

function placeFunctionPatterns(grid: Grid, size: number, version: number) {
  const setFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = row + r
        const x = col + c
        if (y < 0 || y >= size || x < 0 || x >= size) continue
        const edge = Math.max(Math.abs(r - 3), Math.abs(c - 3))
        grid[y]![x] = edge !== 2 && edge <= 3
      }
    }
  }
  setFinder(0, 0)
  setFinder(0, size - 7)
  setFinder(size - 7, 0)

  for (let i = 8; i < size - 8; i++) {
    grid[6]![i] = i % 2 === 0
    grid[i]![6] = i % 2 === 0
  }

  const centres = ALIGNMENT[version - 1]!
  for (const row of centres) {
    for (const col of centres) {
      const onFinder = (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8)
      if (onFinder) continue
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          grid[row + r]![col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1
        }
      }
    }
  }

  // Dark module and the reserved format areas.
  grid[size - 8]![8] = true
  for (let i = 0; i < 9; i++) {
    if (grid[8]![i] === null) grid[8]![i] = false
    if (grid[i]![8] === null) grid[i]![8] = false
  }
  for (let i = 0; i < 8; i++) {
    if (grid[8]![size - 1 - i] === null) grid[8]![size - 1 - i] = false
    if (grid[size - 1 - i]![8] === null) grid[size - 1 - i]![8] = false
  }

  if (version >= 7) {
    const bits = versionBits(version)
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >> i) & 1) === 1
      const row = Math.floor(i / 3)
      const col = i % 3
      grid[size - 11 + col]![row] = bit
      grid[row]![size - 11 + col] = bit
    }
  }
}

function reserved(grid: Grid, y: number, x: number) {
  return grid[y]![x] !== null
}

function placeData(grid: Grid, size: number, codewords: number[]) {
  let bitIndex = 0
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step
      for (const x of [right, right - 1]) {
        if (reserved(grid, y, x)) continue
        const byte = codewords[bitIndex >> 3] ?? 0
        grid[y]![x] = ((byte >> (7 - (bitIndex & 7))) & 1) === 1
        bitIndex++
      }
    }
    upward = !upward
  }
}

function maskValue(mask: number, y: number, x: number): boolean {
  switch (mask) {
    case 0: return (y + x) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (y + x) % 3 === 0
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
    case 5: return ((y * x) % 2) + ((y * x) % 3) === 0
    case 6: return (((y * x) % 2) + ((y * x) % 3)) % 2 === 0
    default: return (((y + x) % 2) + ((y * x) % 3)) % 2 === 0
  }
}

function penalty(modules: boolean[][], size: number): number {
  let score = 0
  const runScore = (line: boolean[]) => {
    let run = 1
    for (let i = 1; i < size; i++) {
      if (line[i] === line[i - 1]) {
        run++
        if (run === 5) score += 3
        else if (run > 5) score += 1
      } else run = 1
    }
  }
  for (let y = 0; y < size; y++) runScore(modules[y]!)
  for (let x = 0; x < size; x++) runScore(modules.map((row) => row[x]!))

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const a = modules[y]![x]
      if (a === modules[y]![x + 1] && a === modules[y + 1]![x] && a === modules[y + 1]![x + 1]) score += 3
    }
  }

  // The finder-like 1:1:3:1:1 sequence, in both directions.
  const pattern = [true, false, true, true, true, false, true, false, false, false, false]
  const reversedPattern = [...pattern].reverse()
  const hasAt = (line: boolean[], start: number, want: boolean[]) =>
    want.every((value, i) => line[start + i] === value)
  const patternScore = (line: boolean[]) => {
    for (let i = 0; i + 11 <= size; i++) {
      if (hasAt(line, i, pattern) || hasAt(line, i, reversedPattern)) score += 40
    }
  }
  for (let y = 0; y < size; y++) patternScore(modules[y]!)
  for (let x = 0; x < size; x++) patternScore(modules.map((row) => row[x]!))

  let dark = 0
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y]![x]) dark++
  const ratio = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10
  return score
}

/** Encode text as a QR matrix. Throws only when the text will not fit in version 12. */
export function encodeQr(text: string, options: { mask?: number } = {}): QrMatrix {
  const bytes = Array.from(new TextEncoder().encode(text))
  const version = chooseVersion(bytes.length)
  const size = version * 4 + 17
  const codewords = interleave(buildCodewords(bytes, version), version)

  const base: Grid = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null))
  placeFunctionPatterns(base, size, version)
  const isFunction: boolean[][] = base.map((row) => row.map((cell) => cell !== null))
  placeData(base, size, codewords)

  let best: boolean[][] | null = null
  let bestScore = Infinity
  const candidates = options.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [options.mask]
  for (const mask of candidates) {
    const modules = base.map((row, y) => row.map((cell, x) => {
      const value = cell === true
      return isFunction[y]![x] ? value : value !== maskValue(mask, y, x)
    }))
    const bits = formatBits(mask)
    applyFormat(modules, size, bits)
    const score = penalty(modules, size)
    if (score < bestScore) {
      bestScore = score
      best = modules
    }
  }
  return { size, modules: best! }
}

function applyFormat(modules: boolean[][], size: number, bits: number) {
  for (let i = 0; i < 15; i++) {
    // The 15 bit string is written most significant bit first.
    const bit = ((bits >> (14 - i)) & 1) === 1
    // The copy that wraps the top-left finder.
    if (i < 6) modules[8]![i] = bit
    else if (i === 6) modules[8]![7] = bit
    else if (i === 7) modules[8]![8] = bit
    else if (i === 8) modules[7]![8] = bit
    else modules[14 - i]![8] = bit
    // The copy split between the other two finders.
    if (i < 7) modules[size - 1 - i]![8] = bit
    else modules[8]![size - 15 + i] = bit
  }
  modules[size - 8]![8] = true
}

