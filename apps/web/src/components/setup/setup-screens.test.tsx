/**
 * School setup screens on the real API.
 *
 * Each test fixes what the server answered and checks what the screen did with it: the data it
 * shows, the controls it hides when the capability is missing, the body a save sends, and the
 * sentence a refusal produces. The API module and the router are both mocked, so nothing here
 * touches the network or a route tree.
 */
import type { ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithSession } from '@/test/session'
import { ApiRequestError } from '@/lib/http'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    createFileRoute: () => (options: unknown) => options,
    Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  }
})

/**
 * The router mock makes `createFileRoute` return its options object, but TypeScript still sees the
 * real `Route` type, so the module is read through this boundary instead.
 */
type RouteModule = { Route: { component: () => ReactNode } }
const loadRoute = async (loader: () => Promise<unknown>) => ((await loader()) as RouteModule).Route

const setup = {
  school: vi.fn(),
  updateSchool: vi.fn(),
  academicYears: vi.fn(),
  grades: vi.fn(),
  sections: vi.fn(),
  sectionStrengths: vi.fn(),
  subjects: vi.fn(),
  gradeSubjects: vi.fn(),
  holidays: vi.fn(),
  updateHoliday: vi.fn(),
}
const staff = { list: vi.fn() }

vi.mock('@/lib/api', () => ({ api: { setup, staff } }))

const SCHOOL_ID = '10000000-0000-4000-8000-000000000001'
// Every setup record names what this caller may do to it, exactly as the server sends it.
const YEAR = { id: 'year-1', schoolId: SCHOOL_ID, name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', status: 'current' as const, version: 3, allowedActions: ['academic_years.manage' as const] }
const GRADE = { id: 'grade-1', schoolId: SCHOOL_ID, name: 'Class 6', shortName: '6', order: 6, version: 1, allowedActions: ['grades.manage' as const] }
const SECTION = { id: 'section-1', schoolId: SCHOOL_ID, gradeId: GRADE.id, academicYearId: YEAR.id, name: 'A', capacity: 40, version: 2, allowedActions: ['sections.manage' as const] }
const HOLIDAY = {
  id: 'holiday-1', schoolId: SCHOOL_ID, academicYearId: YEAR.id, name: 'Diwali',
  startDate: '2026-11-08', endDate: '2026-11-10', type: 'festival' as const, version: 1789484912644807,
  allowedActions: ['holidays.manage' as const],
}
const SCHOOL = {
  id: SCHOOL_ID, name: 'Saraswati Vidya Mandir', shortName: 'SVM', board: 'cbse' as const,
  address: '12 Ring Road, Indore', phone: '+919876500001', email: 'office@svm.example.test', version: 7,
  allowedActions: ['school.update' as const],
}

beforeEach(() => {
  vi.clearAllMocks()
  setup.academicYears.mockResolvedValue([YEAR])
  setup.grades.mockResolvedValue([GRADE])
  setup.sections.mockResolvedValue([SECTION])
  setup.sectionStrengths.mockResolvedValue([{ sectionId: SECTION.id, count: 31 }])
  setup.subjects.mockResolvedValue([])
  setup.gradeSubjects.mockResolvedValue([])
  setup.holidays.mockResolvedValue([])
  setup.updateHoliday.mockResolvedValue({ ...HOLIDAY, version: 1789484912644900 })
  setup.school.mockResolvedValue(SCHOOL)
  staff.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 })
})

describe('Classes & sections', () => {
  it('shows the sections of the chosen class with their strengths', async () => {
    const Route = await loadRoute(() => import('@/routes/_app/setup/classes'))
    renderWithSession(<Route.component />, {
      capabilities: ['academic_years.read', 'grades.read', 'sections.read', 'sections.read_strengths', 'sections.manage', 'grades.manage'],
    })

    expect(await screen.findByText('Class 6 - A')).toBeInTheDocument()
    // The count shows twice: once beside the class in the list, once in the section row.
    await waitFor(() => expect(screen.getAllByText('31')).toHaveLength(2))
    expect(setup.sections).toHaveBeenCalledWith(SCHOOL_ID, { academicYearId: YEAR.id })
    expect(screen.getByRole('button', { name: /add section/i })).toBeInTheDocument()
  })

  it('hides every section control when the person cannot manage sections', async () => {
    setup.sections.mockResolvedValue([{ ...SECTION, allowedActions: [] }])
    const Route = await loadRoute(() => import('@/routes/_app/setup/classes'))
    renderWithSession(<Route.component />, {
      capabilities: ['academic_years.read', 'grades.read', 'sections.read'],
    })

    expect(await screen.findByText('Class 6 - A')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add section/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /actions for section a/i })).not.toBeInTheDocument()
    expect(setup.sectionStrengths).not.toHaveBeenCalled()
    expect(screen.getByText('Not set')).toBeInTheDocument()
  })

  it('says what to do when a class cannot be removed yet', async () => {
    const Route = await loadRoute(() => import('@/routes/_app/setup/classes'))
    renderWithSession(<Route.component />, { capabilities: ['academic_years.read', 'grades.read', 'sections.read', 'grades.manage'] })
    expect(await screen.findByText('Class 6 - A')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /actions for class 6/i })).toBeInTheDocument()
  })
})

describe('School profile', () => {
  it('sends every field with the version the editor was shown', async () => {
    setup.updateSchool.mockResolvedValue({ ...SCHOOL, version: 8 })
    const user = userEvent.setup()
    const Route = await loadRoute(() => import('@/routes/_app/setup/school'))
    const { queryClient } = renderWithSession(<Route.component />, { capabilities: ['school.read', 'school.update'] })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    const name = await screen.findByDisplayValue('Saraswati Vidya Mandir')
    await user.type(name, ' High School')
    // The header and the tab strip each carry a save button; either one submits the same form.
    await user.click(screen.getAllByRole('button', { name: 'Save changes' })[0]!)

    await waitFor(() => expect(setup.updateSchool).toHaveBeenCalled())
    expect(setup.updateSchool).toHaveBeenCalledWith(SCHOOL_ID, expect.objectContaining({
      name: 'Saraswati Vidya Mandir High School',
      phone: '+919876500001',
      expectedVersion: 7,
    }))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: [SCHOOL_ID, 'school'] }))
  })

  it('shows no save button when the person may only read the profile', async () => {
    setup.school.mockResolvedValue({ ...SCHOOL, allowedActions: [] })
    const Route = await loadRoute(() => import('@/routes/_app/setup/school'))
    renderWithSession(<Route.component />, { capabilities: ['school.read'] })

    // Without school.update the profile reads as values, not as a form full of dead inputs.
    expect(await screen.findByText('office@svm.example.test')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('Saraswati Vidya Mandir')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('button', { name: /^Save/ })).toHaveLength(0)
  })
})

describe('Holidays', () => {
  it('explains a refused read in one sentence', async () => {
    setup.holidays.mockRejectedValue(new ApiRequestError({ code: 'ACCESS_DENIED', status: 403, message: 'no' }))
    const Route = await loadRoute(() => import('@/routes/_app/setup/holidays'))
    renderWithSession(<Route.component />, { capabilities: ['academic_years.read', 'holidays.read'] })

    expect(await screen.findByText('You do not have permission to do this.')).toBeInTheDocument()
  })

  it('shows the empty state and no add button without holidays.manage', async () => {
    const Route = await loadRoute(() => import('@/routes/_app/setup/holidays'))
    renderWithSession(<Route.component />, { capabilities: ['academic_years.read', 'holidays.read'] })

    expect(await screen.findByText('No holidays yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add holiday/i })).not.toBeInTheDocument()
    await waitFor(() => expect(setup.holidays).toHaveBeenCalledWith(SCHOOL_ID, { academicYearId: YEAR.id }))
  })

  it('edits a holiday with the version the row carried and refreshes the list', async () => {
    setup.holidays.mockResolvedValue([HOLIDAY])
    const user = userEvent.setup()
    const Route = await loadRoute(() => import('@/routes/_app/setup/holidays'))
    const { queryClient } = renderWithSession(<Route.component />, {
      capabilities: ['academic_years.read', 'holidays.read', 'holidays.manage'],
    })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    await user.click(await screen.findByRole('button', { name: /actions for diwali/i }))
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }))
    await user.click(await screen.findByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(setup.updateHoliday).toHaveBeenCalledWith(SCHOOL_ID, HOLIDAY.id, {
      academicYearId: YEAR.id,
      name: 'Diwali',
      startDate: '2026-11-08',
      endDate: '2026-11-10',
      type: 'festival',
      expectedVersion: HOLIDAY.version,
    }))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: [SCHOOL_ID, 'holidays'] }))
  })
})

describe('Subjects', () => {
  it('hides the class mapping tab when classes cannot be read', async () => {
    setup.subjects.mockResolvedValue([{ id: 'sub-1', schoolId: SCHOOL_ID, name: 'Mathematics', code: 'MATH', type: 'scholastic', version: 1, allowedActions: [] }])
    const Route = await loadRoute(() => import('@/routes/_app/setup/subjects'))
    renderWithSession(<Route.component />, { capabilities: ['subjects.read', 'academic_years.read'] })

    expect(await screen.findByText('Mathematics')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /by class/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add subject/i })).not.toBeInTheDocument()
  })
})
