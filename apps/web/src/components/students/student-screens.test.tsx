/**
 * Student screens on the real API.
 *
 * Every test fixes what the server answered and checks what the screen did with it: the rows it
 * shows, the controls it hides when a capability or an allowedActions key is missing, the body a
 * save sends, and the sentence a refusal produces. The API module and the router are mocked, so
 * nothing here touches the network or a route tree.
 */
import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiRequestError } from '@/lib/http'
import { renderWithSession } from '@/test/session'

const navigate = vi.fn()
let search: Record<string, unknown> = { status: 'active', sort: 'name', page: 1 }
let params: Record<string, string> = { studentId: 'student-1' }

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    createFileRoute: () => (options: Record<string, unknown>) => ({
      ...options,
      useSearch: () => search,
      useParams: () => params,
      fullPath: '/students',
    }),
    useNavigate: () => navigate,
    Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  }
})

const students = {
  list: vi.fn(),
  count: vi.fn(),
  get: vi.fn(),
  guardians: vi.fn(),
  siblings: vi.fn(),
  documents: vi.fn(),
  enrollments: vi.fn(),
  updateBasic: vi.fn(),
  updateSensitive: vi.fn(),
  move: vi.fn(),
  leave: vi.fn(),
  addGuardian: vi.fn(),
  export: vi.fn(),
  consents: vi.fn(),
  recordConsent: vi.fn(),
  revealApaar: vi.fn(),
  anonymise: vi.fn(),
  unlinkGuardian: vi.fn(),
}
const setup = { sections: vi.fn(), grades: vi.fn(), academicYears: vi.fn() }
const files = { exportJob: vi.fn(), downloadStudentDocument: vi.fn() }

vi.mock('@/lib/api', () => ({ api: { students, setup, files } }))

const SCHOOL_ID = '10000000-0000-4000-8000-000000000001'
const YEAR = { id: 'year-1', schoolId: SCHOOL_ID, name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', status: 'current' as const, version: 1 }
const GRADE = { id: 'grade-1', schoolId: SCHOOL_ID, name: 'Class 6', shortName: '6', order: 6, version: 1 }
const SECTION = { id: 'section-1', schoolId: SCHOOL_ID, gradeId: GRADE.id, academicYearId: YEAR.id, name: 'A', capacity: 40, version: 1 }
const STUDENT = {
  id: 'student-1', schoolId: SCHOOL_ID, version: 4, firstName: 'Aarav', lastName: 'Sharma',
  admissionNumber: 'SVM/2026/101', status: 'active' as const, anonymised: false,
  enrollment: {
    id: 'enrollment-1', academicYear: { id: YEAR.id, name: YEAR.name },
    section: { id: SECTION.id, name: 'A' }, grade: { id: GRADE.id, name: 'Class 6' },
    rollNumber: 7, outcome: 'ongoing' as const,
  },
}

/** The mocked router hands back the options object, which carries the screen's component. */
function componentOf(route: unknown): () => ReactElement {
  return (route as { component: () => ReactElement }).component
}

beforeEach(() => {
  vi.clearAllMocks()
  search = { status: 'active', sort: 'name', page: 1 }
  params = { studentId: 'student-1' }
  setup.academicYears.mockResolvedValue([YEAR])
  setup.grades.mockResolvedValue([GRADE])
  setup.sections.mockResolvedValue([SECTION])
  students.list.mockResolvedValue({ items: [STUDENT], total: 1, page: 1, pageSize: 25 })
  students.guardians.mockResolvedValue([])
  students.siblings.mockResolvedValue([])
  students.documents.mockResolvedValue([])
  students.enrollments.mockResolvedValue([])
  students.consents.mockResolvedValue({ items: [], allowedActions: [] })
})

const CONSENT_ROW = {
  id: 'consent-1', studentId: 'student-1', guardianId: 'guardian-1', guardianDisplayName: 'Rakesh Sharma',
  purpose: 'photographs' as const, status: 'given' as const, method: 'in_person' as const,
  recordedAt: '2026-04-02T10:00:00.000Z', recordedBy: 'office' as const,
}

describe('Student roster', () => {
  it('shows the bounded roster the server sent and the actions this person holds', async () => {
    const { Route } = await import('@/routes/_app/students/index')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, {
      capabilities: ['academic_years.read', 'sections.read', 'grades.read', 'students.read_basic', 'students.create', 'students.import', 'students.promote'],
    })

    expect(await screen.findByText('Aarav Sharma')).toBeInTheDocument()
    expect(screen.getByText('Class 6 - A')).toBeInTheDocument()
    expect(screen.getByText('1 students in view')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /admit/i }).length).toBeGreaterThan(0)
    // No academicYearId: the server matches it against the current enrolment, so sending the
    // running year would hide every student whose latest enrolment is elsewhere.
    await waitFor(() => expect(students.list).toHaveBeenCalledWith(SCHOOL_ID, {
      page: 1, pageSize: 25, search: undefined, sectionId: undefined,
      status: 'active', sort: 'name',
    }))
    expect(students.list).not.toHaveBeenCalledWith(SCHOOL_ID, expect.objectContaining({ academicYearId: expect.anything() }))
  })

  it('does not render the admit, import or promote actions without those permissions', async () => {
    const { Route } = await import('@/routes/_app/students/index')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, { capabilities: ['academic_years.read', 'sections.read', 'students.read_basic'] })

    expect(await screen.findByText('Aarav Sharma')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /admit student/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^import$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^promote$/i })).not.toBeInTheDocument()
  })

  it('says one sentence when the roster itself is refused', async () => {
    students.list.mockRejectedValue(new ApiRequestError({ code: 'ACCESS_DENIED', status: 403, message: 'no' }))
    const { Route } = await import('@/routes/_app/students/index')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, { capabilities: ['students.read_basic'] })

    expect(await screen.findByText('The roster is not available')).toBeInTheDocument()
    expect(screen.getByText('You do not have permission to do this.')).toBeInTheDocument()
  })
})

describe('Student record', () => {
  it('shows only the blocks and tabs the server allowed', async () => {
    students.get.mockResolvedValue({
      student: STUDENT,
      sensitive: {
        dateOfBirth: '2015-05-14', gender: 'male', admissionDate: '2026-04-01',
        category: 'general', admissionType: 'new', address: '12 Ring Road',
      },
      allowedActions: ['students.read_basic'],
    })
    const { Route } = await import('@/routes/_app/students/$studentId')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, { capabilities: ['students.read_basic', 'students.read_enrollments'] })

    expect(await screen.findByRole('heading', { name: 'Aarav Sharma' })).toBeInTheDocument()
    expect(screen.getByText('12 Ring Road')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Class history' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Guardians' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Documents' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit name/i })).not.toBeInTheDocument()
  })

  it('sends the version the person was looking at and clears the student cache', async () => {
    students.get.mockResolvedValue({ student: STUDENT, allowedActions: ['students.read_basic', 'students.update_basic'] })
    students.updateBasic.mockResolvedValue({ ...STUDENT, version: 5 })
    const user = userEvent.setup()
    const { Route } = await import('@/routes/_app/students/$studentId')
    const Screen = componentOf(Route)
    const { queryClient } = renderWithSession(<Screen />, { capabilities: ['students.read_basic', 'students.update_basic'] })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    await user.click(await screen.findByRole('button', { name: /edit name/i }))
    const firstName = await screen.findByDisplayValue('Aarav')
    await user.clear(firstName)
    await user.type(firstName, 'Aarohi')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(students.updateBasic).toHaveBeenCalledWith(SCHOOL_ID, 'student-1', {
      expectedVersion: 4, firstName: 'Aarohi', lastName: 'Sharma',
    }))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: [SCHOOL_ID, 'students'] }))
  })

  it('says one sentence when the record itself is refused', async () => {
    students.get.mockRejectedValue(new ApiRequestError({ code: 'RESOURCE_NOT_FOUND', status: 404, message: 'no' }))
    const { Route } = await import('@/routes/_app/students/$studentId')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, { capabilities: ['students.read_basic'] })

    expect(await screen.findByText('This student is not available')).toBeInTheDocument()
    expect(screen.getByText('We could not find that.')).toBeInTheDocument()
  })
})

describe('Consent', () => {
  it('shows the latest answer per purpose and no Give or Withdraw without manage_consents', async () => {
    students.consents.mockResolvedValue({ items: [CONSENT_ROW], allowedActions: ['students.read_consents'] })
    const { ConsentsTab } = await import('@/components/students/student-profile')
    renderWithSession(<ConsentsTab studentId="student-1" />, { capabilities: ['students.read_consents'] })

    expect(await screen.findByText('Photographs')).toBeInTheDocument()
    expect(screen.getByText(/^Given/)).toBeInTheDocument()
    expect(screen.getAllByText('Not asked')).toHaveLength(4)
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument()
  })

  it('withdraws the purpose that was given, with the method the office picked', async () => {
    students.consents.mockResolvedValue({ items: [CONSENT_ROW], allowedActions: ['students.read_consents', 'students.manage_consents'] })
    students.recordConsent.mockResolvedValue({ items: [{ ...CONSENT_ROW, status: 'withdrawn' }], allowedActions: ['students.read_consents', 'students.manage_consents'] })
    const user = userEvent.setup()
    const { ConsentsTab } = await import('@/components/students/student-profile')
    renderWithSession(<ConsentsTab studentId="student-1" />, { capabilities: ['students.read_consents', 'students.manage_consents'] })

    await user.click(await screen.findByRole('button', { name: 'Withdraw' }))

    await waitFor(() => expect(students.recordConsent).toHaveBeenCalledWith(SCHOOL_ID, 'student-1', {
      guardianId: 'guardian-1', purpose: 'photographs', status: 'withdrawn', method: 'in_person',
    }))
  })
})

describe('APAAR', () => {
  it('shows only the mask, and fetches the full id once somebody asks for it', async () => {
    students.get.mockResolvedValue({
      student: STUDENT,
      sensitive: { dateOfBirth: '2015-05-14', gender: 'male', admissionDate: '2026-04-01', apaarMasked: 'XXXX-XXXX-7788' },
      allowedActions: ['students.read_basic', 'students.read_sensitive'],
    })
    students.revealApaar.mockResolvedValue({ apaarId: '1234-5678-7788' })
    const user = userEvent.setup()
    const { Route } = await import('@/routes/_app/students/$studentId')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, { capabilities: ['students.read_basic', 'students.read_sensitive'] })

    expect(await screen.findByText('XXXX-XXXX-7788')).toBeInTheDocument()
    expect(students.revealApaar).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /reveal/i }))

    expect(await screen.findByText('1234-5678-7788')).toBeInTheDocument()
    expect(students.revealApaar).toHaveBeenCalledWith(SCHOOL_ID, 'student-1')
  })

  it('offers no reveal without the sensitive read', async () => {
    students.get.mockResolvedValue({
      student: STUDENT,
      sensitive: { dateOfBirth: '2015-05-14', gender: 'male', admissionDate: '2026-04-01', apaarMasked: 'XXXX-XXXX-7788' },
      allowedActions: ['students.read_basic'],
    })
    const { Route } = await import('@/routes/_app/students/$studentId')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, { capabilities: ['students.read_basic'] })

    expect(await screen.findByText('XXXX-XXXX-7788')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reveal/i })).not.toBeInTheDocument()
  })
})

describe('Anonymisation', () => {
  it('hides the action without students.anonymise and sends the version and reason with it', async () => {
    students.get.mockResolvedValue({ student: STUDENT, allowedActions: ['students.read_basic'] })
    const { Route } = await import('@/routes/_app/students/$studentId')
    const Screen = componentOf(Route)
    const reader = renderWithSession(<Screen />, { capabilities: ['students.read_basic'] })
    expect(await screen.findByRole('heading', { name: 'Aarav Sharma' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /anonymise record/i })).not.toBeInTheDocument()
    reader.unmount()

    students.get.mockResolvedValue({ student: STUDENT, allowedActions: ['students.read_basic', 'students.anonymise'] })
    students.anonymise.mockResolvedValue({ student: { ...STUDENT, anonymised: true }, allowedActions: ['students.read_basic'] })
    const user = userEvent.setup()
    renderWithSession(<Screen />, { capabilities: ['students.read_basic'] })

    await user.click(await screen.findByRole('button', { name: /anonymise record/i }))
    expect(await screen.findByText(/What stays: name, admission number/)).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('Retention period is over'), 'Left five years ago')
    await user.click(screen.getByRole('button', { name: 'Anonymise record' }))

    await waitFor(() => expect(students.anonymise).toHaveBeenCalledWith(SCHOOL_ID, 'student-1', {
      expectedVersion: 4, reason: 'Left five years ago',
    }))
  })

  it('tags a record that has already been anonymised', async () => {
    students.get.mockResolvedValue({ student: { ...STUDENT, anonymised: true }, allowedActions: ['students.read_basic', 'students.anonymise'] })
    const { Route } = await import('@/routes/_app/students/$studentId')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, { capabilities: ['students.read_basic'] })

    expect(await screen.findByText('Anonymised')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /anonymise record/i })).not.toBeInTheDocument()
  })
})

describe('Guardian unlink', () => {
  it('unlinks with the student version and a reason, and only for somebody who manages guardians', async () => {
    students.guardians.mockResolvedValue([{ id: 'guardian-1', displayName: 'Rakesh Sharma', phone: '+919876543210' }])
    const { GuardiansTab } = await import('@/components/students/student-profile')

    const reader = renderWithSession(<GuardiansTab studentId="student-1" studentVersion={4} canManage={false} />, { capabilities: ['students.read_guardians'] })
    expect(await screen.findByText('Rakesh Sharma')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Unlink' })).not.toBeInTheDocument()
    reader.unmount()

    students.unlinkGuardian.mockResolvedValue({ student: STUDENT, allowedActions: ['students.read_basic'] })
    const user = userEvent.setup()
    renderWithSession(<GuardiansTab studentId="student-1" studentVersion={4} canManage />, { capabilities: ['students.read_guardians', 'students.manage_guardians'] })

    await user.click(await screen.findByRole('button', { name: 'Unlink' }))
    await user.type(await screen.findByPlaceholderText(/No longer the guardian/i), 'Moved out of the family home')
    await user.click(screen.getByRole('button', { name: 'Unlink guardian' }))

    await waitFor(() => expect(students.unlinkGuardian).toHaveBeenCalledWith(SCHOOL_ID, 'student-1', 'guardian-1', {
      expectedVersion: 4, reason: 'Moved out of the family home',
    }))
  })
})

describe('Bulk export bar', () => {
  it('offers the export only to somebody who may export, and polls the job', async () => {
    students.export.mockResolvedValue({ id: 'job-1', status: 'queued' })
    files.exportJob.mockResolvedValue({ id: 'job-1', status: 'queued' })
    const user = userEvent.setup()
    const { StudentBulkBar } = await import('@/components/students/student-bulk-bar')

    const withoutPermission = renderWithSession(<StudentBulkBar ids={['student-1']} onClear={() => {}} />, { capabilities: ['students.read_basic'] })
    expect(screen.queryByRole('button', { name: /export selected/i })).not.toBeInTheDocument()
    withoutPermission.unmount()

    renderWithSession(<StudentBulkBar ids={['student-1']} onClear={() => {}} />, { capabilities: ['students.read_basic', 'students.export'] })
    await user.click(screen.getByRole('button', { name: /export selected/i }))

    await waitFor(() => expect(students.export).toHaveBeenCalledWith(SCHOOL_ID, { studentIds: ['student-1'] }))
    expect(await screen.findByText('Preparing your export…')).toBeInTheDocument()
  })
})
