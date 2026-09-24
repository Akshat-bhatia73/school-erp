/** The pure helpers behind the message screens. */
import { describe, expect, it } from 'vitest'
import { attachmentProblem, audienceInputOf, formatBytes, isoToLocalInput, localInputToIso, noticePlaceholders, previewSentence } from './labels'

const empty = { gradeId: '', sectionId: '', studentId: '' }

describe('audienceInputOf', () => {
  it('is null until the choice is finished', () => {
    expect(audienceInputOf({ ...empty, kind: null })).toBeNull()
    expect(audienceInputOf({ ...empty, kind: 'section' })).toBeNull()
    expect(audienceInputOf({ ...empty, kind: 'pupil' })).toBeNull()
  })
  it('names only the id the kind needs', () => {
    expect(audienceInputOf({ kind: 'school', gradeId: 'g', sectionId: 's', studentId: 'p' })).toEqual({ kind: 'school' })
    expect(audienceInputOf({ ...empty, kind: 'grade', gradeId: 'g' })).toEqual({ kind: 'grade', gradeId: 'g' })
    expect(audienceInputOf({ ...empty, kind: 'pupil', studentId: 'p' })).toEqual({ kind: 'pupil', studentId: 'p' })
  })
})

describe('noticePlaceholders', () => {
  it('allows pupil placeholders only for one pupil', () => {
    expect(noticePlaceholders('section')).toEqual(['school'])
    expect(noticePlaceholders('pupil')).toContain('pupil_name')
  })
})

describe('previewSentence', () => {
  const base = { audience: { kind: 'school' as const, label: 'Whole school' }, recipients: 58, inApp: 51, email: 44, noConsent: 4, notReceiving: 0, noContact: 0 }
  it('reads as the design says', () => {
    expect(previewSentence(base)).toBe('Goes to 58 families: 51 in the app, 44 by email. 4 have not agreed to messages and will get nothing.')
  })
  it('counts staff as people and leaves out empty groups', () => {
    expect(previewSentence({ ...base, audience: { kind: 'staff', label: 'All staff' }, recipients: 1, noConsent: 0 })).toBe('Goes to 1 person: 51 in the app, 44 by email.')
  })
})

describe('school time', () => {
  it('reads a typed time as Indian Standard Time and back', () => {
    expect(localInputToIso('2026-09-24T09:30')).toBe('2026-09-24T04:00:00.000Z')
    expect(isoToLocalInput('2026-09-24T04:00:00.000Z')).toBe('2026-09-24T09:30')
    expect(localInputToIso('')).toBeNull()
  })
})

describe('attachments', () => {
  it('refuses the wrong type, a big file and a fourth file', () => {
    expect(attachmentProblem({ type: 'application/pdf', size: 1000 }, 0)).toBeNull()
    expect(attachmentProblem({ type: 'text/plain', size: 10 }, 0)).toMatch(/PDF, JPEG or PNG/)
    expect(attachmentProblem({ type: 'image/png', size: 3 * 1024 * 1024 }, 0)).toMatch(/2 MB/)
    expect(attachmentProblem({ type: 'image/png', size: 10 }, 3)).toMatch(/three/)
  })
  it('writes sizes plainly', () => {
    expect(formatBytes(2 * 1024 * 1024)).toBe('2 MB')
    expect(formatBytes(340 * 1024)).toBe('340 KB')
  })
})
