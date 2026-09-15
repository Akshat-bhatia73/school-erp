import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A whole-second countdown shared by the resend timer and the rate-limit throttle.
 * `start(seconds)` restarts it; it stops on its own at zero and when the screen goes away.
 */
export function useCountdown() {
  const [secondsLeft, setSecondsLeft] = useState(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearInterval(timer.current)
      timer.current = null
    }
  }, [])

  const stop = useCallback(() => {
    clear()
    setSecondsLeft(0)
  }, [clear])

  const start = useCallback((seconds: number) => {
    clear()
    const from = Math.max(0, Math.ceil(seconds))
    setSecondsLeft(from)
    if (from === 0) return
    timer.current = setInterval(() => {
      setSecondsLeft((current) => {
        const next = current - 1
        if (next <= 0) clear()
        return next > 0 ? next : 0
      })
    }, 1000)
  }, [clear])

  useEffect(() => clear, [clear])

  return { secondsLeft, start, stop, active: secondsLeft > 0 }
}
