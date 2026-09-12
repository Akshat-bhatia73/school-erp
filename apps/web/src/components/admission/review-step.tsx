import { useQuery } from '@tanstack/react-query'
import { Facts, Panel } from '@/components/shared/page'
import { Tag, colorFor } from '@/components/shared/tag'
import { UserAvatar } from '@/components/shared/avatar'
import { Button } from '@/components/ui/button'
import { api } from '@/api/client'
import { qk } from '@/lib/query'
import { formatDate, humanize } from '@/lib/utils'
import type { AdmitDraft } from './admit-state'

const dash = <span className="text-muted-foreground/60">—</span>
const val = (s?: string) => (s && s.trim() ? s : dash)

export function ReviewStep({ draft, onEdit, yearId, yearName }: { draft: AdmitDraft; onEdit: (step: number) => void; yearId: string; yearName: string }) {
  const { data: grades = [] } = useQuery({ queryKey: qk.grades, queryFn: () => api.grades.list() })
  const { data: sections = [] } = useQuery({ queryKey: qk.sections({ academicYearId: yearId }), queryFn: () => api.sections.list({ academicYearId: yearId }), enabled: !!yearId })
  const grade = grades.find((g) => g.id === draft.gradeId)
  const section = sections.find((s) => s.id === draft.sectionId)
  const name = [draft.firstName, draft.lastName].filter(Boolean).join(' ') || 'New student'
  const editBtn = (step: number) => <Button variant="ghost" size="sm" onClick={() => onEdit(step)}>Edit</Button>

  return (
    <div className="space-y-4">
      <Panel>
        <div className="flex items-center gap-3">
          <UserAvatar name={name} src={draft.photoUrl || undefined} size="lg" />
          <div className="min-w-0">
            <p className="text-[16px] font-semibold">{name}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {grade && section && <Tag color={colorFor(grade.name)}>{grade.name} · {section.name}</Tag>}
              <Tag color="grey">{draft.admissionType === 'rte' ? 'RTE' : humanize(draft.admissionType)}</Tag>
              {draft.usesTransport && <Tag color="teal">Transport</Tag>}
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="Student details" actions={editBtn(0)}>
        <Facts
          items={[
            { label: 'Name', value: name },
            { label: 'Date of birth', value: draft.dateOfBirth ? formatDate(draft.dateOfBirth) : dash },
            { label: 'Gender', value: draft.gender ? humanize(draft.gender) : dash },
            { label: 'Blood group', value: draft.bloodGroup === 'unknown' ? dash : draft.bloodGroup },
            { label: 'Category', value: humanize(draft.category) },
            { label: 'Religion', value: val(draft.religion) },
            { label: 'Mother tongue', value: val(draft.motherTongue) },
            { label: 'Aadhaar last 4', value: val(draft.aadhaarLast4) },
          ]}
        />
      </Panel>

      <Panel title="Parents and guardians" actions={editBtn(1)}>
        <div className="space-y-4">
          {draft.guardians.map((g, i) => (
            <Facts
              key={i}
              items={[
                { label: humanize(g.relation), value: [g.firstName, g.lastName].filter(Boolean).join(' ') || dash },
                { label: 'Phone', value: val(g.phone) },
                { label: 'Email', value: val(g.email) },
                { label: 'Occupation', value: val(g.occupation) },
                { label: 'Primary contact', value: draft.primaryIndex === i ? 'Yes' : 'No' },
                { label: 'Address', value: g.sameAddress ? 'Same as student' : dash },
              ]}
            />
          ))}
        </div>
      </Panel>

      <Panel title="Class and admission" actions={editBtn(2)}>
        <Facts
          items={[
            { label: 'Academic year', value: yearName },
            { label: 'Class and section', value: grade && section ? `${grade.name} · ${section.name}` : dash },
            { label: 'Roll number', value: val(draft.rollNumber) },
            { label: 'Admission number', value: val(draft.admissionNumber) },
            { label: 'Admission date', value: draft.admissionDate ? formatDate(draft.admissionDate) : dash },
            { label: 'Admission type', value: draft.admissionType === 'rte' ? 'RTE' : humanize(draft.admissionType) },
            { label: 'Previous school', value: val(draft.previousSchool) },
            { label: 'Uses transport', value: draft.usesTransport ? 'Yes' : 'No' },
            { label: 'Address', value: [draft.address.line1, draft.address.line2, draft.address.city, draft.address.state, draft.address.pincode].filter(Boolean).join(', ') || dash },
            { label: 'Medical notes', value: val(draft.medicalNotes) },
          ]}
        />
      </Panel>
    </div>
  )
}
