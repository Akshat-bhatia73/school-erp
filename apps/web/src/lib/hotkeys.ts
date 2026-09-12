import { useEffect } from 'react'

/** Global keydown hook. `combo` is like 'mod+k' or 'esc' — mod means ⌘ on Mac, Ctrl elsewhere. */
export function useHotkey(combo: string, handler: (e: KeyboardEvent) => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const parts = combo.toLowerCase().split('+')
    const key = parts[parts.length - 1]!
    const wantMod = parts.includes('mod')
    const wantShift = parts.includes('shift')
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return
      const pressed = e.key.toLowerCase()
      const named = key === 'esc' ? 'escape' : key
      if (pressed !== named) return
      if (wantMod !== (e.metaKey || e.ctrlKey)) return
      if (wantShift !== e.shiftKey) return
      handler(e)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [combo, handler, enabled])
}
