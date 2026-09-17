import { describe, expect, it } from 'vitest'
import { DEFAULT_RETURN_TO, sanitiseReturnTo } from '@/lib/return-to'

describe('sanitiseReturnTo', () => {
  it('keeps our own paths, with their search string', () => {
    expect(sanitiseReturnTo('/students?grade=5')).toBe('/students?grade=5')
    expect(sanitiseReturnTo('/settings/users')).toBe('/settings/users')
  })

  it('refuses anything that could leave the app', () => {
    for (const value of ['//evil.test', 'https://evil.test', '/\\evil.test', 'javascript:alert(1)', 'students', '', null, undefined, 42]) {
      expect(sanitiseReturnTo(value)).toBe(DEFAULT_RETURN_TO)
    }
  })

  it('refuses auth screens so signing in cannot loop', () => {
    expect(sanitiseReturnTo('/login')).toBe(DEFAULT_RETURN_TO)
    expect(sanitiseReturnTo('/mfa/verify')).toBe(DEFAULT_RETURN_TO)
    expect(sanitiseReturnTo('/select-school')).toBe(DEFAULT_RETURN_TO)
  })

  it('keeps an invitation link, so signing in returns to it', () => {
    expect(sanitiseReturnTo('/accept-invite?token=abc.def')).toBe('/accept-invite?token=abc.def')
  })
})
