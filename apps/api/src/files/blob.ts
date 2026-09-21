import { del, get, put } from '@vercel/blob'
import {
  DEFAULT_CONTENT_TYPE,
  isSafeStorageKey,
  type DocumentFile,
  type DocumentStorage,
} from './storage.ts'

/**
 * Private Vercel Blob store. The bytes are fetched by the API with its own
 * token and streamed through the permission-checked download route; the store
 * URL never reaches a browser, so there is nothing to copy and reuse.
 */
export function createBlobDocumentStorage(token: string): DocumentStorage {
  return {
    async read(storageKey: string): Promise<DocumentFile | null> {
      if (!isSafeStorageKey(storageKey)) return null
      try {
        const found = await get(storageKey, { access: 'private', token, useCache: false })
        if (!found || found.statusCode !== 200) return null
        return {
          stream: found.stream,
          contentType: DEFAULT_CONTENT_TYPE,
          sizeBytes: found.blob.size,
        }
      } catch {
        // A missing file and an unreachable store answer the same way, so the
        // difference cannot be probed.
        return null
      }
    },
    /**
     * The key the server chose is the whole key: no random suffix, so a job
     * row always names its own file, and an overwrite is allowed so producing
     * the same job twice leaves one file rather than two.
     */
    async write(storageKey: string, bytes: Uint8Array, contentType: string): Promise<void> {
      if (!isSafeStorageKey(storageKey)) throw new Error('unsafe storage key')
      await put(storageKey, Buffer.from(bytes), {
        access: 'private',
        token,
        contentType,
        addRandomSuffix: false,
        allowOverwrite: true,
      })
    },
    async remove(storageKey: string): Promise<void> {
      if (!isSafeStorageKey(storageKey)) return
      try {
        await del(storageKey, { token })
      } catch {
        // A key that is already gone is the outcome anonymisation wanted.
      }
    },
  }
}
