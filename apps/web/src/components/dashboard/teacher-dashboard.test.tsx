/**
 * The teacher dashboard: where they are in the day right now, the rest of today and the week.
 * The clock is fixed in these tests, so "Now" and "Next" are checked against a known minute.
 */
import type { ReactNode } from 'react'
import { screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TeacherDashboard as TeacherDashboardData } from '@erp/contracts'
import { TeacherDashboard } from '@/components/dashboard/teacher-dashboard'
import { renderWithSession } from '@/test/session'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    createFileRoute: () => (options: unknown) => options,
    Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
    useNavigate: () => vi.fn(),
  }
})

// The week grid is the real TimetableGrid, so the screen reads the year's bell schedules.
vi.mock('@/lib/api', () => ({
  api: {
    timetable: {
      bellSchedules: vi.fn(async () => [{
        id: 'bell-1',
        schoolId: 'school-1',
        academicYearId: 'year-1',
        name: 'Main',
        gradeIds: [],
        periods: [
          { index: 1, name: 'Period 1', startTime: '08:00', endTime: '08:45', type: 'period' },
          { index: 2, name: 'Period 2', startTime: '08:45', endTime: '09:30', type: 'period' },
        ],
        workingDays: [1, 2, 3, 4, 5],
        version: 1,
      }]),
    },
  },
}))

const SIX_A = { id: 'sec-1', name: 'Six A' }
const SEVEN_B = { id: 'sec-2', name: 'Seven B' }
const MATHS = { id: 'sub-1', name: 'Mathematics' }
const SCIENCE = { id: 'sub-2', name: 'Science' }

const TIMELINE: TeacherDashboardData['timeline'] = [
  { periodIndex: 1, name: 'Period 1', startTime: '08:00', endTime: '08:45', type: 'period', lesson: { section: SIX_A, subject: MATHS, roomNumber: '12', cover: false } },
  { periodIndex: 2, name: 'Period 2', startTime: '08:45', endTime: '09:30', type: 'period' },
  { periodIndex: 3, name: 'Period 3', startTime: '09:30', endTime: '10:15', type: 'period', lesson: { section: SEVEN_B, subject: SCIENCE, cover: true } },
]

function teacher(patch: Partial<TeacherDashboardData> = {}): TeacherDashboardData {
  return {
    audience: 'teacher',
    day: { date: '2026-09-21', dayOfWeek: 1, kind: 'school_day' },
    staffLinked: true,
    academicYearId: 'year-1',
    timeline: TIMELINE,
    timelineDate: '2026-09-21',
    week: [{ dayOfWeek: 1, periodIndex: 1, section: SIX_A, subject: MATHS, roomNumber: '12' }],
    periods: [{ index: 1, name: 'Period 1', startTime: '08:00', endTime: '08:45', type: 'period' }],
    holidays: [],
    ...patch,
  } as TeacherDashboardData
}

/** Render with the browser clock stopped at a known time on the dashboard date. */
function renderAt(clock: string, data: TeacherDashboardData = teacher()) {
  vi.setSystemTime(new Date(`2026-09-21T${clock}:00`))
  return renderWithSession(<TeacherDashboard data={data} isLoading={false} error={undefined} />, {
    roleKeys: ['teacher'],
    capabilities: ['dashboard.read', 'timetable.read', 'students.read_basic'],
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => vi.useRealTimers())

describe('teacher dashboard, now and next', () => {
  it('names the class being taught right now and the one after it', () => {
    renderAt('08:10')
    expect(screen.getByText('Now: Mathematics, Six A, Room 12, until 8:45 am.')).toBeInTheDocument()
    expect(screen.getByText('Next: Seven B at 9:30 am.')).toBeInTheDocument()
  })

  it('says how long a free period lasts', () => {
    renderAt('08:50')
    expect(screen.getByText('Free until 9:30 am.')).toBeInTheDocument()
    expect(screen.getByText('Next: Seven B at 9:30 am.')).toBeInTheDocument()
  })

  it('says when the school day has not started yet', () => {
    renderAt('07:10')
    // The strip and the Now and next card carry the same sentence.
    expect(screen.getAllByText('School starts with Six A at 8:00 am.').length).toBeGreaterThan(0)
  })

  it('says the day is done once the last class is over', () => {
    renderAt('11:30')
    expect(screen.getAllByText('Done for today.').length).toBeGreaterThan(0)
  })

  it('marks a cover duty while it is being taught', () => {
    renderAt('09:40')
    expect(screen.getByText('Cover duty')).toBeInTheDocument()
    expect(screen.getByText('Now: Science, Seven B, until 10:15 am.')).toBeInTheDocument()
  })
})

describe('teacher dashboard, days without school', () => {
  it('says there is no school on a Sunday and what Monday starts with', () => {
    renderAt('09:00', teacher({
      day: { date: '2026-09-20', dayOfWeek: 0, kind: 'sunday', nextSchoolDay: { date: '2026-09-21', dayOfWeek: 1 } },
      timelineDate: '2026-09-21',
    }))
    expect(screen.getAllByText(/No school today\./).length).toBeGreaterThan(0)
    expect(screen.getByText('Monday starts with Six A at 8:00 am.')).toBeInTheDocument()
  })

  it('names the holiday', () => {
    renderAt('09:00', teacher({
      day: { date: '2026-10-02', dayOfWeek: 5, kind: 'holiday', holidayName: 'Gandhi Jayanti', nextSchoolDay: { date: '2026-10-03', dayOfWeek: 6 } },
      timelineDate: '2026-10-03',
    }))
    expect(screen.getByText('No school today. Gandhi Jayanti.')).toBeInTheDocument()
  })
})

describe('teacher dashboard, the rest of the screen', () => {
  it('says so plainly when the login is not linked to a staff record', () => {
    renderAt('09:00', teacher({ staffLinked: false }))
    expect(screen.getByText('Your login is not linked to a staff record yet')).toBeInTheDocument()
    expect(screen.getByText('Ask the school office to link it.')).toBeInTheDocument()
    expect(screen.queryByText('My week')).not.toBeInTheDocument()
  })

  it('offers the class list only to a teacher who may read students', () => {
    const myClass = { section: SIX_A, strength: 30, birthdaysThisWeek: [] }
    renderAt('09:00', teacher({ myClass }))
    expect(screen.getByText('Open class list').closest('a')).toHaveAttribute('href', '/students')
    expect(screen.getByText('No birthdays in your class this week.')).toBeInTheDocument()
  })

  it('has an honest empty state when there is no week to show', () => {
    renderAt('09:00', teacher({ periods: [], week: [], timeline: [] }))
    expect(screen.getByText('No week to show')).toBeInTheDocument()
    expect(screen.getByText('No periods to show')).toBeInTheDocument()
    expect(screen.getByText('No holidays in the next 30 days')).toBeInTheDocument()
  })

  it('lists the holidays ahead in Indian date format', () => {
    renderAt('09:00', teacher({ holidays: [{ id: 'h1', name: 'Dussehra', startDate: '2026-10-20', endDate: '2026-10-20', type: 'festival' }] }))
    expect(screen.getByText('Dussehra')).toBeInTheDocument()
    expect(screen.getByText('20 Oct 2026')).toBeInTheDocument()
  })

  it('lists the lessons of the shown day as pills in the hero', () => {
    renderAt('09:00')
    expect(screen.getByText('8:00 am · Mathematics')).toBeInTheDocument()
    expect(screen.getByText('Cover · 9:30 am · Science')).toBeInTheDocument()
  })
})
