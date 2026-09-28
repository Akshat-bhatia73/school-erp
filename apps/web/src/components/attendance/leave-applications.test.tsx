/**
 * Leave applications on the leave screen, on a mocked API.
 *
 * Each test fixes the capabilities, the roles and the `allowedActions` the server sent, and checks
 * what the screen draws from them and the body it sends: the Requests view and its badge, Approve
 * and Not approved only where the item allows a decision, the required note, Withdraw on one's own
 * waiting application, and the apply sheet for a parent and for a staff member.
 */
import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PermissionKey } from '@erp/contracts'
import { toast } from 'sonner'
import { shiftDate, todayIso } from '@/components/attendance/month-chip'
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

const pupils = { list: vi.fn(), apply: vi.fn(), decide: vi.fn(), withdraw: vi.fn() }
const staffApplications = { list: vi.fn(), apply: vi.fn(), decide: vi.fn(), withdraw: vi.fn() }
const leave = {
  listStudents: vi.fn(),
  createStudent: vi.fn(),
  cancelStudent: vi.fn(),
  listStaff: vi.fn(),
  createStaff: vi.fn(),
  cancelStaff: vi.fn(),
  applications: { pupils, staff: staffApplications },
}
const students = { list: vi.fn(), search: vi.fn() }
const staff = { search: vi.fn() }

vi.mock('@/lib/api', () => ({ api: { leave, students, staff } }))

const SCHOOL_ID = '10000000-0000-4000-8000-000000000001'
const CHILD_ID = '20000000-0000-4000-8000-000000000001'
const OTHER_CHILD_ID = '20000000-0000-4000-8000-000000000002'
const STAFF_ID = '30000000-0000-4000-8000-000000000001'

const OFFICE: PermissionKey[] = [
  'attendance.read', 'staff_attendance.read',
  'leave_applications.read', 'leave_applications.decide', 'leave_applications.apply',
]
const TEACHER: PermissionKey[] = [
  'attendance.read', 'leave_applications.read', 'leave_applications.decide', 'leave_applications.apply',
]
const PARENT: PermissionKey[] = ['attendance.read', 'leave_applications.read', 'leave_applications.apply']

function pupilApplication(patch: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    version: 2,
    startsOn: '2026-10-05',
    endsOn: '2026-10-06',
    days: 2,
    reason: 'Family wedding',
    status: 'pending',
    appliedAt: '2026-09-28T09:00:00.000+05:30',
    appliedBy: 'Meera Sharma',
    mine: false,
    allowedActions: ['leave_applications.read', 'leave_applications.decide'] as PermissionKey[],
    student: { id: CHILD_ID, name: 'Aarav Sharma', admissionNumber: 'SVM/2026/101', rollNumber: 1 },
    section: { id: 'section-1', name: 'A' },
    grade: { id: 'grade-1', name: 'Class 6' },
    ...patch,
  }
}

function staffApplication(patch: Record<string, unknown> = {}) {
  return {
    id: 'app-9',
    version: 1,
    startsOn: '2026-10-07',
    endsOn: '2026-10-07',
    days: 1,
    reason: 'Doctor',
    status: 'pending',
    appliedAt: '2026-09-27T09:00:00.000+05:30',
    appliedBy: 'Vikram Iyer',
    mine: false,
    leaveType: 'sick',
    allowedActions: ['leave_applications.read', 'leave_applications.decide'] as PermissionKey[],
    staff: { id: STAFF_ID, name: 'Vikram Iyer', employeeCode: 'E2', designation: 'Maths teacher' },
    ...patch,
  }
}

function child(id: string, firstName: string) {
  return {
    id,
    schoolId: SCHOOL_ID,
    version: 1,
    firstName,
    lastName: 'Sharma',
    admissionNumber: `SVM/${firstName}`,
    status: 'active',
    anonymised: false,
    hasPhoto: false,
  }
}

function componentOf(route: unknown): () => ReactElement {
  return (route as { component: () => ReactElement }).component
}

async function renderLeave(capabilities: PermissionKey[], roleKeys: string[]) {
  const { Route } = await import('@/routes/_app/attendance/leave/index')
  const Screen = componentOf(Route)
  return renderWithSession(<Screen />, { schoolId: SCHOOL_ID, capabilities, roleKeys })
}

async function setDates(sheet: HTMLElement, from: string, to: string) {
  const fromInput = within(sheet).getByLabelText('From')
  const toInput = within(sheet).getByLabelText('To')
  await userEvent.clear(fromInput)
  await userEvent.type(fromInput, from)
  await userEvent.clear(toInput)
  await userEvent.type(toInput, to)
}

beforeEach(() => {
  vi.clearAllMocks()
  search = {}
  pupils.list.mockResolvedValue({ items: [pupilApplication()], allowedActions: ['leave_applications.read'] })
  staffApplications.list.mockResolvedValue({ items: [staffApplication()], allowedActions: ['leave_applications.read'] })
  leave.listStudents.mockResolvedValue({ items: [], allowedActions: ['attendance.read'] })
  leave.listStaff.mockResolvedValue({ items: [], allowedActions: ['staff_attendance.read'] })
  students.list.mockResolvedValue({ items: [child(CHILD_ID, 'Aarav')], total: 1, page: 1, pageSize: 50 })
})

describe('the Requests view', () => {
  it('opens first for somebody who decides, with a badge for the waiting ones and both kinds of request', async () => {
    await renderLeave(OFFICE, ['admin'])

    expect(await screen.findByText('Aarav Sharma')).toBeInTheDocument()
    expect(await screen.findByText('Vikram Iyer')).toBeInTheDocument()
    const tab = screen.getByRole('tab', { name: /Requests/ })
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(within(tab).getByLabelText('2 waiting')).toBeInTheDocument()
    // Who, class or role, dates, type, reason, who applied.
    expect(screen.getByText('Class 6 - A')).toBeInTheDocument()
    expect(screen.getByText('Maths teacher')).toBeInTheDocument()
    expect(screen.getByText('Sick leave')).toBeInTheDocument()
    expect(screen.getByText('Pupil leave')).toBeInTheDocument()
    expect(screen.getByText('Family wedding')).toBeInTheDocument()
    expect(screen.getByText(/Meera Sharma,/)).toBeInTheDocument()
    expect(screen.getAllByText('Waiting')).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Not approved' })).toHaveLength(2)
    expect(screen.getByText('2 requests in view')).toBeInTheDocument()
    // The record views stay next to it.
    expect(screen.getByRole('tab', { name: 'Students' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Staff' })).toBeInTheDocument()
  })

  it('offers a decision only where the item allows one, and keeps decided requests in view', async () => {
    pupils.list.mockResolvedValue({
      items: [
        pupilApplication({ allowedActions: ['leave_applications.read'] }),
        pupilApplication({
          id: 'app-2', status: 'refused', decidedBy: 'Office Clerk', decidedAt: '2026-09-28T10:00:00.000+05:30', decisionNote: 'Exams that week',
          student: { id: OTHER_CHILD_ID, name: 'Diya Nair', admissionNumber: 'SVM/2026/102' },
        }),
      ],
      allowedActions: ['leave_applications.read'],
    })
    staffApplications.list.mockResolvedValue({ items: [], allowedActions: ['leave_applications.read'] })
    await renderLeave(OFFICE, ['admin'])

    expect(await screen.findByText('Diya Nair')).toBeInTheDocument()
    expect(screen.getByText('Not approved')).toBeInTheDocument()
    expect(screen.getByText('Exams that week')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Not approved' })).not.toBeInTheDocument()
    // Nothing this person may decide is waiting, so no badge.
    expect(screen.queryByLabelText(/waiting/)).not.toBeInTheDocument()
  })

  it('narrows to one status from the filter', async () => {
    search = { status: 'refused' }
    pupils.list.mockResolvedValue({
      items: [pupilApplication(), pupilApplication({ id: 'app-2', status: 'refused', student: { id: OTHER_CHILD_ID, name: 'Diya Nair', admissionNumber: 'SVM/2026/102' } })],
      allowedActions: ['leave_applications.read'],
    })
    staffApplications.list.mockResolvedValue({ items: [], allowedActions: ['leave_applications.read'] })
    await renderLeave(OFFICE, ['admin'])

    expect(await screen.findByText('Diya Nair')).toBeInTheDocument()
    expect(screen.queryByText('Aarav Sharma')).not.toBeInTheDocument()
    expect(screen.getByText('1 request in view')).toBeInTheDocument()
  })

  it('is not there for somebody who cannot decide', async () => {
    pupils.list.mockResolvedValue({ items: [pupilApplication({ mine: true, allowedActions: ['leave_applications.read'] })], allowedActions: ['leave_applications.read'] })
    await renderLeave(PARENT, ['parent'])

    await screen.findByText('Aarav Sharma')
    expect(screen.queryByRole('tab', { name: /Requests/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(staffApplications.list).not.toHaveBeenCalled()
  })

  it('opens the Requests view from a link that names it', async () => {
    search = { view: 'staff' }
    await renderLeave(OFFICE, ['admin'])
    expect(await screen.findByRole('tab', { name: 'Staff' })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('deciding', () => {
  it('approves with the version the row carried and an optional note', async () => {
    pupils.decide.mockResolvedValue(pupilApplication({ status: 'approved', version: 3 }))
    staffApplications.list.mockResolvedValue({ items: [], allowedActions: ['leave_applications.read'] })
    await renderLeave(OFFICE, ['admin'])

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve leave' }))

    await waitFor(() => expect(pupils.decide).toHaveBeenCalledWith(SCHOOL_ID, 'app-1', { expectedVersion: 2, decision: 'approve' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Leave approved'))
    // The list is read again: the request is no longer waiting.
    await waitFor(() => expect(pupils.list).toHaveBeenCalledTimes(2))
  })

  it('will not refuse without a note, then sends it', async () => {
    staffApplications.decide.mockResolvedValue(staffApplication({ status: 'refused' }))
    pupils.list.mockResolvedValue({ items: [], allowedActions: ['leave_applications.read'] })
    await renderLeave(OFFICE, ['admin'])

    await userEvent.click(await screen.findByRole('button', { name: 'Not approved' }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save as not approved' }))
    expect(await within(dialog).findByText('Say why the leave is not approved')).toBeInTheDocument()
    expect(staffApplications.decide).not.toHaveBeenCalled()

    await userEvent.type(within(dialog).getByLabelText('Note'), 'Inspection that day')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save as not approved' }))
    await waitFor(() => expect(staffApplications.decide).toHaveBeenCalledWith(SCHOOL_ID, 'app-9', { expectedVersion: 1, decision: 'refuse', note: 'Inspection that day' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Leave not approved'))
  })

  it('says so when somebody else decided first', async () => {
    pupils.decide.mockRejectedValue(new ApiRequestError({ code: 'VERSION_CONFLICT', status: 409, message: 'x', reason: 'leave_application_not_pending' }))
    staffApplications.list.mockResolvedValue({ items: [], allowedActions: ['leave_applications.read'] })
    await renderLeave(OFFICE, ['admin'])

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve leave' }))

    const sentence = 'Somebody has already decided this request, or it was withdrawn.'
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(sentence))
    expect(within(dialog).getByText(sentence)).toBeInTheDocument()
  })
})

describe('a teacher: My leave next to the class requests', () => {
  it('shows their own applications with Withdraw on a waiting one, and sends the version', async () => {
    search = { view: 'mine' }
    staffApplications.list.mockResolvedValue({
      items: [
        staffApplication({ id: 'mine-1', mine: true, allowedActions: ['leave_applications.read', 'leave_applications.apply'] }),
        staffApplication({ id: 'mine-2', mine: true, status: 'approved', startsOn: '2026-09-01', endsOn: '2026-09-02', days: 2, allowedActions: ['leave_applications.read'] }),
      ],
      allowedActions: ['leave_applications.read', 'leave_applications.apply'],
    })
    staffApplications.withdraw.mockResolvedValue(staffApplication({ id: 'mine-1', mine: true, status: 'withdrawn' }))
    await renderLeave(TEACHER, ['teacher'])

    expect(await screen.findByText('Approved')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'My leave' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /Requests/ })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Apply for leave/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Withdraw' })).toHaveLength(1)

    await userEvent.click(screen.getByRole('button', { name: 'Withdraw' }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }))
    await waitFor(() => expect(staffApplications.withdraw).toHaveBeenCalledWith(SCHOOL_ID, 'mine-1', { expectedVersion: 1 }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Application withdrawn'))
  })

  it('keeps their own applications out of Requests', async () => {
    staffApplications.list.mockResolvedValue({
      items: [staffApplication({ mine: true, allowedActions: ['leave_applications.read', 'leave_applications.apply'] })],
      allowedActions: ['leave_applications.read', 'leave_applications.apply'],
    })
    await renderLeave(TEACHER, ['teacher'])

    expect(await screen.findByText('Aarav Sharma')).toBeInTheDocument()
    expect(screen.queryByText('Vikram Iyer')).not.toBeInTheDocument()
    expect(screen.getByText('1 request in view')).toBeInTheDocument()
  })

  it('has no My leave for an office login without a staff record', async () => {
    staffApplications.list.mockResolvedValue({ items: [staffApplication()], allowedActions: ['leave_applications.read'] })
    await renderLeave(OFFICE, ['admin'])

    await screen.findByText('Vikram Iyer')
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'My leave' })).not.toBeInTheDocument())
  })
})

describe('a parent', () => {
  it('sees their applications with the status in words and the note, and Withdraw on a waiting one', async () => {
    pupils.list.mockResolvedValue({
      items: [
        pupilApplication({ mine: true, allowedActions: ['leave_applications.read', 'leave_applications.apply'] }),
        pupilApplication({ id: 'app-2', status: 'refused', mine: true, decisionNote: 'Exams that week', allowedActions: ['leave_applications.read'] }),
        pupilApplication({ id: 'app-3', status: 'withdrawn', mine: true, allowedActions: ['leave_applications.read'] }),
      ],
      allowedActions: ['leave_applications.read', 'leave_applications.apply'],
    })
    await renderLeave(PARENT, ['parent'])

    expect(await screen.findByText('Waiting')).toBeInTheDocument()
    expect(screen.getByText('Not approved')).toBeInTheDocument()
    expect(screen.getByText('Withdrawn')).toBeInTheDocument()
    expect(screen.getByText('Exams that week')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Withdraw' })).toHaveLength(1)
    expect(screen.getByRole('tab', { name: 'Applications' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('3 applications in view')).toBeInTheDocument()
  })

  it('has no Apply button when the list does not offer it', async () => {
    await renderLeave(PARENT, ['parent'])
    await screen.findByText('Aarav Sharma')
    expect(screen.queryByRole('button', { name: /Apply for leave/ })).not.toBeInTheDocument()
  })
})

describe('applying for a child', () => {
  async function openSheet() {
    pupils.list.mockResolvedValue({ items: [], allowedActions: ['leave_applications.read', 'leave_applications.apply'] })
    await renderLeave(PARENT, ['parent'])
    await userEvent.click((await screen.findAllByRole('button', { name: /Apply for leave/ }))[0]!)
    return screen.findByRole('dialog')
  }

  it('needs no picker for one child, shows the 7-day rule and asks for a reason', async () => {
    const sheet = await openSheet()
    expect(await within(sheet).findByText('Aarav Sharma')).toBeInTheDocument()
    expect(within(sheet).queryByRole('radiogroup', { name: 'Child' })).not.toBeInTheDocument()
    expect(within(sheet).getByText('Leave can start up to 7 days ago. For older days, ask the office.')).toBeInTheDocument()
    expect(within(sheet).getByLabelText('From')).toHaveValue(todayIso())
    expect(within(sheet).getByLabelText('To')).toHaveValue(todayIso())

    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply for leave' }))
    expect(await within(sheet).findByText('Enter the reason')).toBeInTheDocument()
    expect(pupils.apply).not.toHaveBeenCalled()
  })

  it('sends the child, the dates and the reason, then says so', async () => {
    pupils.apply.mockResolvedValue(pupilApplication({ mine: true }))
    const sheet = await openSheet()
    await within(sheet).findByText('Aarav Sharma')
    const from = shiftDate(todayIso(), 1)
    const to = shiftDate(todayIso(), 2)
    await setDates(sheet, from, to)
    await userEvent.type(within(sheet).getByLabelText('Reason'), 'Fever')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply for leave' }))

    await waitFor(() => expect(pupils.apply).toHaveBeenCalledWith(SCHOOL_ID, { studentId: CHILD_ID, startsOn: from, endsOn: to, reason: 'Fever' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Leave applied for'))
  })

  it('asks which child when there are two', async () => {
    students.list.mockResolvedValue({ items: [child(CHILD_ID, 'Aarav'), child(OTHER_CHILD_ID, 'Anaya')], total: 2, page: 1, pageSize: 50 })
    pupils.apply.mockResolvedValue(pupilApplication({ mine: true }))
    const sheet = await openSheet()
    const picker = await within(sheet).findByRole('radiogroup', { name: 'Child' })
    await userEvent.type(within(sheet).getByLabelText('Reason'), 'Fever')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply for leave' }))
    expect(await within(sheet).findByText('Choose a child')).toBeInTheDocument()

    await userEvent.click(within(picker).getByRole('radio', { name: 'Anaya Sharma' }))
    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply for leave' }))
    await waitFor(() => expect(pupils.apply).toHaveBeenCalledWith(SCHOOL_ID, expect.objectContaining({ studentId: OTHER_CHILD_ID })))
  })

  it('shows the 7-day rule inline for a first day too far back, and the contract rule for reversed dates', async () => {
    const sheet = await openSheet()
    await within(sheet).findByText('Aarav Sharma')
    await userEvent.type(within(sheet).getByLabelText('Reason'), 'Fever')
    await setDates(sheet, shiftDate(todayIso(), -8), todayIso())
    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply for leave' }))
    expect(await within(sheet).findByText('Leave can start at most 7 days ago. Ask the office to correct older days.')).toBeInTheDocument()

    await setDates(sheet, shiftDate(todayIso(), 3), shiftDate(todayIso(), 1))
    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply for leave' }))
    expect(await within(sheet).findByText('The last day of leave is before the first')).toBeInTheDocument()
    expect(pupils.apply).not.toHaveBeenCalled()
  })

  it('puts the server refusal in plain words', async () => {
    pupils.apply.mockRejectedValue(new ApiRequestError({ code: 'VERSION_CONFLICT', status: 409, message: 'x', reason: 'leave_overlaps' }))
    const sheet = await openSheet()
    await within(sheet).findByText('Aarav Sharma')
    await userEvent.type(within(sheet).getByLabelText('Reason'), 'Fever')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply for leave' }))

    const sentence = 'This person already has leave on some of these days.'
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(sentence))
    expect(within(sheet).getByText(sentence)).toBeInTheDocument()
  })
})

describe('applying for oneself', () => {
  async function openSheet() {
    search = { view: 'mine' }
    staffApplications.list.mockResolvedValue({ items: [], allowedActions: ['leave_applications.read', 'leave_applications.apply'] })
    await renderLeave(TEACHER, ['teacher'])
    await userEvent.click((await screen.findAllByRole('button', { name: /Apply for leave/ }))[0]!)
    return screen.findByRole('dialog')
  }

  it('asks for the type of leave, then sends it with the dates and reason', async () => {
    staffApplications.apply.mockResolvedValue(staffApplication({ mine: true }))
    const sheet = await openSheet()
    await userEvent.type(within(sheet).getByLabelText('Reason'), 'Fever')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply for leave' }))
    expect(await within(sheet).findByText('Choose a type of leave')).toBeInTheDocument()
    expect(staffApplications.apply).not.toHaveBeenCalled()

    await userEvent.click(within(sheet).getByRole('radio', { name: 'Sick leave' }))
    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply for leave' }))
    await waitFor(() => expect(staffApplications.apply).toHaveBeenCalledWith(SCHOOL_ID, { leaveType: 'sick', startsOn: todayIso(), endsOn: todayIso(), reason: 'Fever' }))
    expect(pupils.apply).not.toHaveBeenCalled()
  })

  it('names a missing staff record in plain words', async () => {
    staffApplications.apply.mockRejectedValue(new ApiRequestError({ code: 'INVALID_REQUEST', status: 400, message: 'x', reason: 'leave_application_no_staff_record' }))
    const sheet = await openSheet()
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Casual leave' }))
    await userEvent.type(within(sheet).getByLabelText('Reason'), 'Wedding')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply for leave' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Your login is not linked to a staff record. Ask the office.'))
  })

  it('puts the server day-limit refusal under From', async () => {
    staffApplications.apply.mockRejectedValue(new ApiRequestError({ code: 'INVALID_REQUEST', status: 400, message: 'x', reason: 'leave_application_too_far_back' }))
    const sheet = await openSheet()
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Other' }))
    await userEvent.type(within(sheet).getByLabelText('Reason'), 'Moving house')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Apply for leave' }))

    expect(await within(sheet).findByText('Leave can start at most 7 days ago. Ask the office to correct older days.')).toBeInTheDocument()
  })
})
