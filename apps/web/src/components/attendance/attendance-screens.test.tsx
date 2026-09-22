/**
 * Attendance screens on the real API.
 *
 * Each test fixes the window and the `allowedActions` the server sent, and checks what the screen
 * does with them: which of Save and Save corrections it draws, the body it sends, and the sentence
 * it shows when neither applies. The API module and the router are mocked, so nothing here touches
 * the network.
 */
import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PermissionKey } from '@erp/contracts'
import { renderWithSession } from '@/test/session'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const navigate = vi.fn()
let search: Record<string, unknown> = {}
let params: Record<string, string> = { sectionId: 'section-1' }

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    createFileRoute: () => (options: Record<string, unknown>) => ({
      ...options,
      useSearch: () => search,
      useParams: () => params,
      fullPath: '/attendance',
    }),
    useNavigate: () => navigate,
    Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  }
})

const attendance = {
  sections: vi.fn(),
  day: vi.fn(),
  mark: vi.fn(),
  correct: vi.fn(),
  studentMonth: vi.fn(),
  sectionMonth: vi.fn(),
  staffDay: vi.fn(),
  markStaff: vi.fn(),
  correctStaff: vi.fn(),
  staffMonth: vi.fn(),
  staffMemberMonth: vi.fn(),
  exportSectionMonth: vi.fn(),
  exportStudentMonth: vi.fn(),
  exportStaffMonth: vi.fn(),
}
const setup = { grades: vi.fn(), sections: vi.fn(), academicYears: vi.fn(), currentAcademicYear: vi.fn() }
const students = { list: vi.fn(), enrollments: vi.fn() }
const files = { exportJob: vi.fn(), downloadExportFile: vi.fn() }

vi.mock('@/lib/api', () => ({ api: { attendance, setup, students, files } }))

const SCHOOL_ID = '10000000-0000-4000-8000-000000000001'
const SECTION = { id: 'section-1', name: 'A' }
const GRADE = { id: 'grade-1', name: 'Class 6' }
const YEAR = { id: 'year-1', name: '2026-27' }
const DATE = '2026-09-22'

const PUPILS = [
  { id: 'student-1', name: 'Aarav Sharma', admissionNumber: 'SVM/2026/101', rollNumber: 1 },
  { id: 'student-2', name: 'Diya Nair', admissionNumber: 'SVM/2026/102', rollNumber: 2 },
]

/** The mocked router hands back the options object, which carries the screen's component. */
function componentOf(route: unknown): () => ReactElement {
  return (route as { component: () => ReactElement }).component
}

function dayResponse(window: Record<string, unknown>, allowedActions: PermissionKey[], marks?: Array<string | undefined>) {
  return {
    section: SECTION,
    grade: GRADE,
    academicYear: YEAR,
    date: DATE,
    day: { date: DATE, kind: 'school_day', future: false },
    window,
    marked: marks !== undefined,
    rows: PUPILS.map((student, index) => ({ student, ...(marks?.[index] ? { mark: marks[index] } : {}) })),
    allowedActions,
  }
}

async function renderDay(capabilities: PermissionKey[], roleKeys: string[]) {
  const { Route } = await import('@/routes/_app/attendance/sections/$sectionId/index')
  const Screen = componentOf(Route)
  return renderWithSession(<Screen />, { schoolId: SCHOOL_ID, capabilities, roleKeys })
}

beforeEach(() => {
  vi.clearAllMocks()
  search = {}
  params = { sectionId: 'section-1', studentId: 'student-1' }
  setup.academicYears.mockResolvedValue([])
  setup.currentAcademicYear.mockResolvedValue(null)
  setup.sections.mockResolvedValue([])
  students.enrollments.mockResolvedValue([])
})

describe('the day register', () => {
  it('offers Save attendance and sends the whole roster', async () => {
    attendance.day.mockResolvedValue(dayResponse({ record: true, correct: false }, ['attendance.read', 'attendance.record']))
    attendance.mark.mockResolvedValue(dayResponse({ record: true, correct: false }, ['attendance.read', 'attendance.record'], ['present', 'absent']))
    await renderDay(['attendance.read', 'attendance.record'], ['teacher'])

    expect(await screen.findByText('Aarav Sharma')).toBeInTheDocument()
    expect(screen.queryByText('Save corrections')).not.toBeInTheDocument()
    // The second pupil is marked absent; everybody else stays present.
    const row = screen.getByRole('group', { name: 'Mark for Diya Nair' })
    await userEvent.click(within(row).getByTitle('Absent'))
    await userEvent.click(screen.getByText('Save attendance'))

    await waitFor(() => expect(attendance.mark).toHaveBeenCalled())
    const body = attendance.mark.mock.calls[0]?.[3] as { marks: Array<{ studentId: string; mark: string }> }
    expect(body.marks).toEqual([
      { studentId: 'student-1', mark: 'present' },
      { studentId: 'student-2', mark: 'absent' },
    ])
  })

  it('offers Save corrections only once something changed, and sends the changed rows with a reason', async () => {
    const window = { record: false, recordBlockedBy: 'attendance_marking_window_closed', correct: true }
    attendance.day.mockResolvedValue(dayResponse(window, ['attendance.read', 'attendance.manage'], ['present', 'present']))
    attendance.correct.mockResolvedValue(dayResponse(window, ['attendance.read', 'attendance.manage'], ['present', 'absent']))
    await renderDay(['attendance.read', 'attendance.manage'], ['admin'])

    expect(await screen.findByText('Aarav Sharma')).toBeInTheDocument()
    expect(screen.queryByText('Save attendance')).not.toBeInTheDocument()
    expect(screen.queryByText('Save corrections')).not.toBeInTheDocument()

    const row = screen.getByRole('group', { name: 'Mark for Diya Nair' })
    await userEvent.click(within(row).getByTitle('Absent'))
    await userEvent.click(screen.getByText('Save corrections'))
    await userEvent.type(await screen.findByLabelText('Reason'), 'Marked in the wrong class')
    await userEvent.click(screen.getAllByText('Save corrections').at(-1)!)

    await waitFor(() => expect(attendance.correct).toHaveBeenCalled())
    const body = attendance.correct.mock.calls[0]?.[3] as { marks: Array<{ studentId: string }>; reason: string }
    expect(body.marks).toEqual([{ studentId: 'student-2', mark: 'absent' }])
    expect(body.reason).toBe('Marked in the wrong class')
  })

  it('says why when neither marking nor correcting is open', async () => {
    attendance.day.mockResolvedValue(dayResponse(
      { record: false, recordBlockedBy: 'attendance_date_in_future', correct: false, correctBlockedBy: 'attendance_date_in_future' },
      ['attendance.read', 'attendance.record'],
    ))
    await renderDay(['attendance.read', 'attendance.record'], ['teacher'])

    expect(await screen.findByText('Aarav Sharma')).toBeInTheDocument()
    expect(screen.queryByText('Save attendance')).not.toBeInTheDocument()
    expect(screen.queryByText('Save corrections')).not.toBeInTheDocument()
    expect(screen.getByText('This day has not happened yet. The register opens on the day itself.')).toBeInTheDocument()
  })
})

describe("one pupil's month", () => {
  it('shows the percentage and a way to download the month', async () => {
    attendance.studentMonth.mockResolvedValue({
      student: PUPILS[0],
      academicYear: YEAR,
      month: '2026-09',
      section: SECTION,
      grade: GRADE,
      days: [
        { date: '2026-09-01', kind: 'school_day', future: false, enrolled: true, mark: 'present' },
        { date: '2026-09-02', kind: 'school_day', future: false, enrolled: true, mark: 'absent' },
      ],
      summary: { schoolDays: 20, present: 17, absent: 2, late: 1, leave: 0, halfDay: 0, unmarked: 0, percentage: 94.2 },
      allowedActions: ['attendance.read'],
    })
    search = { month: '2026-09' }
    const { Route } = await import('@/routes/_app/attendance/students/$studentId')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, { schoolId: SCHOOL_ID, capabilities: ['attendance.read'], roleKeys: ['parent'] })

    expect(await screen.findByText('94.2%')).toBeInTheDocument()
    expect(screen.getAllByText('Download PDF').length).toBeGreaterThan(0)
  })
})

describe('the staff register', () => {
  it('never sends the caller their own row', async () => {
    const staffDay = {
      date: DATE,
      day: { date: DATE, kind: 'school_day', future: false },
      window: { record: true, correct: false },
      marked: false,
      rows: [
        { staff: { id: 'staff-1', name: 'Asha Rao', employeeCode: 'E1' }, self: true },
        { staff: { id: 'staff-2', name: 'Vikram Iyer', employeeCode: 'E2' }, self: false },
      ],
      allowedActions: ['staff_attendance.read', 'staff_attendance.record'] as PermissionKey[],
    }
    attendance.staffDay.mockResolvedValue(staffDay)
    attendance.markStaff.mockResolvedValue(staffDay)
    search = {}
    const { Route } = await import('@/routes/_app/attendance/staff/index')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, {
      schoolId: SCHOOL_ID,
      capabilities: ['staff_attendance.read', 'staff_attendance.record'],
      roleKeys: ['admin'],
    })

    expect(await screen.findByText('Marked by a colleague')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Mark for Asha Rao' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('Save attendance'))

    await waitFor(() => expect(attendance.markStaff).toHaveBeenCalled())
    const body = attendance.markStaff.mock.calls[0]?.[2] as { marks: Array<{ staffId: string }> }
    expect(body.marks).toEqual([{ staffId: 'staff-2', mark: 'present' }])
  })
})
