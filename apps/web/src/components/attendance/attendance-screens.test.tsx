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
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/http'
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
    // A marked row carries its entry; the revisions differ so a test can tell which was sent back.
    rows: PUPILS.map((student, index) => ({
      student,
      ...(marks?.[index]
        ? { mark: marks[index], entry: { id: `entry-${index + 1}`, revision: index + 2, kind: 'marking', recordedAt: `${DATE}T09:00:00.000+05:30` } }
        : {}),
    })),
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
    // Nobody had a mark when the screen read the day, so each line expects revision 0.
    expect(body.marks).toEqual([
      { studentId: 'student-1', mark: 'present', expectedRevision: 0 },
      { studentId: 'student-2', mark: 'absent', expectedRevision: 0 },
    ])
  })

  it('on a save somebody else beat, says so and fetches the latest marks', async () => {
    const actions: PermissionKey[] = ['attendance.read', 'attendance.record']
    attendance.day.mockResolvedValue(dayResponse({ record: true, correct: false }, actions, ['present', 'present']))
    attendance.mark.mockRejectedValue(new ApiRequestError({ code: 'VERSION_CONFLICT', status: 409, message: 'Conflict.' }))
    await renderDay(actions, ['teacher'])

    expect(await screen.findByText('Aarav Sharma')).toBeInTheDocument()
    expect(attendance.day).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByText('Save attendance'))

    await waitFor(() => expect(attendance.mark).toHaveBeenCalled())
    const body = attendance.mark.mock.calls[0]?.[3] as { marks: Array<{ expectedRevision?: number }> }
    expect(body.marks.map((line) => line.expectedRevision)).toEqual([2, 3])
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Somebody else saved these marks first')))
    await waitFor(() => expect(attendance.day).toHaveBeenCalledTimes(2))
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
    expect(body.marks).toEqual([{ studentId: 'student-2', mark: 'absent', expectedRevision: 3 }])
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
    // Without the leave application keys there is no way to leave from here.
    expect(screen.queryByRole('link', { name: 'Leave' })).not.toBeInTheDocument()
  })

  it('offers a parent the way to their leave applications', async () => {
    attendance.studentMonth.mockResolvedValue({
      student: PUPILS[0],
      academicYear: YEAR,
      month: '2026-09',
      section: SECTION,
      grade: GRADE,
      days: [],
      summary: { schoolDays: 0, present: 0, absent: 0, late: 0, leave: 0, halfDay: 0, unmarked: 0, percentage: null },
      allowedActions: ['attendance.read'],
    })
    search = { month: '2026-09' }
    const { Route } = await import('@/routes/_app/attendance/students/$studentId')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, { schoolId: SCHOOL_ID, capabilities: ['attendance.read', 'leave_applications.read', 'leave_applications.apply'], roleKeys: ['parent'] })

    expect((await screen.findAllByRole('link', { name: 'Leave' })).length).toBeGreaterThan(0)
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
    expect(body.marks).toEqual([{ staffId: 'staff-2', mark: 'present', expectedRevision: 0 }])
  })

  it('sends the revision it read on a correction, and refetches when somebody saved first', async () => {
    const staffDay = {
      date: DATE,
      day: { date: DATE, kind: 'school_day', future: false },
      window: { record: false, recordBlockedBy: 'attendance_marking_window_closed', correct: true },
      marked: true,
      rows: [
        {
          staff: { id: 'staff-2', name: 'Vikram Iyer', employeeCode: 'E2' },
          mark: 'present',
          entry: { id: 'entry-9', revision: 4, kind: 'marking', recordedAt: `${DATE}T09:00:00.000+05:30` },
          self: false,
        },
      ],
      allowedActions: ['staff_attendance.read', 'staff_attendance.manage'] as PermissionKey[],
    }
    attendance.staffDay.mockResolvedValue(staffDay)
    attendance.correctStaff.mockRejectedValue(new ApiRequestError({ code: 'VERSION_CONFLICT', status: 409, message: 'Conflict.' }))
    const { Route } = await import('@/routes/_app/attendance/staff/index')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, {
      schoolId: SCHOOL_ID,
      capabilities: ['staff_attendance.read', 'staff_attendance.manage'],
      roleKeys: ['admin'],
    })

    const row = await screen.findByRole('group', { name: 'Mark for Vikram Iyer' })
    await userEvent.click(within(row).getByTitle('Late'))
    await userEvent.click(screen.getByText('Save corrections'))
    await userEvent.type(await screen.findByLabelText('Reason'), 'The bus was late')
    await userEvent.click(screen.getAllByText('Save corrections').at(-1)!)

    await waitFor(() => expect(attendance.correctStaff).toHaveBeenCalled())
    const body = attendance.correctStaff.mock.calls[0]?.[2] as { marks: unknown[] }
    expect(body.marks).toEqual([{ staffId: 'staff-2', mark: 'late', expectedRevision: 4 }])
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Somebody else saved these marks first')))
    await waitFor(() => expect(attendance.staffDay).toHaveBeenCalledTimes(2))
  })
})

describe('recorded leave on the registers', () => {
  it('starts an unmarked pupil with leave on record on "leave", tags the row, and sends it', async () => {
    const actions: PermissionKey[] = ['attendance.read', 'attendance.record']
    const response = dayResponse({ record: true, correct: false }, actions)
    response.rows = response.rows.map((row, index) => ({ ...row, onLeave: index === 1 }))
    attendance.day.mockResolvedValue(response)
    attendance.mark.mockResolvedValue(response)
    await renderDay(actions, ['teacher'])

    expect(await screen.findByText('On leave')).toBeInTheDocument()
    const onLeave = screen.getByRole('group', { name: 'Mark for Diya Nair' })
    expect(within(onLeave).getByTitle('Leave')).toHaveAttribute('aria-pressed', 'true')
    const other = screen.getByRole('group', { name: 'Mark for Aarav Sharma' })
    expect(within(other).getByTitle('Present')).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByText('Save attendance'))

    await waitFor(() => expect(attendance.mark).toHaveBeenCalled())
    const body = attendance.mark.mock.calls[0]?.[3] as { marks: Array<{ studentId: string; mark: string }> }
    expect(body.marks.map((line) => line.mark)).toEqual(['present', 'leave'])
  })

  it('keeps a saved mark over the leave on record', async () => {
    const actions: PermissionKey[] = ['attendance.read', 'attendance.record']
    const response = dayResponse({ record: true, correct: false }, actions, ['present', 'present'])
    response.rows = response.rows.map((row) => ({ ...row, onLeave: true }))
    attendance.day.mockResolvedValue(response)
    await renderDay(actions, ['teacher'])

    const row = await screen.findByRole('group', { name: 'Mark for Diya Nair' })
    expect(within(row).getByTitle('Present')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByText('On leave')).toHaveLength(2)
  })

  it('starts a staff member with leave on record on "leave"', async () => {
    const staffDay = {
      date: DATE,
      day: { date: DATE, kind: 'school_day', future: false },
      window: { record: true, correct: false },
      marked: false,
      rows: [
        { staff: { id: 'staff-2', name: 'Vikram Iyer', employeeCode: 'E2' }, self: false, onLeave: true },
        { staff: { id: 'staff-3', name: 'Meena Pillai', employeeCode: 'E3' }, self: false, onLeave: false },
      ],
      allowedActions: ['staff_attendance.read', 'staff_attendance.record'] as PermissionKey[],
    }
    attendance.staffDay.mockResolvedValue(staffDay)
    const { Route } = await import('@/routes/_app/attendance/staff/index')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, { schoolId: SCHOOL_ID, capabilities: ['staff_attendance.read', 'staff_attendance.record'], roleKeys: ['admin'] })

    const row = await screen.findByRole('group', { name: 'Mark for Vikram Iyer' })
    expect(within(row).getByTitle('Leave')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByText('On leave')).toHaveLength(1)
    // "Everyone present" still leaves the person on leave on leave.
    await userEvent.click(within(row).getByTitle('Absent'))
    await userEvent.click(screen.getByText('Everyone present'))
    expect(within(row).getByTitle('Leave')).toHaveAttribute('aria-pressed', 'true')
  })

  it("marks an unmarked day inside leave on a pupil's calendar, with a legend entry", async () => {
    attendance.studentMonth.mockResolvedValue({
      student: PUPILS[0],
      academicYear: YEAR,
      month: '2026-09',
      section: SECTION,
      grade: GRADE,
      days: [
        { date: '2026-09-01', kind: 'school_day', future: false, enrolled: true, mark: 'present' },
        { date: '2026-09-02', kind: 'school_day', future: false, enrolled: true, onLeave: true },
      ],
      summary: { schoolDays: 2, present: 1, absent: 0, late: 0, leave: 1, halfDay: 0, unmarked: 0, percentage: 100 },
      allowedActions: ['attendance.read'],
    })
    search = { month: '2026-09' }
    const { Route } = await import('@/routes/_app/attendance/students/$studentId')
    const Screen = componentOf(Route)
    const { container } = renderWithSession(<Screen />, { schoolId: SCHOOL_ID, capabilities: ['attendance.read'], roleKeys: ['admin'] })

    expect(await screen.findByText('On leave')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-on-leave]')).toHaveLength(1)
    expect(screen.getByText('leave recorded by the office')).toBeInTheDocument()
  })

  it('draws an unmarked day inside leave on a section\'s month grid as leave, and says so in the legend', async () => {
    const day = (date: string) => ({ date, kind: 'school_day', future: false, marked: true })
    attendance.sectionMonth.mockResolvedValue({
      section: SECTION,
      grade: GRADE,
      academicYear: YEAR,
      month: '2026-09',
      days: [day('2026-09-01'), day('2026-09-02')],
      rows: [
        {
          student: PUPILS[0],
          marks: [
            { date: '2026-09-01', enrolled: true, mark: 'present', onLeave: true },
            { date: '2026-09-02', enrolled: true, onLeave: true },
          ],
          summary: { schoolDays: 2, present: 1, absent: 0, late: 0, leave: 1, halfDay: 0, unmarked: 0, percentage: 100 },
        },
        {
          student: PUPILS[1],
          marks: [
            { date: '2026-09-01', enrolled: true, mark: 'absent' },
            { date: '2026-09-02', enrolled: true },
          ],
          summary: { schoolDays: 2, present: 0, absent: 1, late: 0, leave: 0, halfDay: 0, unmarked: 1, percentage: 0 },
        },
      ],
      allowedActions: ['attendance.read'],
    })
    search = { month: '2026-09' }
    const { Route } = await import('@/routes/_app/attendance/sections/$sectionId/month')
    const Screen = componentOf(Route)
    const { container } = renderWithSession(<Screen />, { schoolId: SCHOOL_ID, capabilities: ['attendance.read'], roleKeys: ['admin'] })

    expect(await screen.findByText('Aarav Sharma')).toBeInTheDocument()
    // The saved mark wins on the first day; only the unmarked second day is drawn as leave.
    const cells = container.querySelectorAll('[data-on-leave]')
    expect(cells).toHaveLength(1)
    expect(cells[0]).toHaveTextContent('LV')
    expect(cells[0]?.closest('tr')).toHaveTextContent('Aarav Sharma')
    expect(screen.getByText('leave recorded by the office')).toBeInTheDocument()
  })

  it('draws an unmarked day inside leave on the staff month grid as leave', async () => {
    attendance.staffMonth.mockResolvedValue({
      academicYear: YEAR,
      month: '2026-09',
      days: [{ date: '2026-09-02', kind: 'school_day', future: false, marked: false }],
      rows: [
        {
          staff: { id: 'staff-2', name: 'Vikram Iyer', employeeCode: 'E2' },
          marks: [{ date: '2026-09-02', onRegister: true, onLeave: true }],
          summary: { schoolDays: 1, present: 0, absent: 0, late: 0, leave: 1, halfDay: 0, unmarked: 0, percentage: null },
        },
        {
          staff: { id: 'staff-3', name: 'Meena Pillai', employeeCode: 'E3' },
          marks: [{ date: '2026-09-02', onRegister: true }],
          summary: { schoolDays: 1, present: 0, absent: 0, late: 0, leave: 0, halfDay: 0, unmarked: 1, percentage: 0 },
        },
      ],
      allowedActions: ['staff_attendance.read'],
    })
    search = { month: '2026-09' }
    const { Route } = await import('@/routes/_app/attendance/staff/month')
    const Screen = componentOf(Route)
    const { container } = renderWithSession(<Screen />, { schoolId: SCHOOL_ID, capabilities: ['staff_attendance.read'], roleKeys: ['admin'] })

    expect(await screen.findByText('Vikram Iyer')).toBeInTheDocument()
    const cells = container.querySelectorAll('[data-on-leave]')
    expect(cells).toHaveLength(1)
    expect(cells[0]?.closest('tr')).toHaveTextContent('Vikram Iyer')
    expect(screen.getByText('leave recorded by the office')).toBeInTheDocument()
  })
})
