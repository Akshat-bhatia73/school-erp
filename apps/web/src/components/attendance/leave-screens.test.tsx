/**
 * The leave screen on the real API.
 *
 * Each test fixes the capabilities and the `allowedActions` the server sent, and checks what the
 * screen draws from them and the body it sends: the list, the kinds a person may read, Record leave
 * and Cancel leave only where the key is held, the sheet's own date rules, and the refusal
 * sentences. The API module and the router are mocked, so nothing here touches the network.
 */
import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PermissionKey } from '@erp/contracts'
import { toast } from 'sonner'
import { todayIso } from '@/components/attendance/month-chip'
import { ApiRequestError } from '@/lib/http'
import { renderWithSession } from '@/test/session'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const navigate = vi.fn()
let search: Record<string, unknown> = {}

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    createFileRoute: () => (options: Record<string, unknown>) => ({
      ...options,
      useSearch: () => search,
      useParams: () => ({}),
      fullPath: '/attendance/leave/',
    }),
    useNavigate: () => navigate,
    Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  }
})

const leave = {
  listStudents: vi.fn(),
  createStudent: vi.fn(),
  cancelStudent: vi.fn(),
  listStaff: vi.fn(),
  createStaff: vi.fn(),
  cancelStaff: vi.fn(),
}
const students = { search: vi.fn() }
const staff = { search: vi.fn() }

vi.mock('@/lib/api', () => ({ api: { leave, students, staff } }))

const SCHOOL_ID = '10000000-0000-4000-8000-000000000001'
const STUDENT_ID = '20000000-0000-4000-8000-000000000001'
const STAFF_ID = '30000000-0000-4000-8000-000000000001'

function pupilLeave(patch: Record<string, unknown> = {}) {
  return {
    id: 'leave-1',
    version: 3,
    startsOn: '2026-09-28',
    endsOn: '2026-09-30',
    days: 3,
    reason: 'Family wedding',
    status: 'active',
    recordedAt: '2026-09-27T10:00:00.000+05:30',
    recordedBy: 'Office Clerk',
    allowedActions: ['attendance.read', 'attendance.manage'] as PermissionKey[],
    student: { id: STUDENT_ID, name: 'Aarav Sharma', admissionNumber: 'SVM/2026/101', rollNumber: 1 },
    section: { id: 'section-1', name: 'A' },
    grade: { id: 'grade-1', name: 'Class 6' },
    ...patch,
  }
}

function staffLeave(patch: Record<string, unknown> = {}) {
  return {
    id: 'leave-9',
    version: 1,
    startsOn: '2026-09-28',
    endsOn: '2026-09-28',
    days: 1,
    status: 'active',
    recordedAt: '2026-09-27T10:00:00.000+05:30',
    allowedActions: ['staff_attendance.read'] as PermissionKey[],
    staff: { id: STAFF_ID, name: 'Vikram Iyer', employeeCode: 'E2', designation: 'Maths teacher' },
    ...patch,
  }
}

function componentOf(route: unknown): () => ReactElement {
  return (route as { component: () => ReactElement }).component
}

async function renderLeave(capabilities: PermissionKey[], roleKeys: string[] = ['admin']) {
  const { Route } = await import('@/routes/_app/attendance/leave/index')
  const Screen = componentOf(Route)
  return renderWithSession(<Screen />, { schoolId: SCHOOL_ID, capabilities, roleKeys })
}

beforeEach(() => {
  vi.clearAllMocks()
  search = {}
  leave.listStudents.mockResolvedValue({ items: [pupilLeave()], allowedActions: ['attendance.read', 'attendance.manage'] })
  leave.listStaff.mockResolvedValue({ items: [staffLeave()], allowedActions: ['staff_attendance.read'] })
  students.search.mockResolvedValue([])
  staff.search.mockResolvedValue([])
})

describe('the leave list', () => {
  it('shows each record with its class, dates, reason, status and who recorded it', async () => {
    await renderLeave(['attendance.read', 'attendance.manage'])

    expect(await screen.findByText('Aarav Sharma')).toBeInTheDocument()
    expect(screen.getByText('Class 6 - A')).toBeInTheDocument()
    expect(screen.getByText('Family wedding')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByText('Office Clerk')).toBeInTheDocument()
    expect(screen.getByText('1 on leave in view')).toBeInTheDocument()
    // The name opens the pupil's month, where the leave shows on the calendar.
    expect(screen.getByText('Aarav Sharma').closest('a')).toHaveAttribute('href', `/attendance/students/${STUDENT_ID}`)
    // "Now and upcoming" is the server's own default, so no range is sent.
    expect(leave.listStudents).toHaveBeenCalledWith(SCHOOL_ID, {})
  })

  it('asks the server for today only, and for cancelled records when the toggle is on', async () => {
    search = { when: 'today', cancelled: true }
    await renderLeave(['attendance.read'])

    await waitFor(() => expect(leave.listStudents).toHaveBeenCalled())
    const today = todayIso()
    expect(leave.listStudents).toHaveBeenCalledWith(SCHOOL_ID, { from: today, to: today, includeCancelled: 'true' })
  })

  it('narrows the loaded list by name without asking the server again', async () => {
    leave.listStudents.mockResolvedValue({
      items: [pupilLeave(), pupilLeave({ id: 'leave-2', student: { id: 'student-2', name: 'Diya Nair', admissionNumber: 'SVM/2026/102' } })],
      allowedActions: ['attendance.read'],
    })
    await renderLeave(['attendance.read'])

    expect(await screen.findByText('2 on leave in view')).toBeInTheDocument()
    await userEvent.type(screen.getAllByLabelText('Search by name')[0]!, 'diya')
    expect(screen.getByText('1 on leave in view')).toBeInTheDocument()
    expect(screen.queryByText('Aarav Sharma')).not.toBeInTheDocument()
    expect(leave.listStudents).toHaveBeenCalledTimes(1)
  })

  it('offers only the kinds the person may read, and Record leave only with the manage key', async () => {
    search = { kind: 'staff' }
    await renderLeave(['attendance.read', 'attendance.manage', 'staff_attendance.read'])

    expect(await screen.findByText('Vikram Iyer')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Students' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Staff' })).toHaveAttribute('aria-selected', 'true')
    // Staff leave needs staff_attendance.manage, which this person does not hold.
    expect(screen.queryByText('Record leave')).not.toBeInTheDocument()
    expect(screen.queryByText('Cancel leave')).not.toBeInTheDocument()
    expect(leave.listStudents).not.toHaveBeenCalled()
  })

  it('shows no kind switch and no pupil read for somebody who holds only the staff keys', async () => {
    await renderLeave(['staff_attendance.read'], ['accountant'])

    expect(await screen.findByText('Vikram Iyer')).toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(leave.listStudents).not.toHaveBeenCalled()
  })

  it('offers Cancel leave only on an active record that allows it', async () => {
    leave.listStudents.mockResolvedValue({
      items: [
        pupilLeave(),
        pupilLeave({ id: 'leave-2', student: { id: 'student-2', name: 'Diya Nair', admissionNumber: 'SVM/2026/102' }, allowedActions: ['attendance.read'] }),
        pupilLeave({ id: 'leave-3', student: { id: 'student-3', name: 'Kabir Das', admissionNumber: 'SVM/2026/103' }, status: 'cancelled' }),
      ],
      allowedActions: ['attendance.read', 'attendance.manage'],
    })
    await renderLeave(['attendance.read', 'attendance.manage'])

    expect(await screen.findByText('Kabir Das')).toBeInTheDocument()
    expect(screen.getAllByText('Cancel leave')).toHaveLength(1)
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
  })

  it('says why when the list is refused', async () => {
    leave.listStudents.mockRejectedValue(new ApiRequestError({ code: 'ACCESS_DENIED', status: 403, message: 'No.' }))
    await renderLeave(['attendance.read'])

    expect(await screen.findByText('You do not have permission to do this.')).toBeInTheDocument()
  })
})

describe('recording leave', () => {
  async function openSheet() {
    await renderLeave(['attendance.read', 'attendance.manage'])
    await screen.findByText('Aarav Sharma')
    await userEvent.click(screen.getAllByText('Record leave')[0]!)
    return screen.findByRole('dialog')
  }

  async function pickPupil(sheet: HTMLElement) {
    students.search.mockResolvedValue([{
      id: STUDENT_ID,
      schoolId: SCHOOL_ID,
      version: 1,
      firstName: 'Diya',
      lastName: 'Nair',
      admissionNumber: 'SVM/2026/102',
      status: 'active',
      anonymised: false,
      hasPhoto: false,
      enrollment: { id: 'e1', academicYear: { id: 'y1', name: '2026-27' }, section: { id: 'section-1', name: 'B' }, grade: { id: 'grade-1', name: 'Class 7' }, outcome: 'ongoing' },
    }])
    await userEvent.type(within(sheet).getByLabelText('Search pupils'), 'Diya')
    await userEvent.click(await within(sheet).findByText('Diya Nair'))
  }

  it('asks for a pupil before anything is sent', async () => {
    const sheet = await openSheet()
    await userEvent.click(within(sheet).getByRole('button', { name: 'Record leave' }))

    expect(await within(sheet).findByText('Choose a pupil')).toBeInTheDocument()
    expect(leave.createStudent).not.toHaveBeenCalled()
  })

  it('shows the contract rule inline when the last day is before the first', async () => {
    const sheet = await openSheet()
    await pickPupil(sheet)
    const from = within(sheet).getByLabelText('From')
    const to = within(sheet).getByLabelText('To')
    await userEvent.clear(from)
    await userEvent.type(from, '2026-10-05')
    await userEvent.clear(to)
    await userEvent.type(to, '2026-10-02')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Record leave' }))

    expect(await within(sheet).findByText('The last day of leave is before the first')).toBeInTheDocument()
    expect(leave.createStudent).not.toHaveBeenCalled()
  })

  it('sends the pupil, the dates and the reason, then says so', async () => {
    leave.createStudent.mockResolvedValue(pupilLeave())
    const sheet = await openSheet()
    await pickPupil(sheet)
    const from = within(sheet).getByLabelText('From')
    const to = within(sheet).getByLabelText('To')
    await userEvent.clear(from)
    await userEvent.type(from, '2026-10-05')
    await userEvent.clear(to)
    await userEvent.type(to, '2026-10-07')
    await userEvent.type(within(sheet).getByLabelText('Reason'), 'Fever')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Record leave' }))

    await waitFor(() => expect(leave.createStudent).toHaveBeenCalled())
    expect(leave.createStudent).toHaveBeenCalledWith(SCHOOL_ID, { studentId: STUDENT_ID, startsOn: '2026-10-05', endsOn: '2026-10-07', reason: 'Fever' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Leave recorded'))
    // The list is read again, because the new record belongs in it.
    await waitFor(() => expect(leave.listStudents).toHaveBeenCalledTimes(2))
  })

  it('says in plain words when the leave overlaps leave already on record', async () => {
    leave.createStudent.mockRejectedValue(new ApiRequestError({ code: 'VERSION_CONFLICT', status: 409, message: 'leave_overlaps', reason: 'leave_overlaps' }))
    const sheet = await openSheet()
    await pickPupil(sheet)
    await userEvent.click(within(sheet).getByRole('button', { name: 'Record leave' }))

    const sentence = 'This person already has leave on some of these days.'
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(sentence))
    expect(within(sheet).getByText(sentence)).toBeInTheDocument()
  })
})

describe('cancelling leave', () => {
  it('sends the version the row carried and the optional reason', async () => {
    leave.cancelStudent.mockResolvedValue(pupilLeave({ status: 'cancelled', version: 4 }))
    await renderLeave(['attendance.read', 'attendance.manage'])

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel leave' }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.type(within(dialog).getByLabelText('Reason (optional)'), 'Came back early')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel leave' }))

    await waitFor(() => expect(leave.cancelStudent).toHaveBeenCalled())
    expect(leave.cancelStudent).toHaveBeenCalledWith(SCHOOL_ID, 'leave-1', { expectedVersion: 3, reason: 'Came back early' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Leave cancelled'))
  })

  it('leaves the reason out when none is given, and names an already cancelled record', async () => {
    leave.cancelStudent.mockRejectedValue(new ApiRequestError({ code: 'VERSION_CONFLICT', status: 409, message: 'x', reason: 'leave_already_cancelled' }))
    await renderLeave(['attendance.read', 'attendance.manage'])

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel leave' }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel leave' }))

    await waitFor(() => expect(leave.cancelStudent).toHaveBeenCalledWith(SCHOOL_ID, 'leave-1', { expectedVersion: 3 }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This leave was already cancelled.'))
  })
})
