/**
 * The subject-access export control, on the student profile and on the parent home.
 *
 * The control exists only when the record itself says so, every click asks the server again, and
 * the answer leaves as a file named by admission number instead of landing in the query cache.
 */
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiRequestError } from '@/lib/http'
import { renderWithSession } from '@/test/session'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    createFileRoute: () => (options: unknown) => options,
    Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
    useNavigate: () => vi.fn(),
  }
})

const subjectAccess = vi.fn()
const studentGet = vi.fn()
const studentConsents = vi.fn()
const forSection = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    students: {
      subjectAccess: (...args: unknown[]) => subjectAccess(...args),
      get: (...args: unknown[]) => studentGet(...args),
      consents: (...args: unknown[]) => studentConsents(...args),
      recordConsent: vi.fn(),
      revealApaar: vi.fn(),
    },
    timetable: { forSection: (...args: unknown[]) => forSection(...args) },
  },
}))

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) } }))

const SCHOOL = '10000000-0000-4000-8000-000000000001'
const STUDENT = {
  id: 'st-1', schoolId: SCHOOL, version: 1, firstName: 'Aarav', lastName: 'Sharma',
  admissionNumber: 'SVM/2026/101', status: 'active' as const, anonymised: false,
}
const EXPORT = { generatedAt: '2026-09-18T06:00:00.000Z', schoolId: SCHOOL, student: STUDENT, guardians: [], enrollments: [], documents: [], consents: [] }

/** Records what the browser was asked to save, since jsdom cannot really download anything. */
let saved: { href: string; download: string } | null = null
const created: string[] = []
const revoked: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  saved = null
  created.length = 0
  revoked.length = 0
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:record-${created.length}`
    created.push(url)
    return url
  })
  URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url) })
  // jsdom refuses a real navigation; the click only needs to report what was on the anchor.
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    saved = { href: this.href, download: this.download }
  }
  subjectAccess.mockResolvedValue(EXPORT)
  studentGet.mockResolvedValue({ student: STUDENT, allowedActions: ['students.export_subject'] })
  studentConsents.mockResolvedValue({ items: [], allowedActions: [] })
  forSection.mockResolvedValue({ cells: [], allowedActions: [] })
})

describe('Export this record', () => {
  it('is not rendered when the record does not allow it', async () => {
    const { OverviewTab } = await import('./student-profile')
    renderWithSession(
      <OverviewTab detail={{ student: STUDENT, allowedActions: ['students.read_basic'] } as never} showGuardianContacts={false} />,
      { capabilities: ['students.read_basic'] },
    )

    expect(screen.getByText('Aarav Sharma')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /export this record/i })).not.toBeInTheDocument()
  })

  it('fetches the export on click and saves it as a file named by admission number', async () => {
    const user = userEvent.setup()
    const { OverviewTab } = await import('./student-profile')
    renderWithSession(
      <OverviewTab detail={{ student: STUDENT, allowedActions: ['students.read_basic', 'students.export_subject'] } as never} showGuardianContacts={false} />,
      { capabilities: ['students.read_basic', 'students.export_subject'] },
    )

    await user.click(screen.getByRole('button', { name: /export this record/i }))

    await waitFor(() => expect(subjectAccess).toHaveBeenCalledWith(SCHOOL, 'st-1'))
    expect(saved?.download).toBe('SVM/2026/101-record.json')
    expect(saved?.href).toContain('blob:record-0')
    expect(toastSuccess).toHaveBeenCalledWith('Record downloaded')
    // The object URL is released, so nothing keeps the record alive in the page.
    expect(revoked).toEqual(created)
  })

  it('asks the server again on every click and never caches the answer', async () => {
    const user = userEvent.setup()
    const { OverviewTab } = await import('./student-profile')
    renderWithSession(
      <OverviewTab detail={{ student: STUDENT, allowedActions: ['students.export_subject'] } as never} showGuardianContacts={false} />,
      { capabilities: ['students.export_subject'] },
    )

    const button = screen.getByRole('button', { name: /export this record/i })
    await user.click(button)
    await waitFor(() => expect(subjectAccess).toHaveBeenCalledTimes(1))
    await user.click(button)
    await waitFor(() => expect(subjectAccess).toHaveBeenCalledTimes(2))
  })

  it('says one sentence when the export is refused and saves nothing', async () => {
    subjectAccess.mockRejectedValue(new ApiRequestError({ code: 'ACCESS_DENIED', status: 403, message: 'no' }))
    const user = userEvent.setup()
    const { OverviewTab } = await import('./student-profile')
    renderWithSession(
      <OverviewTab detail={{ student: STUDENT, allowedActions: ['students.export_subject'] } as never} showGuardianContacts={false} />,
      { capabilities: ['students.export_subject'] },
    )

    await user.click(screen.getByRole('button', { name: /export this record/i }))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('You do not have permission to do this.'))
    expect(saved).toBeNull()
  })
})

describe("Download my child's record", () => {
  const child = { ...STUDENT, id: 'st-1', firstName: 'Student', lastName: 'B' }

  it('is offered on the child card when the parent may export, without reading the record first', async () => {
    const user = userEvent.setup()
    const { ParentDashboard } = await import('@/components/dashboard/parent-dashboard')
    renderWithSession(<ParentDashboard students={[child] as never} />, { roleKeys: ['parent'], capabilities: ['students.read_basic', 'students.export_subject'] })

    await user.click(await screen.findByRole('button', { name: /download my child's record/i }))

    await waitFor(() => expect(subjectAccess).toHaveBeenCalledWith(SCHOOL, 'st-1'))
    expect(saved?.download).toBe('SVM/2026/101-record.json')
    // Showing the button must not cost an audited read of the child's record.
    expect(studentGet).not.toHaveBeenCalled()
  })

  it('is not offered when the parent may not export', async () => {
    const { ParentDashboard } = await import('@/components/dashboard/parent-dashboard')
    renderWithSession(<ParentDashboard students={[child] as never} />, { roleKeys: ['parent'], capabilities: ['students.read_basic'] })

    expect(await screen.findByText('Student B')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /download my child's record/i })).not.toBeInTheDocument()
  })
})
