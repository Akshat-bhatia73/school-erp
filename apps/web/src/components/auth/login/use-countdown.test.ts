import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useCountdown } from '@/components/auth/login/use-countdown'

afterEach(() => { vi.useRealTimers() })

describe('useCountdown', () => {
  it('counts down one second at a time and stops at zero', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useCountdown())
    act(() => { result.current.start(3) })
    expect(result.current.secondsLeft).toBe(3)
    act(() => { vi.advanceTimersByTime(2000) })
    expect(result.current.secondsLeft).toBe(1)
    act(() => { vi.advanceTimersByTime(5000) })
    expect(result.current.secondsLeft).toBe(0)
    expect(result.current.active).toBe(false)
  })

  it('restarts cleanly and can be stopped', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useCountdown())
    act(() => { result.current.start(10) })
    act(() => { result.current.start(5) })
    expect(result.current.secondsLeft).toBe(5)
    act(() => { result.current.stop() })
    expect(result.current.secondsLeft).toBe(0)
  })
})
