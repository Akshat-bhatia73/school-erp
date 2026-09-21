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
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiRequestError } from '@/lib/http'
import { renderWithSession } from '@/test/session'

/** No Toaster is rendered here, so the sentence a refusal produces is read off this spy. */
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError } }))

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
  exportProfile: vi.fn(),
  consents: vi.fn(),
  recordConsent: vi.fn(),
  revealApaar: vi.fn(),
  revealAadhaar: vi.fn(),
  revealGuardianIdentity: vi.fn(),
  updateGuardian: vi.fn(),
  uploadPhoto: vi.fn(),
  removePhoto: vi.fn(),
  photoUrl: (schoolId: string, studentId: string, v?: string) =>
    `/api/schools/${schoolId}/students/${studentId}/photo${v ? `?v=${v}` : ''}`,
  anonymise: vi.fn(),
  unlinkGuardian: vi.fn(),
  promotePreview: vi.fn(),
  promote: vi.fn(),
}
const setup = { sections: vi.fn(), grades: vi.fn(), academicYears: vi.fn() }
const files = { exportJob: vi.fn(), downloadStudentDocument: vi.fn(), downloadExportFile: vi.fn() }

vi.mock('@/lib/api', () => ({ api: { students, setup, files } }))

const SCHOOL_ID = '10000000-0000-4000-8000-000000000001'
const YEAR = { id: 'year-1', schoolId: SCHOOL_ID, name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', status: 'current' as const, version: 1 }
const GRADE = { id: 'grade-1', schoolId: SCHOOL_ID, name: 'Class 6', shortName: '6', order: 6, version: 1 }
const SECTION = { id: 'section-1', schoolId: SCHOOL_ID, gradeId: GRADE.id, academicYearId: YEAR.id, name: 'A', capacity: 40, version: 1 }
const STUDENT = {
  id: 'student-1', schoolId: SCHOOL_ID, version: 4, firstName: 'Aarav', lastName: 'Sharma',
  admissionNumber: 'SVM/2026/101', status: 'active' as const, anonymised: false, hasPhoto: false,
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

    const reader = renderWithSession(<GuardiansTab studentId="student-1" studentVersion={4} canManage={false} allowedActions={['students.read_guardians']} />, { capabilities: ['students.read_guardians'] })
    expect(await screen.findByText('Rakesh Sharma')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Unlink' })).not.toBeInTheDocument()
    reader.unmount()

    students.unlinkGuardian.mockResolvedValue({ student: STUDENT, allowedActions: ['students.read_basic'] })
    const user = userEvent.setup()
    renderWithSession(<GuardiansTab studentId="student-1" studentVersion={4} canManage allowedActions={['students.read_guardians', 'students.manage_guardians']} />, { capabilities: ['students.read_guardians', 'students.manage_guardians'] })

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
    expect(screen.queryByRole('button', { name: /export to excel/i })).not.toBeInTheDocument()
    withoutPermission.unmount()

    renderWithSession(<StudentBulkBar ids={['student-1']} onClear={() => {}} />, { capabilities: ['students.read_basic', 'students.export'] })
    await user.click(screen.getByRole('button', { name: /export to excel/i }))

    await waitFor(() => expect(students.export).toHaveBeenCalledWith(SCHOOL_ID, { studentIds: ['student-1'] }))
    expect(await screen.findByText('Preparing your file…')).toBeInTheDocument()
  })

  it('saves the file itself as soon as the job is ready', async () => {
    students.export.mockResolvedValue({ id: 'job-2', status: 'ready', fileName: 'students.xlsx' })
    files.exportJob.mockResolvedValue({ id: 'job-2', status: 'ready', fileName: 'students.xlsx' })
    files.downloadExportFile.mockResolvedValue({ blob: new Blob(['x']), fileName: 'students.xlsx' })
    const user = userEvent.setup()
    const { StudentBulkBar } = await import('@/components/students/student-bulk-bar')

    renderWithSession(<StudentBulkBar ids={['student-1']} onClear={() => {}} />, { capabilities: ['students.read_basic', 'students.export'] })
    await user.click(screen.getByRole('button', { name: /export to excel/i }))

    await waitFor(() => expect(files.downloadExportFile).toHaveBeenCalledWith(SCHOOL_ID, 'job-2'))
    // The file saved itself once; the button is only there to get it again.
    expect(await screen.findByRole('button', { name: /download file/i })).toBeInTheDocument()
    expect(files.downloadExportFile).toHaveBeenCalledTimes(1)
  })
})

describe('Student profile export', () => {
  it('offers Export PDF only when the record allows it, and starts a profile export', async () => {
    students.exportProfile.mockResolvedValue({ id: 'job-3', status: 'queued' })
    files.exportJob.mockResolvedValue({ id: 'job-3', status: 'queued' })
    const { Route } = await import('@/routes/_app/students/$studentId')
    const Screen = (Route as unknown as { component: () => ReactElement }).component

    students.get.mockResolvedValue({ student: STUDENT, allowedActions: ['students.read_basic'] })
    const withoutExport = renderWithSession(<Screen />, { capabilities: ['students.read_basic'] })
    expect(await screen.findByRole('heading', { name: /Aarav/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /export pdf/i })).not.toBeInTheDocument()
    withoutExport.unmount()

    students.get.mockResolvedValue({ student: STUDENT, allowedActions: ['students.read_basic', 'students.export'] })
    const user = userEvent.setup()
    renderWithSession(<Screen />, { capabilities: ['students.read_basic', 'students.export'] })

    await user.click(await screen.findByRole('button', { name: /export pdf/i }))
    await waitFor(() => expect(students.exportProfile).toHaveBeenCalledWith(SCHOOL_ID, 'student-1'))
  })
})

describe('Promote students', () => {
  // The request schema only takes uuids, so this screen needs real-shaped ids.
  const YEAR_ID = '20000000-0000-4000-8000-000000000001'
  const NEXT_YEAR_ID = '20000000-0000-4000-8000-000000000002'
  const SECTION_ID = '30000000-0000-4000-8000-000000000001'
  const NEXT_SECTION_ID = '30000000-0000-4000-8000-000000000002'
  const FIRST = { ...STUDENT, id: '40000000-0000-4000-8000-000000000001' }
  const SECOND = { ...STUDENT, id: '40000000-0000-4000-8000-000000000002', firstName: 'Diya', lastName: 'Rao', admissionNumber: 'SVM/2026/102' }

  beforeEach(() => {
    setup.academicYears.mockResolvedValue([
      { ...YEAR, id: YEAR_ID },
      { ...YEAR, id: NEXT_YEAR_ID, name: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31', status: 'upcoming' as const },
    ])
    setup.sections.mockImplementation((_schoolId: string, params: { academicYearId?: string }) =>
      Promise.resolve([{ ...SECTION, id: params.academicYearId === NEXT_YEAR_ID ? NEXT_SECTION_ID : SECTION_ID, academicYearId: params.academicYearId ?? YEAR_ID }]))
  })

  /** Picks the two sections the screen needs before it asks for a preview. */
  async function pickSections() {
    await userEvent.click(await screen.findByRole('button', { name: /From section/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /Class 6 - A/ }))
    await userEvent.click(await screen.findByRole('button', { name: /To section/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /Class 6 - A/ }))
  }

  it('leaves a student out of the request entirely', async () => {
    students.promotePreview.mockResolvedValue({ students: [FIRST, SECOND], targetSection: { id: SECTION_ID, name: 'Class 7 - A' } })
    students.promote.mockResolvedValue({ promoted: 1, detained: 0 })
    const { Route } = await import('@/routes/_app/students/promote')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, {
      capabilities: ['academic_years.read', 'sections.read', 'grades.read', 'students.read_basic', 'students.promote'],
    })

    await pickSections()
    expect(await screen.findByText('Diya Rao')).toBeInTheDocument()

    // The second row is left out, so only the first student may be sent.
    const leaveOut = screen.getAllByRole('button', { name: 'Leave out' })
    await userEvent.click(leaveOut[1]!)
    expect(await screen.findByText(/1 to promote, 0 to detain, 1 left out/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Promote students' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('1 to promote, 0 to detain, 1 left out')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Promote students' }))

    await waitFor(() => expect(students.promote).toHaveBeenCalledWith(SCHOOL_ID, expect.objectContaining({
      studentIds: [FIRST.id], detainedStudentIds: [],
    })))
  })

  it('will not send anything when every student is left out', async () => {
    students.promotePreview.mockResolvedValue({ students: [FIRST], targetSection: { id: SECTION_ID, name: 'Class 7 - A' } })
    const { Route } = await import('@/routes/_app/students/promote')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, {
      capabilities: ['academic_years.read', 'sections.read', 'grades.read', 'students.read_basic', 'students.promote'],
    })

    await pickSections()
    await userEvent.click(await screen.findByRole('button', { name: 'All leave out' }))

    expect(await screen.findByText('Every student is left out, so there is nothing to do.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Promote students' })).toBeDisabled()
  })
})

/**
 * A photograph and the identity numbers. Both are about what a screen is allowed to show: the
 * photo controls follow the family's consent, and a number already on file is never echoed back.
 */
describe('Photo and identity numbers', () => {
  /** jsdom draws nothing, so the canvas the picture is re-encoded through is stubbed. */
  function stubCanvas() {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1200, height: 900, close: vi.fn() })))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }))
    })
  }

  it('sends the shrunk picture with the version the person was looking at', async () => {
    stubCanvas()
    students.get.mockResolvedValue({
      student: STUDENT,
      allowedActions: ['students.read_basic', 'students.update_basic', 'students.read_consents'],
    })
    students.consents.mockResolvedValue({ items: [CONSENT_ROW], allowedActions: [] })
    students.uploadPhoto.mockResolvedValue(undefined)
    const user = userEvent.setup()
    const { Route } = await import('@/routes/_app/students/$studentId')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, { capabilities: ['students.read_basic', 'students.update_basic'] })

    const picker = await screen.findByLabelText('Add photo')
    await user.upload(picker, new File([new Uint8Array([1])], 'aarav.png', { type: 'image/png' }))

    await waitFor(() => expect(students.uploadPhoto).toHaveBeenCalledWith(SCHOOL_ID, 'student-1', expect.any(Blob), 4))
    // Only the re-encoded JPEG travels, never the file the office chose.
    expect(students.uploadPhoto.mock.calls[0]![2].type).toBe('image/jpeg')
    vi.unstubAllGlobals()
  })

  it('says what to do when the browser cannot rewrite the picture', async () => {
    // The only way the server's own type and metadata checks are reached is a canvas that failed,
    // so a browser that cannot open the file must say so in plain words.
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('broken') }))
    students.get.mockResolvedValue({
      student: STUDENT,
      allowedActions: ['students.read_basic', 'students.update_basic', 'students.read_consents'],
    })
    students.consents.mockResolvedValue({ items: [CONSENT_ROW], allowedActions: [] })
    const user = userEvent.setup()
    const { Route } = await import('@/routes/_app/students/$studentId')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, { capabilities: ['students.read_basic', 'students.update_basic'] })

    const picker = await screen.findByLabelText('Add photo')
    await user.upload(picker, new File([new Uint8Array([1])], 'aarav.webp', { type: 'image/webp' }))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Save the photo as JPEG or PNG and try again.'))
    expect(students.uploadPhoto).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('asks for a smaller photo when the server refuses the size', async () => {
    stubCanvas()
    students.get.mockResolvedValue({
      student: STUDENT,
      allowedActions: ['students.read_basic', 'students.update_basic', 'students.read_consents'],
    })
    students.consents.mockResolvedValue({ items: [CONSENT_ROW], allowedActions: [] })
    students.uploadPhoto.mockRejectedValue(new ApiRequestError({ code: 'INVALID_REQUEST', status: 413, message: 'Too big' }))
    const user = userEvent.setup()
    const { Route } = await import('@/routes/_app/students/$studentId')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, { capabilities: ['students.read_basic', 'students.update_basic'] })

    await user.upload(await screen.findByLabelText('Add photo'), new File([new Uint8Array([1])], 'aarav.png', { type: 'image/png' }))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Choose a photo smaller than 1 MB.'))
    vi.unstubAllGlobals()
  })

  it('asks for the photographs consent instead of offering the control', async () => {
    students.get.mockResolvedValue({
      student: STUDENT,
      allowedActions: ['students.read_basic', 'students.update_basic', 'students.read_consents'],
    })
    students.consents.mockResolvedValue({ items: [{ ...CONSENT_ROW, status: 'withdrawn' as const }], allowedActions: [] })
    const { Route } = await import('@/routes/_app/students/$studentId')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, { capabilities: ['students.read_basic', 'students.update_basic'] })

    expect(await screen.findByText('Photo upload needs the photographs consent from the parent.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Add photo')).not.toBeInTheDocument()
  })

  it('shows the photo on the header only when the record carries one', async () => {
    students.get.mockResolvedValue({
      student: { ...STUDENT, hasPhoto: true, photoUpdatedAt: '2026-04-02T10:00:00.000Z' },
      allowedActions: ['students.read_basic'],
    })
    const { Route } = await import('@/routes/_app/students/$studentId')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, { capabilities: ['students.read_basic'] })

    const image = await screen.findByAltText('Aarav Sharma')
    expect(image).toHaveAttribute('src', expect.stringContaining('/students/student-1/photo?v=2026-04-02'))
    expect(image).toHaveAttribute('loading', 'lazy')
  })

  it('keeps a guardian number on file hidden until Replace is asked for', async () => {
    students.get.mockResolvedValue({ student: STUDENT, allowedActions: ['students.read_basic'] })
    students.guardians.mockResolvedValue([{
      id: 'guardian-1', displayName: 'Rakesh Sharma', phone: '+919876543210', version: 2,
      officeAddress: '4 Mill Road', panLast4: '123A', aadhaarLast4: '0124',
    }])
    students.updateGuardian.mockResolvedValue({ id: 'guardian-1', displayName: 'Rakesh Sharma', phone: '+919876543210' })
    const user = userEvent.setup()
    const { Route } = await import('@/routes/_app/students/$studentId')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, {
      capabilities: ['students.read_basic', 'students.read_guardians', 'students.manage_guardians'],
    })

    await user.click(await screen.findByRole('tab', { name: 'Guardians' }))
    expect(await screen.findByText('ending 0124')).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Edit' }))

    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).getByText('ending 0124')).toBeInTheDocument()
    expect(within(sheet).queryByLabelText('Aadhaar number')).not.toBeInTheDocument()

    await user.click(within(sheet).getAllByRole('button', { name: 'Replace' })[1]!)
    await user.type(within(sheet).getByLabelText('Aadhaar number'), '234567890124')
    await user.click(within(sheet).getByRole('button', { name: 'Save changes' }))

    // The whole number is sent once; the spaces people type are not part of it.
    await waitFor(() => expect(students.updateGuardian).toHaveBeenCalledWith(SCHOOL_ID, 'student-1', 'guardian-1',
      expect.objectContaining({ aadhaar: '234567890124', officeAddress: '4 Mill Road' })))
  })

  it('reveals a guardian number only for somebody who may read guardians, and forgets it again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    students.get.mockResolvedValue({ student: STUDENT, allowedActions: ['students.read_basic', 'students.read_guardians'] })
    students.guardians.mockResolvedValue([{
      id: 'guardian-1', displayName: 'Rakesh Sharma', phone: '+919876543210',
      panLast4: '234F', aadhaarLast4: '0124',
    }])
    students.revealGuardianIdentity.mockResolvedValue({ pan: 'ABCDE1234F', aadhaar: '234567890124' })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { Route } = await import('@/routes/_app/students/$studentId')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, { capabilities: ['students.read_basic', 'students.read_guardians'] })

    await user.click(await screen.findByRole('tab', { name: 'Guardians' }))
    expect(await screen.findByText('ending 234F')).toBeInTheDocument()

    await user.click((await screen.findAllByRole('button', { name: /reveal/i }))[0]!)
    expect(await screen.findByText('ABCDE1234F')).toBeInTheDocument()
    expect(students.revealGuardianIdentity).toHaveBeenCalledWith(SCHOOL_ID, 'student-1', 'guardian-1')

    // Thirty seconds later the screen is back to the last digits on its own.
    await act(async () => { vi.advanceTimersByTime(30_000) })
    expect(screen.queryByText('ABCDE1234F')).not.toBeInTheDocument()
    expect(screen.getByText('ending 234F')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('offers no reveal on a guardian card the record does not allow', async () => {
    students.get.mockResolvedValue({ student: STUDENT, allowedActions: ['students.read_basic'] })
    students.guardians.mockResolvedValue([{
      id: 'guardian-1', displayName: 'Rakesh Sharma', phone: '+919876543210', panLast4: '234F',
    }])
    const user = userEvent.setup()
    const { Route } = await import('@/routes/_app/students/$studentId')
    const Screen = componentOf(Route)
    renderWithSession(<Screen />, { capabilities: ['students.read_basic', 'students.read_guardians'] })

    await user.click(await screen.findByRole('tab', { name: 'Guardians' }))
    expect(await screen.findByText('ending 234F')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reveal/i })).not.toBeInTheDocument()
    expect(students.revealGuardianIdentity).not.toHaveBeenCalled()
  })
})
