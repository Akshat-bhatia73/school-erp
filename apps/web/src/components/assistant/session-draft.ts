/**
 * Unsent words kept for the length of the browser tab, so leaving the assistant for another screen
 * and coming back does not lose them. sessionStorage only: nothing outlives the tab, and a browser
 * that refuses storage simply keeps the draft in memory.
 */
import { useCallback, useState } from 'react'

function readRaw(key: string): unknown {
  try {
    const raw = window.sessionStorage.getItem(key)
    return raw === null ? undefined : JSON.parse(raw)
  } catch {
    return undefined
  }
}

function writeRaw(key: string, value: unknown) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or refused: the draft stays in memory only.
  }
}

/** Forget a kept draft without holding it in state (a screen that is about to go away). */
export function clearSessionDraft(key: string) {
  try {
    window.sessionStorage.removeItem(key)
  } catch {
    // Nothing kept, nothing to clear.
  }
}

/**
 * State that is also kept under `key` in sessionStorage. `restore` turns what was kept back into a
 * value, or null when it no longer fits (then `initial` is used). Setting a value equal to `empty`
 * (the default of '' suits a text box) forgets the kept copy; `clear` forgets it and resets.
 */
export function useSessionDraft<T>(key: string, options: {
  initial: () => T
  restore: (kept: unknown) => T | null
  isEmpty?: (value: T) => boolean
}): [T, (next: T) => void, () => void] {
  const { initial, restore, isEmpty } = options
  const [value, setValue] = useState<T>(() => {
    const kept = readRaw(key)
    return (kept === undefined ? null : restore(kept)) ?? initial()
  })

  const set = useCallback((next: T) => {
    setValue(next)
    if (isEmpty?.(next)) clearSessionDraft(key)
    else writeRaw(key, next)
  }, [key, isEmpty])

  const clear = useCallback(() => {
    clearSessionDraft(key)
    setValue(initial())
  }, [key, initial])

  return [value, set, clear]
}

/** The kept question in the composer: any string. */
export const restoreText = (kept: unknown): string | null => (typeof kept === 'string' ? kept : null)
export const emptyText = (value: string) => value === ''
export const noText = () => ''

export const draftKeys = {
  /** The composer of one conversation, or of a new one when there is no thread yet. */
  question: (schoolId: string, threadId?: string) => `erp:assistant:draft:${schoolId}:${threadId ?? 'new'}`,
  /** One change card's edited preview, while it is open. */
  proposal: (proposalId: string) => `erp:assistant:proposal:${proposalId}`,
}
