import type { ReactElement, ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_GRADE_BANDS, DEFAULT_REPORT_CARD_LAYOUT, ReportCardContent, type PermissionKey } from '@erp/contracts'
import { toast } from 'sonner'
import { describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '@/lib/http'
import { renderWithSession } from '@/test/session'
import { parseCell } from './marks-grid'
import { ReportCard } from './report-card'
import { sampleCard } from './sample-card'

describe('a marks sheet cell', () => {
  it('takes a mark with at most one decimal, up to the component maximum', () => {
    expect(parseCell('7.5', 'periodic_test')).toBe(7.5)
    expect(parseCell('', 'written')).toBeNull()
    expect(parseCell('absent', 'written')).toBe('absent')
    expect(parseCell('10.5', 'periodic_test')).toBe('invalid')
    expect(parseCell('7.25', 'written')).toBe('invalid')
    expect(parseCell('six', 'notebook')).toBe('invalid')
  })
})

describe('the report card', () => {
  it('builds a sample that matches the contract', () => {
    const { content } = sampleCard({ displayMode: 'marks', gradeBands: DEFAULT_GRADE_BANDS, layout: DEFAULT_REPORT_CARD_LAYOUT })
    expect(ReportCardContent.safeParse(content).success).toBe(true)
  })

  it('shows marks in marks mode and grades alone in grades mode', () => {
    const marks = sampleCard({ displayMode: 'marks', gradeBands: DEFAULT_GRADE_BANDS, layout: DEFAULT_REPORT_CARD_LAYOUT, schoolName: 'SVM' })
    const { unmount } = render(<ReportCard content={marks.content} remarks={marks.remarks} />)
    expect(screen.getAllByText('Written exam (80)').length).toBeGreaterThan(0)
    expect(screen.getByText('SVM')).toBeInTheDocument()
    unmount()

    const grades = sampleCard({ displayMode: 'grades', gradeBands: DEFAULT_GRADE_BANDS, layout: DEFAULT_REPORT_CARD_LAYOUT })
    render(<ReportCard content={grades.content} remarks={grades.remarks} />)
    expect(screen.queryByText('Written exam (80)')).not.toBeInTheDocument()
    expect(screen.queryByText('Total')).not.toBeInTheDocument()
  })

  it('draws only the blocks the layout names, in its order', () => {
    const layout = { ...DEFAULT_REPORT_CARD_LAYOUT, blocks: ['remarks', 'scholastic'] as const }
    const card = sampleCard({ displayMode: 'marks', gradeBands: DEFAULT_GRADE_BANDS, layout: { ...layout, blocks: [...layout.blocks] } })
    render(<ReportCard content={card.content} remarks={card.remarks} />)
    const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)
    expect(headings).toEqual(["Class teacher's remarks", 'Scholastic areas'])
  })
})

// ---------------------------------------------------------------------------
// The marks sheet screen, on a mocked API and router.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    createFileRoute: () => (options: Record<string, unknown>) => ({ ...options, useParams: () => ({ paperId: 'paper-1' }) }),
    Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  }
})

// Hoisted with the mock, because the grid imported at the top already imports the API.
const { exams, files } = vi.hoisted(() => ({
  exams: { sheet: vi.fn(), saveMarks: vi.fn(), correct: vi.fn(), history: vi.fn(), exportRegister: vi.fn() },
  files: { exportJob: vi.fn(), downloadExportFile: vi.fn() },
}))
vi.mock('@/lib/api', () => ({ api: { exams, files } }))

const ACTIONS: PermissionKey[] = ['exams.read', 'exams.record_marks']

/** Pupil one has a mark at revision 3; pupil two has none yet. */
function sheetResponse() {
  return {
    paper: {
      id: 'paper-1',
      exam: { id: 'exam-1', kind: 'periodic_test_1', term: 'term_1', startsOn: '2026-09-20', endsOn: '2026-09-21', recheckDeadline: '2026-09-30' },
      section: { id: 'section-1', name: 'A' },
      grade: { id: 'grade-1', name: 'Class 6' },
      subject: { id: 'subject-1', name: 'Mathematics' },
      pupils: 2,
      entered: 1,
      expected: 2,
      window: { state: 'open', record: true, correct: false },
      published: false,
      allowedActions: ACTIONS,
    },
    components: [{ key: 'periodic_test', label: 'Periodic test', maxMarks: 10 }],
    rows: [
      {
        student: { id: 'student-1', name: 'Aarav Sharma', admissionNumber: 'SVM/2026/101', rollNumber: 1 },
        cells: [{ component: 'periodic_test', value: 8, revision: 3, kind: 'entry', recordedAt: '2026-09-22T09:00:00.000+05:30' }],
      },
      { student: { id: 'student-2', name: 'Diya Nair', admissionNumber: 'SVM/2026/102', rollNumber: 2 }, cells: [] },
    ],
  }
}

describe('the marks sheet', () => {
  it('sends the revision of every cell it read, and refetches when somebody saved first', async () => {
    exams.sheet.mockResolvedValue(sheetResponse())
    exams.saveMarks.mockRejectedValue(new ApiRequestError({ code: 'VERSION_CONFLICT', status: 409, message: 'Conflict.' }))
    const { Route } = await import('@/routes/_app/exams/papers/$paperId')
    const Screen = (Route as unknown as { component: () => ReactElement }).component
    renderWithSession(<Screen />, { schoolId: '10000000-0000-4000-8000-000000000001', capabilities: ACTIONS, roleKeys: ['teacher'] })

    await userEvent.type(await screen.findByLabelText('Periodic test for Diya Nair'), '6')
    // The header draws its actions twice, for wide and narrow screens.
    await userEvent.click(screen.getAllByText('Save marks')[0]!)

    await waitFor(() => expect(exams.saveMarks).toHaveBeenCalled())
    const body = exams.saveMarks.mock.calls[0]?.[2] as { entries: unknown[] }
    expect(body.entries).toEqual([
      { studentId: 'student-1', component: 'periodic_test', value: 8, expectedRevision: 3 },
      { studentId: 'student-2', component: 'periodic_test', value: 6, expectedRevision: 0 },
    ])
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Somebody else saved these marks first')))
    expect(screen.getByRole('alert')).toHaveTextContent('The latest marks are now shown')
    await waitFor(() => expect(exams.sheet).toHaveBeenCalledTimes(2))
  })
})
