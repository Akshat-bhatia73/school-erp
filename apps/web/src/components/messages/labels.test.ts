/** The pure helpers behind the message screens. */
import { describe, expect, it } from 'vitest'
import {
  attachmentProblem, audienceInputOf, audienceLine, formatBytes, hasRecipients, isoToLocalInput, localInputToIso,
  noticePlaceholders, previewSentence, rangeInOrder, recipientRelation,
} from './labels'

const empty = { gradeId: '', fromGradeId: '', toGradeId: '', sectionId: '', studentId: '', recipients: 'families' as const }

describe('audienceInputOf', () => {
  it('is null until the choice is finished', () => {
    expect(audienceInputOf({ ...empty, kind: null })).toBeNull()
    expect(audienceInputOf({ ...empty, kind: 'section' })).toBeNull()
    expect(audienceInputOf({ ...empty, kind: 'pupil' })).toBeNull()
  })
  it('names only the id the kind needs', () => {
    expect(audienceInputOf({ ...empty, kind: 'school', gradeId: 'g', sectionId: 's', studentId: 'p' })).toEqual({ kind: 'school', recipients: 'families' })
    expect(audienceInputOf({ ...empty, kind: 'grade', gradeId: 'g' })).toEqual({ kind: 'grade', gradeId: 'g', recipients: 'families' })
    expect(audienceInputOf({ ...empty, kind: 'pupil', studentId: 'p', recipients: 'both' })).toEqual({ kind: 'pupil', studentId: 'p', recipients: 'both' })
  })
  it('sends no recipients for the staff', () => {
    expect(audienceInputOf({ ...empty, kind: 'staff', recipients: 'students' })).toEqual({ kind: 'staff' })
  })
  it('needs both ends of a range', () => {
    expect(audienceInputOf({ ...empty, kind: 'grade_range', fromGradeId: 'g9' })).toBeNull()
    expect(audienceInputOf({ ...empty, kind: 'grade_range', fromGradeId: 'g9', toGradeId: 'g10', recipients: 'students' }))
      .toEqual({ kind: 'grade_range', fromGradeId: 'g9', toGradeId: 'g10', recipients: 'students' })
  })
})

describe('ranges of classes', () => {
  const grades = [{ id: 'g8' }, { id: 'g9' }, { id: 'g10' }]
  it('runs forwards in the class order, both ends included', () => {
    expect(rangeInOrder(grades, 'g8', 'g10')).toBe(true)
    expect(rangeInOrder(grades, 'g9', 'g9')).toBe(true)
    expect(rangeInOrder(grades, 'g10', 'g8')).toBe(false)
    expect(rangeInOrder(grades, 'gone', 'g8')).toBe(false)
  })
})

describe('recipients', () => {
  it('has a Send to choice only for audiences made of pupils', () => {
    expect(['school', 'grade', 'grade_range', 'section', 'pupil'].every((kind) => hasRecipients(kind as 'school'))).toBe(true)
    expect(hasRecipients('staff')).toBe(false)
    expect(hasRecipients(null)).toBe(false)
  })
  it('shows the recipients next to the label, except for one pupil', () => {
    expect(audienceLine({ kind: 'section', label: 'Class 9 A', recipients: 'both' })).toBe('Class 9 A, pupils and families')
    expect(audienceLine({ kind: 'grade_range', label: 'Class 9 to Class 10', recipients: 'students' })).toBe('Class 9 to Class 10, pupils')
    expect(audienceLine({ kind: 'pupil', label: 'Aarav Sharma and family', recipients: 'both' })).toBe('Aarav Sharma and family')
    expect(audienceLine({ kind: 'staff', label: 'All staff' })).toBe('All staff')
  })
  it('calls a pupil row a pupil', () => {
    expect(recipientRelation({ kind: 'student' })).toBe('Pupil')
    expect(recipientRelation({ kind: 'guardian', relation: 'Mother' })).toBe('Mother')
    expect(recipientRelation({ kind: 'staff' })).toBeUndefined()
  })
})

describe('noticePlaceholders', () => {
  it('allows pupil placeholders only for one pupil', () => {
    expect(noticePlaceholders('section')).toEqual(['school'])
    expect(noticePlaceholders('pupil')).toContain('pupil_name')
  })
})

describe('previewSentence', () => {
  const base = { audience: { kind: 'school' as const, label: 'Whole school' }, recipients: 58, pupils: 0, pupilsInApp: 0, inApp: 51, email: 44, noConsent: 4, notReceiving: 0, noContact: 0 }
  it('reads as the design says', () => {
    expect(previewSentence(base)).toBe('Goes to 58 families: 51 in the app, 44 by email. 4 have not agreed to messages and will get nothing.')
  })
  it('counts staff as people and leaves out empty groups', () => {
    expect(previewSentence({ ...base, audience: { kind: 'staff', label: 'All staff' }, recipients: 1, noConsent: 0 })).toBe('Goes to 1 person: 51 in the app, 44 by email.')
  })
  it('mentions the pupils when any are in it', () => {
    const both = { ...base, recipients: 98, pupils: 40, pupilsInApp: 31, inApp: 82, email: 44, noConsent: 0, noContact: 9 }
    expect(previewSentence(both)).toBe(
      'Goes to 58 families and 40 pupils: 31 pupils have a login and will see it in the app. 9 pupils have no login yet. The families: 51 in the app, 44 by email.',
    )
    const pupilsOnly = { ...base, recipients: 40, pupils: 40, pupilsInApp: 40, inApp: 40, email: 0, noConsent: 0 }
    expect(previewSentence(pupilsOnly)).toBe('Goes to 40 pupils: 40 pupils have a login and will see it in the app.')
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
