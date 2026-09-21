/** Staff screens: what the data shows, what disappears without permission, and what a save sends. */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithSession } from '@/test/session'
import { ApiRequestError } from '@/lib/http'

const toastSuccess = vi.fn()
vi.mock('sonner', () => ({ toast: { success: (...args: unknown[]) => toastSuccess(...args), error: vi.fn() } }))

const navigate = vi.fn()
let search: Record<string, unknown> = { page: 1 }

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    createFileRoute: () => (options: Record<string, unknown>) => ({
      ...options,
      options,
      useSearch: () => search,
      useParams: () => ({ staffId: 'staff-1' }),
      fullPath: '/staff',
    }),
    useNavigate: () => navigate,
    Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  }
})

vi.mock('@/lib/api', () => ({
  api: {
    staff: {
      list: vi.fn(),
      departments: vi.fn(),
      get: vi.fn(),
      assignments: vi.fn(),
      assign: vi.fn(),
      unassign: vi.fn(),
      create: vi.fn(),
      updateEmployment: vi.fn(),
      updatePrivate: vi.fn(),
      updatePay: vi.fn(),
      export: vi.fn(),
      exportProfile: vi.fn(),
      uploadPhoto: vi.fn(),
      removePhoto: vi.fn(),
      photoUrl: (schoolId: string, staffId: string, v?: string) =>
        `/api/schools/${schoolId}/staff/${staffId}/photo${v ? `?v=${v}` : ''}`,
    },
    setup: { sections: vi.fn(), grades: vi.fn(), subjects: vi.fn(), academicYears: vi.fn() },
    files: { exportJob: vi.fn(), downloadExportFile: vi.fn() },
    members: { list: vi.fn() },
  },
}))

const { api } = await import('@/lib/api')
const { Route: DirectoryRoute } = await import('@/routes/_app/staff/index')
const { TeachingTab } = await import('./teaching-tab')
const { StaffEmploymentSheet } = await import('./edit-sheet')
const { Route: RecordRoute } = await import('@/routes/_app/staff/$staffId')
const { Route: AddStaffRoute } = await import('@/routes/_app/staff/new')

const SCHOOL_ID = '10000000-0000-4000-8000-000000000001'

const anita = { id: 'staff-1', schoolId: SCHOOL_ID, version: 4, displayName: 'Anita Sharma', designation: 'TGT Science', department: 'Science', anonymised: false, hasPhoto: false }

function directoryPage() {
  return { items: [anita], total: 1, page: 1, pageSize: 25 }
}

const Directory = DirectoryRoute.options.component as () => ReactNode
const AddStaff = AddStaffRoute.options.component as () => ReactNode
const StaffRecord = RecordRoute.options.component as () => ReactNode
// The route object reads its own params; the test renders the component outside a router.
;(RecordRoute as unknown as { useParams: () => unknown }).useParams = () => ({ staffId: 'staff-1' })

beforeEach(() => {
  vi.clearAllMocks()
  search = { page: 1 }
  vi.mocked(api.staff.list).mockResolvedValue(directoryPage())
  vi.mocked(api.staff.departments).mockResolvedValue(['Science'])
  vi.mocked(api.members.list).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 })
})

describe('staff directory', () => {
  it('shows the staff the server sent, with the add and export controls', async () => {
    renderWithSession(<Directory />, { capabilities: ['staff.read_directory', 'staff.create', 'staff.export'] })

    expect(await screen.findByText('Anita Sharma')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /add staff/i }).length).toBeGreaterThan(0)
    expect(api.staff.list).toHaveBeenCalledWith(SCHOOL_ID, { page: 1, pageSize: 25, sort: 'name', search: undefined, department: undefined })
  })

  it('hides add, and offers no selection, when those capabilities are missing', async () => {
    renderWithSession(<Directory />, { capabilities: ['staff.read_directory'] })

    expect(await screen.findByText('Anita Sharma')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add staff/i })).not.toBeInTheDocument()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  })

  it('asks the server for one department and pages from the first page', async () => {
    search = { page: 3, department: 'Science' }
    renderWithSession(<Directory />, { capabilities: ['staff.read_directory'] })

    await waitFor(() => expect(api.staff.list).toHaveBeenCalledWith(SCHOOL_ID, {
      page: 3, pageSize: 25, sort: 'name', search: undefined, department: 'Science',
    }))
  })

  it('downloads the file itself once the export is ready', async () => {
    vi.mocked(api.staff.export).mockResolvedValue({ id: 'job-1', status: 'ready', fileName: 'staff.xlsx' })
    vi.mocked(api.files.exportJob).mockResolvedValue({ id: 'job-1', status: 'ready', fileName: 'staff.xlsx' })
    vi.mocked(api.files.downloadExportFile).mockResolvedValue({ blob: new Blob(['x']), fileName: 'staff.xlsx' })

    renderWithSession(<Directory />, { capabilities: ['staff.read_directory', 'staff.export'] })
    await screen.findByText('Anita Sharma')
    await userEvent.click(screen.getAllByRole('checkbox')[1] as HTMLElement)
    await userEvent.click(screen.getAllByRole('button', { name: /export to excel/i })[0] as HTMLElement)

    await waitFor(() => expect(api.staff.export).toHaveBeenCalledWith(SCHOOL_ID, { staffIds: ['staff-1'] }))
    await waitFor(() => expect(api.files.downloadExportFile).toHaveBeenCalledWith(SCHOOL_ID, 'job-1'))
  })

  it('says one sentence when the directory is refused', async () => {
    vi.mocked(api.staff.list).mockRejectedValue(new ApiRequestError({ code: 'ACCESS_DENIED', status: 403, message: 'no' }))

    renderWithSession(<Directory />, { capabilities: ['staff.read_directory'] })

    expect(await screen.findByText('You cannot see the staff directory')).toBeInTheDocument()
  })
})

describe('teaching assignments', () => {
  const assignment = {
    id: 'assign-1',
    academicYearId: 'year-1',
    section: { id: 'section-1', name: 'A' },
    subject: { id: 'subject-1', name: 'Science' },
    teacher: { id: 'staff-1', name: 'Anita Sharma' },
    validFrom: '2026-04-01',
    validUntil: null,
  }

  it('lists assignments and offers no editor without the manage key', async () => {
    vi.mocked(api.staff.assignments).mockResolvedValue([assignment])

    renderWithSession(<TeachingTab staffId="staff-1" staffVersion={4} canManage={false} />, {
      capabilities: ['staff.read_directory', 'staff.read_employment'],
    })

    expect(await screen.findByText('Science')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save assignment/i })).not.toBeInTheDocument()
  })

  it('shows an empty state when nothing is assigned', async () => {
    vi.mocked(api.staff.assignments).mockResolvedValue([])

    renderWithSession(<TeachingTab staffId="staff-1" staffVersion={4} canManage={false} />, {
      capabilities: ['staff.read_directory', 'staff.read_employment'],
    })

    expect(await screen.findByText('No subjects assigned yet')).toBeInTheDocument()
  })
})

describe('employment sheet', () => {
  it('sends the version the person was looking at and clears the staff cache', async () => {
    const detail = { staff: anita, employment: { employeeCode: 'SVM-E001', joiningDate: '2020-06-01', employmentType: 'permanent' as const, status: 'active' as const }, allowedActions: ['staff.update_employment' as const] }
    vi.mocked(api.staff.updateEmployment).mockResolvedValue({ ...detail })

    const { queryClient } = renderWithSession(
      <StaffEmploymentSheet detail={detail} open onOpenChange={() => {}} />,
      { capabilities: ['staff.read_directory', 'staff.update_employment'] },
    )
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.staff.updateEmployment).toHaveBeenCalled())
    expect(vi.mocked(api.staff.updateEmployment).mock.calls[0]?.[2]).toMatchObject({ expectedVersion: 4, designation: 'TGT Science' })
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: [SCHOOL_ID, 'staff'] }))
  })
})

describe('staff record', () => {
  it('hides the pay panel and every edit control the record does not allow', async () => {
    vi.mocked(api.staff.get).mockResolvedValue({
      staff: anita,
      employment: { employeeCode: 'SVM-E001', joiningDate: '2020-06-01', employmentType: 'permanent' as const, status: 'active' as const },
      private: { phone: '+919876543210', address: '12 Fixture Road', dateOfBirth: undefined, panLast4: undefined, bankAccountLast4: undefined },
      allowedActions: ['staff.read_directory' as const, 'staff.read_private' as const],
    })

    renderWithSession(<StaffRecord />, { capabilities: ['staff.read_directory'] })

    expect(await screen.findByRole('heading', { name: 'Anita Sharma' })).toBeInTheDocument()
    expect(screen.queryByText('Pay')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit employment/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /login/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /export pdf/i })).not.toBeInTheDocument()
  })

  it('exports the profile as a PDF when the record allows it', async () => {
    vi.mocked(api.staff.get).mockResolvedValue({
      staff: anita,
      employment: { employeeCode: 'SVM-E001', joiningDate: '2020-06-01', employmentType: 'permanent' as const, status: 'active' as const },
      allowedActions: ['staff.read_directory' as const, 'staff.export' as const],
    })
    vi.mocked(api.staff.exportProfile).mockResolvedValue({ id: 'job-2', status: 'queued' })
    vi.mocked(api.files.exportJob).mockResolvedValue({ id: 'job-2', status: 'queued' })

    renderWithSession(<StaffRecord />, { capabilities: ['staff.read_directory', 'staff.export'] })

    await userEvent.click((await screen.findAllByRole('button', { name: /export pdf/i }))[0] as HTMLElement)

    await waitFor(() => expect(api.staff.exportProfile).toHaveBeenCalledWith(SCHOOL_ID, 'staff-1'))
    expect(await screen.findByText('Preparing your file…')).toBeInTheDocument()
  })
})

describe('employment sheet leaving date', () => {
  it('does not clear the leaving date when the field is empty', async () => {
    const detail = { staff: anita, employment: { employeeCode: 'SVM-E001', joiningDate: '2020-06-01', employmentType: 'permanent' as const, status: 'active' as const }, allowedActions: ['staff.update_employment' as const] }
    vi.mocked(api.staff.updateEmployment).mockResolvedValue({ ...detail })

    renderWithSession(<StaffEmploymentSheet detail={detail} open onOpenChange={() => {}} />, {
      capabilities: ['staff.read_directory', 'staff.update_employment'],
    })

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.staff.updateEmployment).toHaveBeenCalled())
    expect(vi.mocked(api.staff.updateEmployment).mock.calls[0]?.[2]).not.toHaveProperty('leavingDate')
  })
})

describe('add staff', () => {
  it('offers no employee code field and sends none, because the server assigns it', async () => {
    // The create response itself carries the assigned code, so the toast can
    // always name it without a second read that permissions might refuse.
    vi.mocked(api.staff.create).mockResolvedValue({
      ...anita,
      id: 'staff-9',
      version: 1,
      displayName: 'Ravi Kumar',
      employeeCode: 'SVM-E007',
    })

    renderWithSession(<AddStaff />, { capabilities: ['staff.read_directory', 'staff.create'] })

    expect(await screen.findByText('Employment')).toBeInTheDocument()
    expect(screen.queryByText('Employee code')).not.toBeInTheDocument()

    await userEvent.type(screen.getByPlaceholderText('Anita'), 'Ravi')
    await userEvent.type(screen.getByPlaceholderText('PRT English'), 'TGT Science')
    await userEvent.type(screen.getByPlaceholderText('+919876543210'), '+919876543210')
    await userEvent.click(screen.getAllByRole('button', { name: /save staff member/i })[0]!)

    await waitFor(() => expect(api.staff.create).toHaveBeenCalled())
    const body = vi.mocked(api.staff.create).mock.calls[0]?.[1]
    expect(body).toMatchObject({ firstName: 'Ravi', designation: 'TGT Science', phone: '+919876543210' })
    expect(body).not.toHaveProperty('employeeCode')
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Added Ravi Kumar as SVM-E007'))
  })
})

/** The staff photograph. The controls belong to whoever may change the private details. */
describe('staff photo', () => {
  it('shows the picture on the record when the person has one', async () => {
    vi.mocked(api.staff.get).mockResolvedValue({
      staff: { ...anita, hasPhoto: true, photoUpdatedAt: '2026-04-02T10:00:00.000Z' },
      allowedActions: ['staff.read_directory'],
    } as never)
    renderWithSession(<StaffRecord />, { capabilities: ['staff.read_directory'] })

    const image = await screen.findByAltText('Anita Sharma')
    expect(image).toHaveAttribute('src', expect.stringContaining('/staff/staff-1/photo?v=2026-04-02'))
  })

  it('offers no photo controls to somebody who may only read the record', async () => {
    vi.mocked(api.staff.get).mockResolvedValue({ staff: anita, allowedActions: ['staff.read_directory'] } as never)
    renderWithSession(<StaffRecord />, { capabilities: ['staff.read_directory'] })

    expect(await screen.findByRole('heading', { name: 'Anita Sharma' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Add photo')).not.toBeInTheDocument()
  })
})
