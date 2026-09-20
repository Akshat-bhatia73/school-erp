/**
 * Admission screens after the server took over numbering.
 *
 * The office never types an admission number, so the form must not offer one, the review must say
 * where the number comes from, and the import review must show, per row, whether the school's own
 * number is kept or a new one is coming.
 */
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithSession } from '@/test/session'

const setup = { sections: vi.fn(), grades: vi.fn(), academicYears: vi.fn() }
vi.mock('@/lib/api', () => ({ api: { setup, students: {} } }))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => vi.fn(), Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a> }
})

const { ClassStep } = await import('./class-step')
const { ReviewStep } = await import('./review-step')
const { ConsentStep } = await import('./consent-step')
const { ImportReview } = await import('./import-review')
const { emptyDraft, emptyGuardian } = await import('./admit-state')

const SCHOOL_ID = '10000000-0000-4000-8000-000000000001'
const GRADE = { id: 'grade-1', schoolId: SCHOOL_ID, name: 'Class 6', shortName: '6', order: 6, version: 1 }
const SECTION = { id: 'section-1', schoolId: SCHOOL_ID, gradeId: GRADE.id, academicYearId: 'year-1', name: 'A', capacity: 40, version: 1 }
const CAPABILITIES = ['students.create', 'sections.read', 'grades.read'] as const

beforeEach(() => {
  vi.clearAllMocks()
  setup.grades.mockResolvedValue([GRADE])
  setup.sections.mockResolvedValue([SECTION])
})

function filledDraft() {
  return {
    ...emptyDraft(),
    firstName: 'Aarav',
    lastName: 'Sharma',
    dateOfBirth: '2015-05-14',
    gender: 'male' as const,
    sectionId: SECTION.id,
    guardians: [{ ...emptyGuardian('father'), firstName: 'Rakesh', phone: '9876543210' }],
  }
}

describe('admit form', () => {
  it('offers no admission number field, because the server assigns it', async () => {
    renderWithSession(
      <ClassStep draft={filledDraft()} set={() => {}} errors={{}} academicYearId="year-1" yearName="2026-27" />,
      { capabilities: [...CAPABILITIES] },
    )

    expect(await screen.findByText('Admission date')).toBeInTheDocument()
    expect(screen.queryByText('Admission number')).not.toBeInTheDocument()
  })

  it('tells the review step that the number arrives on save', async () => {
    renderWithSession(
      <ReviewStep draft={filledDraft()} onEdit={() => {}} academicYearId="year-1" yearName="2026-27" />,
      { capabilities: [...CAPABILITIES] },
    )

    expect(await screen.findByText('Admission number')).toBeInTheDocument()
    expect(screen.getByText('Assigned when you save')).toBeInTheDocument()
  })

  it('names the new identity numbers on the review step without showing them', async () => {
    const draft = filledDraft()
    draft.aadhaar = '2345 6789 0124'
    draft.guardians = [{ ...draft.guardians[0]!, pan: 'ABCDE1234F', aadhaar: '345678901234', officeAddress: '4 Mill Road' }]
    renderWithSession(
      <ReviewStep draft={draft} onEdit={() => {}} academicYearId="year-1" yearName="2026-27" />,
      { capabilities: [...CAPABILITIES] },
    )

    expect(await screen.findByText('ending 0124')).toBeInTheDocument()
    expect(screen.getByText('ending 234F')).toBeInTheDocument()
    expect(screen.getByText('ending 1234')).toBeInTheDocument()
    expect(screen.getByText('4 Mill Road')).toBeInTheDocument()
    // The whole numbers are never on the screen the office reads before saving.
    expect(screen.queryByText(/234567890124/)).not.toBeInTheDocument()
    expect(screen.queryByText('ABCDE1234F')).not.toBeInTheDocument()
    expect(screen.queryByText(/345678901234/)).not.toBeInTheDocument()
  })

  it('lists what each guardian agreed to on the review step', async () => {
    const draft = filledDraft()
    draft.guardians = [{ ...draft.guardians[0]!, consentPurposes: ['photographs'], consentMethod: 'signed_form' }]
    renderWithSession(
      <ReviewStep draft={draft} onEdit={() => {}} academicYearId="year-1" yearName="2026-27" />,
      { capabilities: [...CAPABILITIES] },
    )

    expect(await screen.findByText('Consent')).toBeInTheDocument()
    expect(screen.getByText('Photographs')).toBeInTheDocument()
    expect(screen.getByText('Signed form')).toBeInTheDocument()
  })
})

describe('consent step', () => {
  it('starts with nothing ticked and records the purpose the office ticked', async () => {
    const set = vi.fn()
    const user = userEvent.setup()
    renderWithSession(<ConsentStep draft={filledDraft()} set={set} errors={{}} />, { capabilities: [...CAPABILITIES] })

    expect(screen.getByText('Photographs')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Photographs for Rakesh/ })).not.toBeChecked()

    await user.click(screen.getByRole('checkbox', { name: /Photographs for Rakesh/ }))

    expect(set).toHaveBeenCalledWith({
      guardians: [expect.objectContaining({ consentPurposes: ['photographs'] })],
    })
  })
})

describe('import review', () => {
  const preview = {
    id: '20000000-0000-4000-8000-000000000001',
    version: 1,
    expiresAt: '2026-04-01T00:00:00.000Z',
    totalRows: 2,
    validRows: 2,
    rows: [
      { rowNumber: 1, firstName: 'Aarav', lastName: 'Sharma', admissionNumber: 'SVM/2025-26/102' },
      { rowNumber: 2, firstName: 'Diya', lastName: 'Verma' },
    ],
    errors: [],
  }

  it('shows the kept number for one row and a pending tag for the other', () => {
    renderWithSession(
      <ImportReview preview={preview} problems={[]} onBack={() => {}} onImport={() => {}} isImporting={false} />,
      { capabilities: ['students.import'] },
    )

    expect(screen.getByText('Rows ready to import')).toBeInTheDocument()
    expect(screen.getByText('SVM/2025-26/102')).toBeInTheDocument()
    expect(screen.getByText('Will be assigned')).toBeInTheDocument()
    expect(screen.getByText('Aarav Sharma')).toBeInTheDocument()
    expect(screen.getByText('2 students in view')).toBeInTheDocument()
  })

  it('says nothing is ready when the server rejected every row', () => {
    renderWithSession(
      <ImportReview
        preview={{ ...preview, validRows: 0, rows: [], errors: [{ row: 1, field: 'grade', message: 'No such class' }] }}
        problems={[]} onBack={() => {}} onImport={() => {}} isImporting={false}
      />,
      { capabilities: ['students.import'] },
    )

    expect(screen.getByText('No rows are ready yet')).toBeInTheDocument()
    expect(screen.getByText('No such class')).toBeInTheDocument()
  })
})
