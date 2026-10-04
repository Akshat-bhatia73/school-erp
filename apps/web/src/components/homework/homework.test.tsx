/**
 * The homework screens on a mocked API.
 *
 * Each test fixes the capabilities, the roles and the `allowedActions` the server sent, and checks
 * what the screen draws from them and the body it sends: the staff list and its footer, the set
 * sheet's inline checks, the detail page with Edit and Remove only where the item allows them,
 * the check-off sheet's changed lines, a family's view of their own child, the report and the
 * pupil's "Homework due" card.
 */
import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PermissionKey, StudentDashboard as StudentDashboardData } from '@erp/contracts'
import { todayIso } from '@/components/attendance/month-chip'
import { renderWithSession } from '@/test/session'
import { addDays } from './labels'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const navigate = vi.fn()
let search: Record<string, unknown> = {}
let params: Record<string, string> = {}

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    createFileRoute: () => (options: Record<string, unknown>) => ({
      ...options,
      useSearch: () => search,
      useParams: () => params,
      fullPath: '/homework/',
    }),
    useNavigate: () => navigate,
    Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  }
})

const homework = {
  list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(),
  addAttachment: vi.fn(), removeAttachment: vi.fn(), downloadAttachment: vi.fn(),
  checks: vi.fn(), saveChecks: vi.fn(), report: vi.fn(), export: vi.fn(),
}
const setup = { sections: vi.fn(), grades: vi.fn(), subjects: vi.fn(), gradeSubjects: vi.fn(), currentAcademicYear: vi.fn(), academicYears: vi.fn() }
const students = { list: vi.fn() }
const files = { exportJob: vi.fn(), downloadExportFile: vi.fn() }

vi.mock('@/lib/api', () => ({ api: { homework, setup, students, files } }))

// Radix Select measures and captures the pointer; jsdom has neither.
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.scrollIntoView ??= () => {}

const SCHOOL_ID = '10000000-0000-4000-8000-000000000001'
const YEAR = { id: 'year-1', name: '2026-27' }
const SECTION = { id: 'sec-1', name: 'A' }
const GRADE = { id: 'g6', name: 'Class 6' }
const MATHS = { id: 'sub-1', name: 'Mathematics' }
const CHILD_ID = '20000000-0000-4000-8000-000000000001'
const TODAY = todayIso()

const TEACHER: PermissionKey[] = ['homework.read', 'homework.set', 'homework.check', 'sections.read', 'grades.read', 'subjects.read', 'holidays.read']
const PARENT: PermissionKey[] = ['homework.read', 'students.read_basic']

function item(patch: Record<string, unknown> = {}) {
  return {
    id: 'hw-1',
    version: 2,
    academicYear: YEAR,
    section: SECTION,
    grade: GRADE,
    subject: MATHS,
    title: 'Exercise 4.2',
    setOn: TODAY,
    dueOn: addDays(TODAY, 1),
    setBy: 'Meena Iyer',
    attachmentCount: 1,
    allowedActions: ['homework.read', 'homework.set', 'homework.check'] as PermissionKey[],
    ...patch,
  }
}

function detail(patch: Record<string, unknown> = {}) {
  return {
    ...item(),
    instructions: 'Questions 1 to 10.',
    attachments: [{ id: 'att-1', fileName: 'sheet.pdf', contentType: 'application/pdf', sizeBytes: 20480 }],
    updatedAt: '2026-10-04T09:00:00.000+05:30',
    ...patch,
  }
}

function pupil(id: string, name: string, roll: number) {
  return { id, name, admissionNumber: `SVM/${roll}`, rollNumber: roll }
}

function sheet(patch: Record<string, unknown> = {}) {
  return {
    homework: item({ dueOn: TODAY }),
    window: { state: 'open', teacherClosesOn: addDays(TODAY, 14), check: true },
    rows: [
      { student: pupil('p-1', 'Aarav Sharma', 1) },
      { student: pupil('p-2', 'Diya Patel', 2), check: { id: 'c-2', version: 3, status: 'not_done', remark: 'Left at home', checkedAt: '2026-10-04T09:00:00.000+05:30' } },
      { student: pupil('p-3', 'Kabir Singh', 3) },
    ],
    ...patch,
  }
}

function componentOf(route: unknown): () => ReactElement {
  return (route as { component: () => ReactElement }).component
}

async function renderList(capabilities: PermissionKey[], roleKeys: string[], overrides = {}) {
  const { Route } = await import('@/routes/_app/homework/index')
  const Screen = componentOf(Route)
  return renderWithSession(<Screen />, { schoolId: SCHOOL_ID, capabilities, roleKeys, overrides })
}

async function renderDetail(capabilities: PermissionKey[], roleKeys: string[]) {
  params = { homeworkId: 'hw-1' }
  const { Route } = await import('@/routes/_app/homework/$homeworkId')
  const Screen = componentOf(Route)
  return renderWithSession(<Screen />, { schoolId: SCHOOL_ID, capabilities, roleKeys })
}

beforeEach(() => {
  vi.clearAllMocks()
  search = {}
  params = {}
  setup.currentAcademicYear.mockResolvedValue({ id: 'year-1', schoolId: SCHOOL_ID, name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', status: 'current', version: 1 })
  setup.academicYears.mockResolvedValue([])
  setup.sections.mockResolvedValue([{ id: 'sec-1', schoolId: SCHOOL_ID, gradeId: 'g6', academicYearId: 'year-1', name: 'A', version: 1, allowedActions: [] }])
  setup.grades.mockResolvedValue([{ id: 'g6', schoolId: SCHOOL_ID, name: 'Class 6', order: 6, version: 1, allowedActions: [] }])
  setup.subjects.mockResolvedValue([{ id: 'sub-1', schoolId: SCHOOL_ID, name: 'Mathematics', code: 'MATH', type: 'scholastic', version: 1, allowedActions: [] }])
  setup.gradeSubjects.mockResolvedValue([{ gradeId: 'g6', academicYearId: 'year-1', subject: MATHS }])
  homework.list.mockResolvedValue({ today: TODAY, items: [item(), item({ id: 'hw-2', subject: undefined, title: 'Cover your books', attachmentCount: 0 })], truncated: false, allowedActions: ['homework.set'] })
  homework.get.mockResolvedValue(detail({ progress: { pupils: 3, done: 0, partlyDone: 0, notDone: 1, notChecked: 2 }, checkWindow: { state: 'open', teacherClosesOn: addDays(TODAY, 14), check: true } }))
  homework.checks.mockResolvedValue(sheet())
  homework.saveChecks.mockResolvedValue(sheet())
  homework.create.mockResolvedValue(detail({ id: 'hw-new', attachments: [] }))
})

describe('the staff list', () => {
  it('lists the items with their class, subject and who set them, and counts them in the footer', async () => {
    await renderList(TEACHER, ['teacher'])

    expect(await screen.findByText('Exercise 4.2')).toBeInTheDocument()
    expect(screen.getByText('Cover your books')).toBeInTheDocument()
    expect(screen.getAllByText('Class 6 A').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Meena Iyer').length).toBe(2)
    expect(screen.getByText('2 homework items in view')).toBeInTheDocument()
    // Upcoming by default, in the current year.
    await waitFor(() => expect(homework.list).toHaveBeenCalledWith(SCHOOL_ID, expect.objectContaining({ status: 'upcoming', academicYearId: 'year-1' })))
  })

  it('asks the server for general homework when the subject chip says General', async () => {
    search = { subjectId: 'general', status: 'to_check' }
    await renderList(TEACHER, ['teacher'])
    await waitFor(() => expect(homework.list).toHaveBeenCalledWith(SCHOOL_ID, expect.objectContaining({ general: 'true', status: 'to_check' })))
    expect(homework.list.mock.calls.at(-1)![1]).not.toHaveProperty('subjectId', 'general')
  })

  it('lists the chosen year\'s classes in the Class chip, and a new year clears the class', async () => {
    setup.academicYears.mockResolvedValue([
      { id: 'year-0', schoolId: SCHOOL_ID, name: '2025-26', startDate: '2025-04-01', endDate: '2026-03-31', status: 'closed', version: 1 },
      { id: 'year-1', schoolId: SCHOOL_ID, name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', status: 'current', version: 1 },
    ])
    search = { academicYearId: 'year-0', sectionId: 'old-sec' }
    await renderList([...TEACHER, 'academic_years.read'], ['admin'])
    await waitFor(() => expect(setup.sections).toHaveBeenCalledWith(SCHOOL_ID, { academicYearId: 'year-0' }))
    expect(setup.sections).not.toHaveBeenCalledWith(SCHOOL_ID, { academicYearId: 'year-1' })

    await userEvent.click(await screen.findByRole('button', { name: /Year/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '2026-27' }))
    const update = navigate.mock.calls.at(-1)![0] as { search: (prev: Record<string, unknown>) => Record<string, unknown> }
    expect(update.search(search)).toEqual({ academicYearId: 'year-1', sectionId: undefined })
  })

  it('offers Set homework only to somebody who holds homework.set', async () => {
    const { unmount } = await renderList(TEACHER, ['teacher'])
    expect((await screen.findAllByRole('button', { name: 'Set homework' })).length).toBeGreaterThan(0)
    unmount()
    await renderList(['homework.read', 'holidays.read'], ['teacher'])
    await screen.findByText('Exercise 4.2')
    expect(screen.queryByRole('button', { name: 'Set homework' })).not.toBeInTheDocument()
  })
})

describe('the set sheet', () => {
  it('shows what is missing inline and sends nothing', async () => {
    setup.sections.mockResolvedValue([
      { id: 'sec-1', schoolId: SCHOOL_ID, gradeId: 'g6', academicYearId: 'year-1', name: 'A', version: 1, allowedActions: [] },
      { id: 'sec-2', schoolId: SCHOOL_ID, gradeId: 'g6', academicYearId: 'year-1', name: 'B', version: 1, allowedActions: [] },
    ])
    await renderList(TEACHER, ['teacher'])
    await userEvent.click((await screen.findAllByRole('button', { name: 'Set homework' }))[0]!)
    const sheetEl = await screen.findByRole('dialog')
    await userEvent.click(within(sheetEl).getByRole('button', { name: 'Set homework' }))

    expect(within(sheetEl).getByText(/Choose a subject, or general homework/)).toBeInTheDocument()
    expect(within(sheetEl).getAllByRole('alert').length).toBeGreaterThanOrEqual(3)
    expect(homework.create).not.toHaveBeenCalled()
  })

  it('refuses a due date in the past', async () => {
    await renderList(TEACHER, ['teacher'])
    await userEvent.click((await screen.findAllByRole('button', { name: 'Set homework' }))[0]!)
    const sheetEl = await screen.findByRole('dialog')
    await userEvent.type(within(sheetEl).getByLabelText('Title'), 'Read chapter 4')
    const due = within(sheetEl).getByLabelText('Due on')
    await userEvent.clear(due)
    await userEvent.type(due, addDays(TODAY, -1))
    await userEvent.click(within(sheetEl).getByRole('combobox', { name: 'Subject' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Mathematics' }))
    await userEvent.click(within(sheetEl).getByRole('button', { name: 'Set homework' }))

    expect(within(sheetEl).getByText(/Choose a due date from today/)).toBeInTheDocument()
    expect(homework.create).not.toHaveBeenCalled()
  })

  it('sets general homework for the only class and opens it', async () => {
    await renderList(TEACHER, ['teacher'])
    await userEvent.click((await screen.findAllByRole('button', { name: 'Set homework' }))[0]!)
    const sheetEl = await screen.findByRole('dialog')
    expect(within(sheetEl).getByText('Class 6 A')).toBeInTheDocument()
    await userEvent.click(within(sheetEl).getByRole('combobox', { name: 'Subject' }))
    await userEvent.click(await screen.findByRole('option', { name: 'General (no subject)' }))
    await userEvent.type(within(sheetEl).getByLabelText('Title'), 'Cover your books')
    await userEvent.click(within(sheetEl).getByRole('button', { name: 'Set homework' }))

    await waitFor(() => expect(homework.create).toHaveBeenCalledWith(SCHOOL_ID, {
      sectionId: 'sec-1', subjectId: null, title: 'Cover your books', dueOn: addDays(TODAY, 1),
    }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/homework/$homeworkId', params: { homeworkId: 'hw-new' } }))
  })
})

describe('the detail page', () => {
  it('shows the instructions, the files and Edit and Remove where the item allows homework.set', async () => {
    await renderDetail(TEACHER, ['teacher'])
    expect(await screen.findByText('Questions 1 to 10.')).toBeInTheDocument()
    expect(screen.getByText('sheet.pdf')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download sheet.pdf' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Edit' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Remove' }).length).toBeGreaterThan(0)
  })

  it('offers no Edit or Remove when the item does not allow them, and none on a removed item', async () => {
    homework.get.mockResolvedValue(detail({ allowedActions: ['homework.read'], progress: { pupils: 3, done: 0, partlyDone: 0, notDone: 0, notChecked: 3 } }))
    const { unmount } = await renderDetail(TEACHER, ['teacher'])
    await screen.findByText('Questions 1 to 10.')
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    unmount()

    homework.get.mockResolvedValue(detail({ removedAt: '2026-10-04T10:00:00.000+05:30', removedBy: 'Asha Rao', progress: { pupils: 3, done: 0, partlyDone: 0, notDone: 0, notChecked: 3 } }))
    await renderDetail(TEACHER, ['teacher'])
    expect(await screen.findByText(/Removed .* by Asha Rao/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
  })

  it('removes the item with the version read and an optional reason', async () => {
    homework.remove.mockResolvedValue(detail({ removedAt: '2026-10-04T10:00:00.000+05:30' }))
    await renderDetail(TEACHER, ['teacher'])
    await userEvent.click((await screen.findAllByRole('button', { name: 'Remove' }))[0]!)
    await userEvent.type(screen.getByLabelText('Reason (optional)'), 'Set twice')
    await userEvent.click(screen.getByRole('button', { name: 'Remove homework' }))
    await waitFor(() => expect(homework.remove).toHaveBeenCalledWith(SCHOOL_ID, 'hw-1', { expectedVersion: 2, reason: 'Set twice' }))
  })
})

describe('the check-off sheet', () => {
  it('sends only the changed lines, each with the version it read', async () => {
    await renderDetail(TEACHER, ['teacher'])
    await screen.findByText('1 of 3 pupils checked')

    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Status for Aarav Sharma' })).getByRole('radio', { name: 'Done' }))
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Status for Diya Patel' })).getByRole('radio', { name: 'Partly done' }))
    await userEvent.clear(screen.getByLabelText('Remark for Diya Patel'))
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(homework.saveChecks).toHaveBeenCalledWith(SCHOOL_ID, 'hw-1', {
      entries: [
        { studentId: 'p-1', status: 'done', expectedVersion: 0 },
        { studentId: 'p-2', status: 'partly_done', remark: null, expectedVersion: 3 },
      ],
    }))
  })

  it('marks every pupil not yet marked as done and keeps the ones already marked', async () => {
    await renderDetail(TEACHER, ['teacher'])
    await userEvent.click(await screen.findByRole('button', { name: 'Mark all done' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(homework.saveChecks).toHaveBeenCalled())
    const entries = homework.saveChecks.mock.calls[0]![2].entries as Array<{ studentId: string; status: string }>
    expect(entries.map((entry) => [entry.studentId, entry.status])).toEqual([['p-1', 'done'], ['p-3', 'done']])
  })

  it('asks for a status before a remark can be saved', async () => {
    await renderDetail(TEACHER, ['teacher'])
    await userEvent.type(await screen.findByLabelText('Remark for Kabir Singh'), 'Absent')
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(screen.getByText(/Choose Done, Partly done or Not done/)).toBeInTheDocument()
    expect(homework.saveChecks).not.toHaveBeenCalled()
  })

  it('is read only, and says why, when the window is closed for this person', async () => {
    homework.checks.mockResolvedValue(sheet({ window: { state: 'closed', teacherClosesOn: '2026-09-30', check: false, checkBlockedBy: 'homework_check_window_closed' } }))
    await renderDetail(TEACHER, ['teacher'])
    expect(await screen.findByText(/Ask the school office to change them now/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Status for Aarav Sharma' })).not.toBeInTheDocument()
    expect(screen.getByText('Not done')).toBeInTheDocument()
  })
})

describe('a family', () => {
  const childStatus = { student: { id: CHILD_ID, name: 'Aarav Sharma' }, status: 'not_due' as const }

  it('a parent sees their child\'s items with the child\'s status, and picks a child', async () => {
    students.list.mockResolvedValue({
      items: [
        { id: CHILD_ID, schoolId: SCHOOL_ID, version: 1, firstName: 'Aarav', lastName: 'Sharma', admissionNumber: 'A1', status: 'active', anonymised: false, hasPhoto: false },
        { id: 'child-2', schoolId: SCHOOL_ID, version: 1, firstName: 'Diya', lastName: 'Sharma', admissionNumber: 'A2', status: 'active', anonymised: false, hasPhoto: false },
      ],
      total: 2, page: 1, pageSize: 50,
    })
    homework.list.mockResolvedValue({ today: TODAY, items: [item({ child: childStatus, allowedActions: ['homework.read'], setBy: undefined })], truncated: false, allowedActions: [] })
    search = { studentId: CHILD_ID }
    await renderList(PARENT, ['parent'])

    expect(await screen.findByText('Exercise 4.2')).toBeInTheDocument()
    expect(screen.getByText('Not due yet')).toBeInTheDocument()
    expect(screen.getByText('1 homework item in view')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set homework' })).not.toBeInTheDocument()
    expect(await screen.findByText('Child')).toBeInTheDocument()
    await waitFor(() => expect(homework.list).toHaveBeenCalledWith(SCHOOL_ID, expect.objectContaining({ studentId: CHILD_ID, status: 'upcoming' })))
    expect(homework.list.mock.calls.at(-1)![1]).not.toHaveProperty('academicYearId')
  })

  it('a pupil sees their own, with no child to pick', async () => {
    homework.list.mockResolvedValue({ today: TODAY, items: [item({ child: childStatus, allowedActions: ['homework.read'] })], truncated: false, allowedActions: [] })
    await renderList(['homework.read'], ['student'], { ownStudentId: CHILD_ID })
    expect(await screen.findByText('Exercise 4.2')).toBeInTheDocument()
    expect(screen.queryByText('Child')).not.toBeInTheDocument()
    expect(students.list).not.toHaveBeenCalled()
    expect(homework.list.mock.calls.at(-1)![1]).not.toHaveProperty('studentId')
  })

  it('the detail shows the child\'s status and remark and no check-off sheet', async () => {
    homework.get.mockResolvedValue(detail({ allowedActions: ['homework.read'], children: [{ ...childStatus, status: 'partly_done', remark: 'Finish question 9' }] }))
    await renderDetail(PARENT, ['parent'])
    expect(await screen.findByText('Partly done')).toBeInTheDocument()
    expect(screen.getByText(/Finish question 9/)).toBeInTheDocument()
    expect(screen.queryByText('Check-offs')).not.toBeInTheDocument()
    expect(homework.checks).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })
})

describe('the report', () => {
  const report = {
    from: addDays(TODAY, -30),
    to: TODAY,
    threshold: 3,
    sets: [{ section: SECTION, grade: GRADE, subject: MATHS, items: 4, done: 80, partlyDone: 10, notDone: 20, notChecked: 10 }],
    repeatedNotDone: [{ student: pupil('p-2', 'Diya Patel', 2), section: SECTION, grade: GRADE, notDone: 3, checked: 4 }],
    allowedActions: ['homework.check', 'homework.export'] as PermissionKey[],
  }

  it('shows both tables and exports the same range to Excel', async () => {
    homework.report.mockResolvedValue(report)
    homework.export.mockResolvedValue({ id: 'job-1', status: 'queued' })
    files.exportJob.mockResolvedValue({ id: 'job-1', status: 'queued' })
    const Report = (await import('@/routes/_app/homework/report')).Route
    renderWithSession(<ReportHost route={Report} />, { schoolId: SCHOOL_ID, capabilities: [...TEACHER, 'homework.export'], roleKeys: ['principal'] })

    expect(await screen.findByText('Diya Patel')).toBeInTheDocument()
    expect(screen.getByText('Pupils with 3 or more Not done')).toBeInTheDocument()
    expect(screen.getByText('80')).toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: 'Export to Excel' })[0]!)
    await waitFor(() => expect(homework.export).toHaveBeenCalledWith(SCHOOL_ID, expect.objectContaining({ from: addDays(TODAY, -30), to: TODAY })))
  })

  it('offers no export without homework.export', async () => {
    homework.report.mockResolvedValue({ ...report, allowedActions: ['homework.check'] })
    const Report = (await import('@/routes/_app/homework/report')).Route
    renderWithSession(<ReportHost route={Report} />, { schoolId: SCHOOL_ID, capabilities: TEACHER, roleKeys: ['teacher'] })
    expect(await screen.findByText('Diya Patel')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Export to Excel' })).not.toBeInTheDocument()
  })
})

function ReportHost({ route }: { route: unknown }) {
  const Screen = componentOf(route)
  return <Screen />
}

describe('the pupil\'s Homework due card', () => {
  it('shows the pupil\'s own items due today, and nothing when the field is absent', async () => {
    const { StudentDashboard } = await import('@/components/dashboard/student-dashboard')
    const data = {
      audience: 'student',
      day: { date: TODAY, dayOfWeek: 1, kind: 'school_day' },
      me: {
        student: { id: CHILD_ID, schoolId: SCHOOL_ID, version: 1, firstName: 'Aarav', lastName: 'Sharma', admissionNumber: 'A1', status: 'active', anonymised: false, hasPhoto: false },
        homeworkDue: { today: [{ homeworkId: 'hw-1', subject: MATHS, title: 'Exercise 4.2', dueOn: TODAY, status: 'not_checked' }], tomorrow: [] },
      },
      holidays: [],
    } as unknown as StudentDashboardData
    const { unmount } = renderWithSession(<StudentDashboard data={data} isLoading={false} error={undefined} />, { schoolId: SCHOOL_ID, roleKeys: ['student'] })
    expect(screen.getByText('Homework due')).toBeInTheDocument()
    expect(screen.getByText('Mathematics · Exercise 4.2').closest('a')).toHaveAttribute('href', '/homework/hw-1')
    expect(screen.getByText('Not checked')).toBeInTheDocument()
    unmount()

    const without = { ...data, me: { ...data.me, homeworkDue: undefined } } as StudentDashboardData
    renderWithSession(<StudentDashboard data={without} isLoading={false} error={undefined} />, { schoolId: SCHOOL_ID, roleKeys: ['student'] })
    expect(screen.queryByText('Homework due')).not.toBeInTheDocument()
  })
})
