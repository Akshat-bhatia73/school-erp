/**
 * Admission screens after the server took over numbering.
 *
 * The office never types an admission number, so the form must not offer one, the review must say
 * where the number comes from, and the import review must show, per row, whether the school's own
 * number is kept or a new one is coming.
 */
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithSession } from '@/test/session'

const setup = { sections: vi.fn(), grades: vi.fn(), academicYears: vi.fn() }
vi.mock('@/lib/api', () => ({ api: { setup, students: {} } }))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => vi.fn(), Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a> }
})

const toUploadableJpeg = vi.fn()
vi.mock('@/components/shared/photo-field', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/shared/photo-field')>()
  return { ...actual, toUploadableJpeg: (file: File) => toUploadableJpeg(file) }
})

const { ClassStep } = await import('./class-step')
const { StudentStep } = await import('./student-step')
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
  toUploadableJpeg.mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' }))
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

describe('admission photograph', () => {
  const PHOTO = { prepared: new Blob(['jpeg'], { type: 'image/jpeg' }), preview: 'data:image/jpeg;base64,anBlZw==', fileName: 'aarav.png' }

  it('offers an optional photograph on the student step and says it needs consent', () => {
    renderWithSession(
      <StudentStep draft={filledDraft()} set={() => {}} errors={{}} photo={null} onPhoto={() => {}} />,
      { capabilities: [...CAPABILITIES] },
    )
    expect(screen.getByText('Photograph')).toBeInTheDocument()
    expect(screen.getByText("Needs the family's consent for photographs.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choose photograph' })).toBeInTheDocument()
  })

  it('keeps a chosen picture beside the draft, shrunk and ready, with a preview', async () => {
    const onPhoto = vi.fn()
    const set = vi.fn()
    const user = userEvent.setup()
    renderWithSession(
      <StudentStep draft={filledDraft()} set={set} errors={{}} photo={null} onPhoto={onPhoto} />,
      { capabilities: [...CAPABILITIES] },
    )
    const file = new File(['png'], 'aarav.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText('Choose photograph'), file)

    await waitFor(() => expect(onPhoto).toHaveBeenCalled())
    expect(toUploadableJpeg).toHaveBeenCalledWith(file)
    const chosen = onPhoto.mock.calls[0]?.[0]
    expect(chosen.fileName).toBe('aarav.png')
    expect(chosen.prepared.type).toBe('image/jpeg')
    expect(chosen.preview).toMatch(/^data:image\/jpeg;base64,/)
    // The draft never carries the picture.
    expect(set).not.toHaveBeenCalled()
  })

  it('refuses a picture that is too big once made smaller, in place', async () => {
    toUploadableJpeg.mockResolvedValueOnce(new Blob([new Uint8Array(1_048_577)], { type: 'image/jpeg' }))
    const onPhoto = vi.fn()
    const user = userEvent.setup()
    renderWithSession(
      <StudentStep draft={filledDraft()} set={() => {}} errors={{}} photo={null} onPhoto={onPhoto} />,
      { capabilities: [...CAPABILITIES] },
    )
    await user.upload(screen.getByLabelText('Choose photograph'), new File(['png'], 'big.png', { type: 'image/png' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a photo smaller than 1 MB.')
    expect(onPhoto).not.toHaveBeenCalled()
  })

  it('shows the chosen picture with a way to remove it', async () => {
    const onPhoto = vi.fn()
    const user = userEvent.setup()
    renderWithSession(
      <StudentStep draft={filledDraft()} set={() => {}} errors={{}} photo={PHOTO} onPhoto={onPhoto} />,
      { capabilities: [...CAPABILITIES] },
    )
    expect(screen.getByRole('img', { name: 'Aarav Sharma' })).toHaveAttribute('src', PHOTO.preview)
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onPhoto).toHaveBeenCalledWith(null)
  })

  it('warns on the review step when a photograph has no consent for photographs', async () => {
    renderWithSession(
      <ReviewStep draft={filledDraft()} onEdit={() => {}} academicYearId="year-1" yearName="2026-27" photo={PHOTO} />,
      { capabilities: [...CAPABILITIES] },
    )
    expect(await screen.findByText('The photograph will not be saved without consent for photographs.')).toBeInTheDocument()
  })

  it('says nothing more on the review step once a guardian agreed to photographs', async () => {
    const draft = filledDraft()
    draft.guardians = [{ ...draft.guardians[0]!, consentPurposes: ['photographs'] }]
    renderWithSession(
      <ReviewStep draft={draft} onEdit={() => {}} academicYearId="year-1" yearName="2026-27" photo={PHOTO} />,
      { capabilities: [...CAPABILITIES] },
    )
    expect(await screen.findByText('Chosen')).toBeInTheDocument()
    expect(screen.queryByText('The photograph will not be saved without consent for photographs.')).not.toBeInTheDocument()
  })
})
