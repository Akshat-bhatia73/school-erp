/**
 * Timetable screens on the real API.
 *
 * Each test fixes what the server answered and checks what the screen did with it: the week it
 * draws, the controls it hides when the record's allowedActions or the session capabilities do
 * not carry the key, the body a save sends, and the sentence a refusal produces. The API module
 * and the router are both mocked, so nothing here touches the network or a route tree.
 */
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithSession } from '@/test/session'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ApiRequestError } from '@/lib/http'

let searchParams: Record<string, string | undefined> = {}

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    createFileRoute: (id: string) => (options: Record<string, unknown>) => ({
      ...options,
      fullPath: id,
      useSearch: () => searchParams,
    }),
    useNavigate: () => () => Promise.resolve(),
    Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  }
})

const timetable = {
  bellSchedules: vi.fn(),
  bellScheduleForGrade: vi.fn(),
  createBellSchedule: vi.fn(),
  updateBellSchedule: vi.fn(),
  forSection: vi.fn(),
  forStaff: vi.fn(),
  freeTeachers: vi.fn(),
  setEntry: vi.fn(),
  clearEntry: vi.fn(),
  generate: vi.fn(),
  conflicts: vi.fn(),
  teacherLoads: vi.fn(),
  substitutions: vi.fn(),
  absentPeriods: vi.fn(),
  createSubstitution: vi.fn(),
  deleteSubstitution: vi.fn(),
  notifySubstitutions: vi.fn(),
  export: vi.fn(),
}
const setup = { academicYears: vi.fn(), grades: vi.fn(), sections: vi.fn(), gradeSubjects: vi.fn() }
const staff = { search: vi.fn() }
const files = { exportJob: vi.fn(), downloadExportFile: vi.fn() }

vi.mock('@/lib/api', () => ({ api: { timetable, setup, staff, files } }))

const SCHOOL_ID = '10000000-0000-4000-8000-000000000001'
const YEAR = { id: 'year-1', schoolId: SCHOOL_ID, name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', status: 'current' as const, version: 1 }
const GRADE = { id: 'grade-1', schoolId: SCHOOL_ID, name: 'Class 6', shortName: '6', order: 6, version: 1 }
const SECTION = { id: 'section-1', schoolId: SCHOOL_ID, gradeId: GRADE.id, academicYearId: YEAR.id, name: 'Six A', version: 1 }
const BELL = {
  id: 'bell-1', schoolId: SCHOOL_ID, academicYearId: YEAR.id, name: 'Regular day',
  gradeIds: [GRADE.id],
  periods: [{ index: 0, name: 'Period 1', startTime: '08:00', endTime: '08:40', type: 'period' as const }],
  workingDays: [1, 2], version: 1,
}
const CELL = {
  section: { id: SECTION.id, name: 'Six A' },
  subject: { id: 'subject-1', name: 'Mathematics' },
  teacher: { id: 'staff-1', name: 'Meera Joshi' },
  dayOfWeek: 1, periodIndex: 0,
}

function refusal() {
  return new ApiRequestError({ code: 'ACCESS_DENIED', status: 403, message: 'You do not have access to this.' })
}

beforeEach(() => {
  vi.clearAllMocks()
  searchParams = {}
  setup.academicYears.mockResolvedValue([YEAR])
  setup.grades.mockResolvedValue([GRADE])
  setup.sections.mockResolvedValue([SECTION])
  setup.gradeSubjects.mockResolvedValue([{ gradeId: GRADE.id, academicYearId: YEAR.id, subject: { id: 'subject-1', name: 'Mathematics' } }])
  timetable.bellSchedules.mockResolvedValue([BELL])
  timetable.bellScheduleForGrade.mockResolvedValue(BELL)
  timetable.forSection.mockResolvedValue({ cells: [CELL], allowedActions: [] })
  timetable.forStaff.mockResolvedValue({ cells: [CELL], allowedActions: [] })
  timetable.conflicts.mockResolvedValue([])
  timetable.teacherLoads.mockResolvedValue([])
  timetable.substitutions.mockResolvedValue({ substitutions: [], allowedActions: [] })
  timetable.absentPeriods.mockResolvedValue([])
  staff.search.mockResolvedValue([])
})

describe('Class timetable', () => {
  it('draws the week the server sent', async () => {
    searchParams = { gradeId: GRADE.id, sectionId: SECTION.id }
    const { Page } = await import('@/routes/_app/timetable/index')
    renderWithSession(<TooltipProvider><Page /></TooltipProvider>, {
      capabilities: ['academic_years.read', 'grades.read', 'sections.read', 'timetable.read'],
    })

    expect((await screen.findAllByText('Mathematics')).length).toBeGreaterThan(0)
    expect(screen.getByText('Meera Joshi')).toBeInTheDocument()
    expect(timetable.forSection).toHaveBeenCalledWith(SCHOOL_ID, SECTION.id, { academicYearId: YEAR.id })
  })

  it('exports the week on screen as Excel', async () => {
    searchParams = { gradeId: GRADE.id, sectionId: SECTION.id }
    timetable.export.mockResolvedValue({ id: 'job-1', status: 'queued' })
    files.exportJob.mockResolvedValue({ id: 'job-1', status: 'queued' })
    const { Page } = await import('@/routes/_app/timetable/index')
    renderWithSession(<TooltipProvider><Page /></TooltipProvider>, {
      capabilities: ['academic_years.read', 'grades.read', 'sections.read', 'timetable.read'],
    })

    // The toolbar renders its actions twice, once for the phone strip and once for wide screens.
    const [exportButton] = await screen.findAllByRole('button', { name: /export/i })
    await userEvent.click(exportButton!)
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Excel' }))

    await waitFor(() => expect(timetable.export).toHaveBeenCalledWith(SCHOOL_ID, {
      academicYearId: YEAR.id, format: 'xlsx', view: { kind: 'section', sectionId: SECTION.id },
    }))
  })

  it('hides Generate when the section does not allow it', async () => {
    searchParams = { gradeId: GRADE.id, sectionId: SECTION.id }
    const { Page } = await import('@/routes/_app/timetable/index')
    renderWithSession(<TooltipProvider><Page /></TooltipProvider>, {
      capabilities: ['academic_years.read', 'grades.read', 'sections.read', 'timetable.read'],
    })

    expect((await screen.findAllByText('Mathematics')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Generate from assignments')).not.toBeInTheDocument()
  })

  it('offers Generate when the section allows it and sends the year and a reason', async () => {
    searchParams = { gradeId: GRADE.id, sectionId: SECTION.id }
    timetable.forSection.mockResolvedValue({ cells: [CELL], allowedActions: ['timetable.manage_entries', 'timetable.generate'] })
    timetable.generate.mockResolvedValue({ placed: 6, unplaced: 1 })
    const { Page } = await import('@/routes/_app/timetable/index')
    const { queryClient } = renderWithSession(<TooltipProvider><Page /></TooltipProvider>, {
      capabilities: ['academic_years.read', 'grades.read', 'sections.read', 'timetable.read', 'timetable.generate'],
    })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    const [generateButton] = await screen.findAllByText('Generate from assignments')
    await userEvent.click(generateButton!)
    await userEvent.click(await screen.findByRole('button', { name: 'Generate' }))

    await waitFor(() => expect(timetable.generate).toHaveBeenCalledWith(SCHOOL_ID, SECTION.id, {
      academicYearId: YEAR.id, reason: 'Generated from teaching assignments',
    }))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: [SCHOOL_ID, 'timetable'] }))
  })

  it('says no periods are set up when the class has no bell schedule', async () => {
    searchParams = { gradeId: GRADE.id, sectionId: SECTION.id }
    timetable.bellScheduleForGrade.mockRejectedValue(new ApiRequestError({ code: 'RESOURCE_NOT_FOUND', status: 404, message: 'That record was not found.' }))
    const { Page } = await import('@/routes/_app/timetable/index')
    renderWithSession(<TooltipProvider><Page /></TooltipProvider>, {
      capabilities: ['academic_years.read', 'grades.read', 'sections.read', 'timetable.read'],
    })

    expect(await screen.findByText('No periods set up for this class')).toBeInTheDocument()
    expect(screen.queryByText('Set up periods')).not.toBeInTheDocument()
  })
})

describe('Bell schedule', () => {
  it('saves the version the person was looking at and invalidates the timetable', async () => {
    timetable.updateBellSchedule.mockResolvedValue({ ...BELL, version: 1 })
    const { Page } = await import('@/routes/_app/timetable/periods')
    const { queryClient } = renderWithSession(<Page />, {
      capabilities: ['academic_years.read', 'grades.read', 'timetable.read', 'timetable.manage_periods'],
    })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    const name = await screen.findByLabelText('Period 1 name')
    await userEvent.clear(name)
    await userEvent.type(name, 'First period')
    const [saveButton] = screen.getAllByRole('button', { name: 'Save changes' })
    await userEvent.click(saveButton!)

    await waitFor(() => expect(timetable.updateBellSchedule).toHaveBeenCalledWith(SCHOOL_ID, BELL.id, expect.objectContaining({
      expectedVersion: 1,
      academicYearId: YEAR.id,
      periods: [expect.objectContaining({ name: 'First period', index: 0 })],
    })))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: [SCHOOL_ID, 'timetable'] }))
  })

  it('gives a new period the next free index on a schedule that does not start at zero', async () => {
    const shifted = { ...BELL, periods: [{ index: 1, name: 'Period 1', startTime: '08:00', endTime: '08:40', type: 'period' as const }] }
    timetable.bellSchedules.mockResolvedValue([shifted])
    timetable.updateBellSchedule.mockResolvedValue(shifted)
    const { Page } = await import('@/routes/_app/timetable/periods')
    renderWithSession(<Page />, {
      capabilities: ['academic_years.read', 'grades.read', 'timetable.read', 'timetable.manage_periods'],
    })

    await userEvent.click(await screen.findByRole('button', { name: 'Add period' }))
    const [saveButton] = screen.getAllByRole('button', { name: 'Save changes' })
    await userEvent.click(saveButton!)

    await waitFor(() => expect(timetable.updateBellSchedule).toHaveBeenCalledWith(SCHOOL_ID, BELL.id, expect.objectContaining({
      periods: [expect.objectContaining({ index: 1 }), expect.objectContaining({ index: 2 })],
    })))
  })

  it('shows the working days as plain text without the manage periods permission', async () => {
    const { Page } = await import('@/routes/_app/timetable/periods')
    renderWithSession(<Page />, { capabilities: ['academic_years.read', 'grades.read', 'timetable.read'] })

    expect(await screen.findByText('Regular day')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mon' })).not.toBeInTheDocument()
  })

  it('shows no editing controls without the manage periods permission', async () => {
    const { Page } = await import('@/routes/_app/timetable/periods')
    renderWithSession(<Page />, {
      capabilities: ['academic_years.read', 'grades.read', 'timetable.read'],
    })

    expect(await screen.findByText('Regular day')).toBeInTheDocument()
    expect(screen.queryAllByRole('button', { name: 'Save changes' })).toHaveLength(0)
    expect(screen.queryByLabelText('Period 1 name')).not.toBeInTheDocument()
  })
})

describe('Teacher loads', () => {
  it('refuses in one sentence without the teacher loads permission', async () => {
    const { Page } = await import('@/routes/_app/timetable/teachers')
    renderWithSession(<Page />, { capabilities: ['timetable.read'] })

    expect(await screen.findByText('You can only see your own week, which is on your dashboard.')).toBeInTheDocument()
    expect(timetable.teacherLoads).not.toHaveBeenCalled()
  })

  it('keeps a cell whose period only one of the schedules declares', async () => {
    searchParams = { staffId: 'staff-1' }
    timetable.teacherLoads.mockResolvedValue([{ teacher: { id: 'staff-1', name: 'Meera Joshi' }, periodsPerWeek: 4, sectionsCount: 1, subjectsCount: 1 }])
    timetable.bellSchedules.mockResolvedValue([
      BELL,
      { ...BELL, id: 'bell-2', name: 'Wing 2', periods: [{ index: 1, name: 'Wing period', startTime: '09:00', endTime: '09:40', type: 'period' as const }] },
    ])
    timetable.forStaff.mockResolvedValue({ cells: [{ ...CELL, periodIndex: 1 }], allowedActions: [] })
    const { Page } = await import('@/routes/_app/timetable/teachers')
    renderWithSession(<Page />, {
      capabilities: ['academic_years.read', 'timetable.read', 'timetable.read_teacher_loads'],
    })

    expect(await screen.findByText('Wing period')).toBeInTheDocument()
    expect(screen.getAllByText('Mathematics').length).toBeGreaterThan(0)
  })

  it('lists the loads and loads the chosen teacher week', async () => {
    searchParams = { staffId: 'staff-1' }
    timetable.teacherLoads.mockResolvedValue([{ teacher: { id: 'staff-1', name: 'Meera Joshi' }, periodsPerWeek: 22, sectionsCount: 4, subjectsCount: 2 }])
    const { Page } = await import('@/routes/_app/timetable/teachers')
    renderWithSession(<Page />, {
      capabilities: ['academic_years.read', 'timetable.read', 'timetable.read_teacher_loads'],
    })

    expect(await screen.findByText('22 periods / week')).toBeInTheDocument()
    await waitFor(() => expect(timetable.forStaff).toHaveBeenCalledWith(SCHOOL_ID, 'staff-1', { academicYearId: YEAR.id }))
  })

  it('exports the teacher week on screen as a PDF', async () => {
    searchParams = { staffId: 'staff-1' }
    timetable.teacherLoads.mockResolvedValue([{ teacher: { id: 'staff-1', name: 'Meera Joshi' }, periodsPerWeek: 22, sectionsCount: 4, subjectsCount: 2 }])
    timetable.export.mockResolvedValue({ id: 'job-2', status: 'queued' })
    files.exportJob.mockResolvedValue({ id: 'job-2', status: 'queued' })
    const { Page } = await import('@/routes/_app/timetable/teachers')
    renderWithSession(<Page />, {
      capabilities: ['academic_years.read', 'timetable.read', 'timetable.read_teacher_loads'],
    })

    await userEvent.click(await screen.findByRole('button', { name: /export/i }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'PDF' }))

    await waitFor(() => expect(timetable.export).toHaveBeenCalledWith(SCHOOL_ID, {
      academicYearId: YEAR.id, format: 'pdf', view: { kind: 'teacher', staffId: 'staff-1' },
    }))
  })
})

describe('Substitutions', () => {
  it('hides the arranging controls when the day does not allow managing them', async () => {
    const { Page } = await import('@/routes/_app/timetable/substitutions')
    renderWithSession(<Page />, { capabilities: ['academic_years.read', 'timetable.read', 'staff.read_directory'] })

    expect(await screen.findByText('No one is away')).toBeInTheDocument()
    expect(screen.queryByText('Add absent teacher')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('button', { name: /Notify teachers/ })).toHaveLength(0)
  })

  it('notifies for the day and invalidates the timetable', async () => {
    timetable.substitutions.mockResolvedValue({
      substitutions: [{
        id: 'sub-1', date: '2026-09-15', section: { id: SECTION.id, name: 'Six A' },
        subject: { id: 'subject-1', name: 'Mathematics' },
        absentTeacher: { id: 'staff-1', name: 'Meera Joshi' }, substituteTeacher: null,
        periodIndex: 0, notified: false,
      }],
      allowedActions: ['timetable.manage_substitutions', 'timetable.notify_substitutions'],
    })
    timetable.notifySubstitutions.mockResolvedValue({ queued: 1 })
    searchParams = { date: '2026-09-15' }
    const { Page } = await import('@/routes/_app/timetable/substitutions')
    const { queryClient } = renderWithSession(<Page />, {
      capabilities: ['academic_years.read', 'timetable.read', 'staff.read_directory', 'timetable.manage_substitutions', 'timetable.notify_substitutions'],
    })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    const [notifyButton] = await screen.findAllByRole('button', { name: /Notify teachers/ })
    await userEvent.click(notifyButton!)

    await waitFor(() => expect(timetable.notifySubstitutions).toHaveBeenCalledWith(SCHOOL_ID, { date: '2026-09-15' }))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: [SCHOOL_ID, 'timetable'] }))
  })

  it('changing a substitute drops the current arrangement first', async () => {
    const existing = {
      id: 'sub-1', date: '2026-09-15', section: { id: SECTION.id, name: 'Six A' },
      subject: { id: 'subject-1', name: 'Mathematics' },
      absentTeacher: { id: 'staff-1', name: 'Meera Joshi' },
      substituteTeacher: { id: 'staff-2', name: 'Other Teacher' },
      periodIndex: 0, notified: false,
    }
    timetable.substitutions.mockResolvedValue({
      substitutions: [existing],
      allowedActions: ['timetable.manage_substitutions', 'timetable.notify_substitutions'],
    })
    timetable.absentPeriods.mockResolvedValue([{ ...CELL, dayOfWeek: 2, periodIndex: 0 }])
    timetable.freeTeachers.mockResolvedValue([{ teacher: { id: 'staff-3', name: 'Third Teacher' }, teachesSubject: true, periodsPerWeek: 3 }])
    timetable.deleteSubstitution.mockResolvedValue(undefined)
    timetable.createSubstitution.mockResolvedValue({ ...existing, id: 'sub-2' })
    searchParams = { date: '2026-09-15' }
    const { Page } = await import('@/routes/_app/timetable/substitutions')
    renderWithSession(<Page />, {
      capabilities: ['academic_years.read', 'timetable.read', 'staff.read_directory', 'timetable.manage_substitutions'],
    })

    await userEvent.click(await screen.findByRole('button', { name: 'Change' }))
    await userEvent.click(await screen.findByRole('button', { name: /Third Teacher/ }))

    await waitFor(() => expect(timetable.deleteSubstitution).toHaveBeenCalledWith(SCHOOL_ID, 'sub-1'))
    await waitFor(() => expect(timetable.createSubstitution).toHaveBeenCalledWith(SCHOOL_ID, expect.objectContaining({
      date: '2026-09-15', sectionId: SECTION.id, periodIndex: 0, substituteStaffId: 'staff-3',
    })))
  })

  it('shows one sentence when the day is refused', async () => {
    timetable.substitutions.mockRejectedValue(refusal())
    const { Page } = await import('@/routes/_app/timetable/substitutions')
    renderWithSession(<Page />, { capabilities: ['timetable.read'] })

    expect(await screen.findByText('You do not have permission to do this.')).toBeInTheDocument()
  })
})
