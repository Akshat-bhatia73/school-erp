import { describe, expect, it } from 'vitest'
import { academicMonths, calendarParts, countOrNone, longDate, longDayDate, monthLong, monthShort, plural, subjectColor, timeLabel, weekdayName } from '@/components/dashboard/format'
import { niceSteps } from '@/components/dashboard/blocks/bar-chart'

describe('longDayDate', () => {
  it('writes the day and the Indian style date', () => {
    expect(longDayDate('2026-09-21')).toBe('Monday, 21 Sept')
    expect(longDayDate('2026-01-01')).toBe('Thursday, 1 Jan')
  })
  it('returns the input when it is not a date', () => {
    expect(longDayDate('not a date')).toBe('not a date')
  })
})

describe('timeLabel', () => {
  it('writes a twelve hour time', () => {
    expect(timeLabel('08:00')).toBe('8:00 am')
    expect(timeLabel('13:05')).toBe('1:05 pm')
    expect(timeLabel('00:30')).toBe('12:30 am')
    expect(timeLabel('12:00')).toBe('12:00 pm')
  })
  it('returns the input when it is not a time', () => {
    expect(timeLabel('later')).toBe('later')
  })
})

describe('monthShort', () => {
  it('names the month', () => {
    expect(monthShort('2026-04')).toBe('Apr')
    expect(monthShort('2026-12')).toBe('Dec')
  })
})

describe('academicMonths', () => {
  it('lists April to March', () => {
    const months = academicMonths('2026-04-01')
    expect(months).toHaveLength(12)
    expect(months[0]).toBe('2026-04')
    expect(months[8]).toBe('2026-12')
    expect(months[9]).toBe('2027-01')
    expect(months[11]).toBe('2027-03')
  })
})

describe('plural', () => {
  it('counts with the right word', () => {
    expect(plural(1, 'teacher', 'teachers')).toBe('1 teacher')
    expect(plural(3, 'teacher', 'teachers')).toBe('3 teachers')
    expect(countOrNone(0, 'teacher', 'teachers')).toBe('No teachers')
  })
})

describe('weekdayName and longDate', () => {
  it('names the day and writes the long date', () => {
    expect(weekdayName('2026-09-20')).toBe('Sunday')
    expect(longDate('2026-09-20')).toBe('20 September 2026')
  })
  it('returns the input when it is not a date', () => {
    expect(weekdayName('not a date')).toBe('not a date')
    expect(longDate('not a date')).toBe('not a date')
  })
})

describe('calendarParts', () => {
  it('splits a date for a calendar tile', () => {
    expect(calendarParts('2026-10-02')).toEqual({ day: '2', month: 'Oct' })
  })
})

describe('monthLong', () => {
  it('writes the month and the year', () => {
    expect(monthLong('2026-09')).toBe('September 2026')
    expect(monthLong('nope')).toBe('nope')
  })
})

describe('subjectColor', () => {
  it('never picks an alert hue or grey', () => {
    const subjects = ['Maths', 'English', 'Science', 'Hindi', 'Social Studies', 'Computer', 'Art', 'PT', 'Sanskrit', 'Music']
    for (const name of subjects) {
      expect(['red', 'orange', 'grey']).not.toContain(subjectColor(name))
    }
  })
  it('gives the same subject the same colour', () => {
    expect(subjectColor('Maths')).toBe(subjectColor('Maths'))
  })
})

describe('niceSteps', () => {
  it('ends at or above the max with three to five ticks', () => {
    for (const max of [0, 1, 3, 7, 12, 22, 48, 96, 240, 999]) {
      const ticks = niceSteps(max)
      expect(ticks.length).toBeGreaterThanOrEqual(3)
      expect(ticks.length).toBeLessThanOrEqual(5)
      expect(ticks[0]).toBe(0)
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max)
      expect(ticks.every((t) => Number.isInteger(t))).toBe(true)
    }
  })
  it('picks step 10 for a max of 22', () => {
    expect(niceSteps(22)).toEqual([0, 10, 20, 30])
  })
})
