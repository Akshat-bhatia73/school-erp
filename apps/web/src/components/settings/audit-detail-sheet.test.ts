import { describe, expect, it } from 'vitest'
import { actionLabel } from '@/components/settings/audit-detail-sheet'

describe('actionLabel', () => {
  it('names restriction changes in plain words', () => {
    expect(actionLabel('access.restrict')).toBe('Restricted a member')
    expect(actionLabel('access.restriction_lift')).toBe('Lifted a restriction')
  })

  it('turns any other raw action name into words', () => {
    expect(actionLabel('members.suspend')).toBe('Members suspend')
    expect(actionLabel('students.update_basic')).toBe('Students update basic')
  })
})
