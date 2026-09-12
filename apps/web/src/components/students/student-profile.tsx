import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { FileText, Plus, Upload, Users } from 'lucide-react'
import type { AcademicYear, Enrollment, Grade, Guardian, Section, Student, StudentDocument, StudentGuardian } from '@erp/shared'
import { api, type StudentRow } from '@/api/client'
import { UserAvatar } from '@/components/shared/avatar'
import { EmptyState, Facts, Panel } from '@/components/shared/page'
import { colorFor, StatusDot, Tag, type TagColor } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { qk } from '@/lib/query'
import { formatDate, fullName, humanize } from '@/lib/utils'

export type GuardianLink = Guardian & { link: StudentGuardian }
export type EnrollmentRow = Enrollment & { section?: Section; grade?: Grade; year?: AcademicYear }

const ADMISSION_LABEL: Record<string, string> = { regular: 'Regular', rte: 'RTE', staff_ward: 'Staff ward', scholarship: 'Scholarship' }

export function admissionTag(type: Student['admissionType']): { label: string; color: TagColor } | undefined {
  if (type === 'regular') return undefined
  const color: TagColor = type === 'rte' ? 'orange' : type === 'staff_ward' ? 'purple' : 'teal'
  return { label: ADMISSION_LABEL[type] ?? humanize(type), color }
}

export function OverviewTab({ student }: { student: StudentRow }) {
  const a = student.address
  return (
    <div className="grid gap-4">
      <Panel title="Personal">
        <Facts
          columns={3}
          items={[
            { label: 'Date of birth', value: formatDate(student.dateOfBirth) },
            { label: 'Gender', value: humanize(student.gender) },
            { label: 'Blood group', value: student.bloodGroup === 'unknown' ? undefined : student.bloodGroup },
            { label: 'Category', value: <span className="uppercase">{student.category}</span> },
            { label: 'Religion', value: student.religion },
            { label: 'Mother tongue', value: student.motherTongue },
            { label: 'Nationality', value: student.nationality },
            { label: 'Aadhaar last 4', value: student.aadhaarLast4 ? <span className="font-mono">•••• {student.aadhaarLast4}</span> : undefined },
            { label: 'APAAR ID', value: student.apaarId ? <span className="font-mono">{student.apaarId}</span> : undefined },
          ]}
        />
      </Panel>
      <Panel title="Address">
        <Facts
          columns={3}
          items={[
            { label: 'Address', value: [a.line1, a.line2].filter(Boolean).join(', ') },
            { label: 'City', value: a.city },
            { label: 'District', value: a.district },
            { label: 'State', value: a.state },
            { label: 'PIN code', value: <span className="tabular-nums">{a.pincode}</span> },
          ]}
        />
      </Panel>
      <Panel title="Admission">
        <Facts
          columns={3}
          items={[
            { label: 'Admission number', value: <span className="font-mono">{student.admissionNumber}</span> },
            { label: 'Admission date', value: formatDate(student.admissionDate) },
            { label: 'Admission type', value: ADMISSION_LABEL[student.admissionType] ?? humanize(student.admissionType) },
            { label: 'Previous school', value: student.previousSchool },
            { label: 'Transport', value: student.usesTransport ? 'Uses school bus' : 'Own arrangement' },
            { label: 'Medical notes', value: student.medicalNotes },
          ]}
        />
      </Panel>
    </div>
  )
}

export function GuardiansTab({ guardians, siblings, isLoading, canEdit, onAdd }: { guardians: GuardianLink[]; siblings: StudentRow[]; isLoading: boolean; canEdit: boolean; onAdd: () => void }) {
  return (
    <div className="grid gap-4">
      <Panel
        title="Parents and guardians"
        actions={canEdit ? <Button size="sm" variant="outline" onClick={onAdd}><Plus />Add guardian</Button> : undefined}
      >
        {isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {[0, 1].map((i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
          </div>
        ) : guardians.length === 0 ? (
          <EmptyState icon={<Users />} title="No guardians yet" description="Add a parent or guardian so the school can reach the family." className="py-10" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {guardians.map((g) => (
              <div key={g.id} className="rounded-xl border p-3.5">
                <div className="flex items-start gap-3">
                  <UserAvatar name={fullName(g)} src={g.photoUrl} size="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{fullName(g)}</span>
                      <Tag color={colorFor(g.link.relation)}>{humanize(g.link.relation)}</Tag>
                      {g.link.isPrimary && <Tag color="green">Primary</Tag>}
                    </div>
                    <div className="mt-1 font-mono text-[12.5px] text-muted-foreground">{g.phone}</div>
                    {g.email && <div className="truncate text-[12.5px] text-muted-foreground">{g.email}</div>}
                    {g.occupation && <div className="text-[12.5px] text-muted-foreground">{g.occupation}</div>}
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between border-t pt-3">
                  <span className="text-[12.5px] text-muted-foreground">Gets notifications</span>
                  <Switch checked={g.link.receivesNotifications} aria-label="Gets notifications" />
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Siblings" description="Students who share a guardian.">
        {siblings.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No siblings in this school.</p>
        ) : (
          <ul className="divide-y">
            {siblings.map((s) => (
              <li key={s.id}>
                <Link to="/students/$studentId" params={{ studentId: s.id }} className="flex items-center gap-3 py-2.5 hover:bg-accent/50">
                  <UserAvatar name={fullName(s)} src={s.photoUrl} size="sm" />
                  <span className="min-w-0 flex-1 truncate link-dotted font-medium">{fullName(s)}</span>
                  {s.grade && <Tag color={colorFor(s.grade.name)}>{s.grade.shortName} - {s.section?.name ?? '—'}</Tag>}
                  <span className="font-mono text-[12px] text-muted-foreground">{s.admissionNumber}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

export function DocumentsTab({ documents, isLoading }: { documents: StudentDocument[]; isLoading: boolean }) {
  return (
    <Panel
      title="Documents"
      actions={
        <Tooltip>
          <TooltipTrigger asChild>
            <span><Button size="sm" variant="outline" disabled><Upload />Upload document</Button></span>
          </TooltipTrigger>
          <TooltipContent>Uploads come with the backend</TooltipContent>
        </Tooltip>
      }
      bodyClassName="px-0 pb-0"
    >
      {isLoading ? (
        <div className="grid gap-2 px-4 pb-4">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}
        </div>
      ) : documents.length === 0 ? (
        <EmptyState icon={<FileText />} title="No documents on file" description="Birth certificate, transfer certificate and marksheets will show here." className="py-10" />
      ) : (
        <table className="w-full border-separate border-spacing-0 text-[13.5px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              {['Type', 'File name', 'Size', 'Verified', 'Uploaded'].map((h, i) => (
                <th key={h} className={`h-9 border-y px-3 font-medium ${i > 0 ? 'border-l' : ''}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {documents.map((d) => (
              <tr key={d.id}>
                <td className="h-10 border-b px-3">{humanize(d.type)}</td>
                <td className="h-10 border-b border-l px-3 font-mono text-[12.5px]">{d.fileName}</td>
                <td className="h-10 border-b border-l px-3 tabular-nums">{Math.round(d.sizeBytes / 1024)} KB</td>
                <td className="h-10 border-b border-l px-3"><StatusDot state={d.verified ? 'done' : 'empty'} title={d.verified ? 'Verified' : 'Not verified'} /></td>
                <td className="h-10 border-b border-l px-3 text-muted-foreground">{formatDate(d.createdAt.slice(0, 10))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  )
}

const OUTCOME: Record<Enrollment['outcome'], { label: string; color: TagColor }> = {
  ongoing: { label: 'Ongoing', color: 'green' },
  promoted: { label: 'Promoted', color: 'blue' },
  detained: { label: 'Detained', color: 'orange' },
  left: { label: 'Left', color: 'grey' },
}

export function HistoryTab({ enrollments, isLoading }: { enrollments: EnrollmentRow[]; isLoading: boolean }) {
  return (
    <Panel title="Class history">
      {isLoading ? (
        <div className="grid gap-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}
        </div>
      ) : enrollments.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No enrolment records yet.</p>
      ) : (
        <ol className="relative ml-1.5 border-l pl-5">
          {enrollments.map((e) => {
            const o = OUTCOME[e.outcome]
            return (
              <li key={e.id} className="relative pb-5 last:pb-0">
                <span className="absolute -left-[26px] top-1.5 size-2.5 rounded-full border-2 border-card bg-muted-foreground/50" />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{e.year?.name ?? 'Year'}</span>
                  <Tag color={o.color}>{o.label}</Tag>
                </div>
                <div className="mt-0.5 text-[13px] text-muted-foreground">
                  {e.grade?.name ?? '—'} - {e.section?.name ?? '—'}
                  {e.rollNumber !== undefined && <> · Roll {e.rollNumber}</>}
                  <> · Joined {formatDate(e.joinedOn)}</>
                  {e.leftOn && <> · Left {formatDate(e.leftOn)}</>}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </Panel>
  )
}

export function QuickFacts({ student, siblingCount }: { student: StudentRow; siblingCount: number }) {
  const sectionId = student.section?.id
  const { data: section } = useQuery({ queryKey: qk.sections({ id: sectionId }), queryFn: () => api.sections.get(sectionId!), enabled: !!sectionId })
  const teacherId = section?.classTeacherId
  const { data: teacher } = useQuery({ queryKey: qk.staffMember(teacherId ?? ''), queryFn: () => api.staff.get(teacherId!), enabled: !!teacherId })

  return (
    <div className="grid gap-4">
      <Panel title="Quick facts">
        <Facts
          columns={1}
          items={[
            { label: 'Class teacher', value: teacher ? <span className="flex items-center gap-2"><UserAvatar name={fullName(teacher)} size="xs" />{fullName(teacher)}</span> : undefined },
            { label: 'Room', value: section?.roomNumber },
            { label: 'Siblings in school', value: <span className="tabular-nums">{siblingCount}</span> },
          ]}
        />
      </Panel>
      <Panel title="Coming in Phase 2">
        <ul className="divide-y">
          {['Attendance this month', 'Fee dues', 'Last report card'].map((label) => (
            <li key={label} className="flex items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
              <span className="text-[13px] text-muted-foreground">{label}</span>
              <span className="flex items-center gap-2">
                <span className="text-muted-foreground/60">—</span>
                <Tag className="h-5 text-[11px]">Phase 2</Tag>
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  )
}
