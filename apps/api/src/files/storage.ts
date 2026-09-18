import { createReadStream } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import { isAbsolute, join, normalize, sep } from 'node:path'

/**
 * A private document is fetched by its storage key, which is server state and
 * never leaves the API. The storage only reads: nothing here decides whether
 * the caller may have the bytes, and no caller may name a path of its own.
 */
export interface DocumentFile {
  readonly stream: ReadableStream | NodeJS.ReadableStream
  readonly contentType: string
  readonly sizeBytes: number
}

export interface DocumentStorage {
  /** The file, or null when the key names nothing this storage holds. */
  read(storageKey: string): Promise<DocumentFile | null>
  /**
   * Destroy the bytes behind a key. Anonymisation has to reach the object
   * store as well as the row, so a key that no longer exists is not an error:
   * the outcome asked for is already true.
   */
  remove(storageKey: string): Promise<void>
}

/** Bytes are typed by the caller's own record, never sniffed from the file. */
const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

/**
 * A key is an opaque name, not a path. Anything that could climb out of the
 * root, or that names an absolute location, is refused rather than cleaned up,
 * because a cleaned-up key would still be a caller-chosen path.
 */
export function isSafeStorageKey(storageKey: string): boolean {
  if (storageKey.length === 0 || storageKey.length > 512) return false
  if (storageKey.startsWith('/') || isAbsolute(storageKey)) return false
  if (storageKey.includes('\0') || storageKey.includes('\\')) return false
  return !storageKey.split('/').includes('..')
}

export function createLocalDocumentStorage(rootDir: string): DocumentStorage {
  const root = normalize(rootDir)
  return {
    async read(storageKey: string): Promise<DocumentFile | null> {
      if (!isSafeStorageKey(storageKey)) return null
      const full = normalize(join(root, storageKey))
      // Normalising twice is cheap; this is the check that actually matters.
      if (full !== root && !full.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return null
      try {
        const info = await stat(full)
        if (!info.isFile()) return null
        return {
          stream: createReadStream(full),
          contentType: DEFAULT_CONTENT_TYPE,
          sizeBytes: info.size,
        }
      } catch {
        // A missing file and an unreadable one answer the same way, so the
        // difference cannot be probed.
        return null
      }
    },
    async remove(storageKey: string): Promise<void> {
      if (!isSafeStorageKey(storageKey)) return
      const full = normalize(join(root, storageKey))
      if (full !== root && !full.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return
      try {
        await unlink(full)
      } catch {
        // Already gone, or never ours to begin with.
      }
    },
  }
}

export interface MemoryDocumentStorage extends DocumentStorage {
  put(storageKey: string, bytes: Uint8Array, contentType?: string): void
  clear(): void
}

/** In-memory storage for tests. It applies exactly the same key rules. */
export function createMemoryDocumentStorage(): MemoryDocumentStorage {
  const files = new Map<string, { bytes: Uint8Array; contentType: string }>()
  return {
    put(storageKey, bytes, contentType = DEFAULT_CONTENT_TYPE) {
      files.set(storageKey, { bytes, contentType })
    },
    clear() {
      files.clear()
    },
    async read(storageKey) {
      if (!isSafeStorageKey(storageKey)) return null
      const found = files.get(storageKey)
      if (!found) return null
      const bytes = found.bytes
      return {
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes)
            controller.close()
          },
        }),
        contentType: found.contentType,
        sizeBytes: bytes.byteLength,
      }
    },
    async remove(storageKey) {
      files.delete(storageKey)
    },
  }
}
