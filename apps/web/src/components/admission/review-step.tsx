import { UserAvatar } from '@/components/shared/avatar'
import { Facts, Panel } from '@/components/shared/page'
import { colorFor, Tag } from '@/components/shared/tag'
import { useSectionOptions } from '@/components/students/use-section-options'
import { Button } from '@/components/ui/button'
import { METHOD_LABEL, PURPOSE_LABEL } from '@/lib/consent'
import { formatDate, humanize } from '@/lib/utils'
import type { AdmitDraft } from './admit-state'

const dash = <span className="text-muted-foreground/60">—</span>
const val = (value?: string) => (value && value.trim() !== '' ? value : dash)

/**
 * An identity number on the review screen is named, never shown. The office confirms it typed the
 * right one from the last digits, the same way every other screen in the app shows it.
 */
function ending(value: string, kind: 'aadhaar' | 'pan') {
  const cleaned = kind === 'aadhaar' ? value.replace(/\D/g, '') : value.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  if (cleaned.length < 4) return dash
  return <span className="font-mono">ending {cleaned.slice(-4)}</span>
}

export function ReviewStep({ draft, onEdit, academicYearId, yearName }: {
  draft: AdmitDraft
  onEdit: (step: number) => void
  academicYearId: string | null
  yearName: string
}) {
  const { options } = useSectionOptions(academicYearId)
  const section = options.find((option) => option.value === draft.sectionId)
  const name = [draft.firstName, draft.lastName].filter(Boolean).join(' ') || 'New student'
  const editButton = (step: number) => <Button variant="ghost" size="sm" onClick={() => onEdit(step)}>Edit</Button>

  return (
    <div className="space-y-4">
      <Panel>
        <div className="flex items-center gap-3">
          <UserAvatar name={name} size="lg" />
          <div className="min-w-0">
            <p className="text-[16px] font-semibold">{name}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {section && <Tag color={colorFor(section.label)}>{section.label}</Tag>}
              {draft.admissionType && <Tag color="grey">{humanize(draft.admissionType)}</Tag>}
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="Student details" actions={editButton(0)}>
        <Facts
          items={[
            { label: 'Name', value: name },
            { label: 'Date of birth', value: draft.dateOfBirth ? formatDate(draft.dateOfBirth) : dash },
            { label: 'Gender', value: draft.gender ? humanize(draft.gender) : dash },
            { label: 'Category', value: val(draft.category) },
            { label: 'Aadhaar', value: ending(draft.aadhaar, 'aadhaar') },
          ]}
        />
      </Panel>

      <Panel title="Parents and guardians" actions={editButton(1)}>
        <div className="space-y-4">
          {draft.guardians.map((guardian, index) => (
            <Facts
              key={index}
              items={
                guardian.mode === 'existing'
                  ? [
                      { label: humanize(guardian.relation), value: 'Guardian already on file' },
                      { label: 'Guardian id', value: val(guardian.guardianId) },
                      { label: 'Primary contact', value: draft.primaryIndex === index ? 'Yes' : 'No' },
                      { label: 'Gets messages', value: guardian.receivesNotifications ? 'Yes' : 'No' },
                    ]
                  : [
                      { label: humanize(guardian.relation), value: [guardian.firstName, guardian.lastName].filter(Boolean).join(' ') || dash },
                      { label: 'Phone', value: val(guardian.phone) },
                      { label: 'Occupation', value: val(guardian.occupation) },
                      { label: 'Office address', value: val(guardian.officeAddress) },
                      { label: 'PAN', value: ending(guardian.pan, 'pan') },
                      { label: 'Aadhaar', value: ending(guardian.aadhaar, 'aadhaar') },
                      { label: 'Primary contact', value: draft.primaryIndex === index ? 'Yes' : 'No' },
                      { label: 'Gets messages', value: guardian.receivesNotifications ? 'Yes' : 'No' },
                    ]
              }
            />
          ))}
        </div>
      </Panel>

      <Panel title="Consent" actions={editButton(2)}>
        <div className="space-y-4">
          {draft.guardians.map((guardian, index) => (
            <Facts
              key={index}
              items={[
                {
                  label: [guardian.firstName, guardian.lastName].filter(Boolean).join(' ') || humanize(guardian.relation),
                  value: guardian.consentPurposes.length === 0
                    ? 'Nothing recorded'
                    : guardian.consentPurposes.map((purpose) => PURPOSE_LABEL[purpose]).join(', '),
                },
                ...(guardian.consentPurposes.length > 0
                  ? [{ label: 'How it was given', value: METHOD_LABEL[guardian.consentMethod] }]
                  : []),
              ]}
            />
          ))}
        </div>
      </Panel>

      <Panel title="Class and admission" actions={editButton(3)}>
        <Facts
          items={[
            { label: 'Academic year', value: yearName },
            { label: 'Class and section', value: section ? section.label : dash },
            { label: 'Roll number', value: val(draft.rollNumber) },
            { label: 'Admission number', value: <span className="text-muted-foreground">Assigned when you save</span> },
            { label: 'Admission date', value: draft.admissionDate ? formatDate(draft.admissionDate) : dash },
            { label: 'Admission type', value: draft.admissionType ? humanize(draft.admissionType) : dash },
            { label: 'Address', value: val(draft.address) },
          ]}
        />
      </Panel>
    </div>
  )
}
