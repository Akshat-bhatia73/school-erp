/**
 * What this person teaches, and — when the server allows it — an editor for those assignments.
 *
 * The list comes from the staff module; the pickers come from setup. Every write sends the staff
 * record's version, because the server bumps that record when an assignment changes.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { BookOpen, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { TeachingAssignmentRequest } from '@erp/contracts'
import { api } from '@/lib/api'
import type { TeachingAssignment } from '@/lib/api/staff'
import { DataTable } from '@/components/shared/data-table'
import { EmptyState, Panel } from '@/components/shared/page'
import { Tag, colorFor } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { describeError, isApiError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { formatDate } from '@/lib/utils'
import { focusFirstInvalid } from '@/lib/validation'
import { Field, SelectField, TextField, fieldErrorsFrom, type FieldErrors } from './form'
import { sectionLabel } from './shared'

export interface TeachingTabProps {
  staffId: string
  staffVersion: number
  canManage: boolean
}

export function TeachingTab({ staffId, staffVersion, canManage }: TeachingTabProps) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [removing, setRemoving] = useState<TeachingAssignment | null>(null)

  const assignmentsQuery = useQuery({
    queryKey: qk.staffAssignments(schoolId, staffId),
    queryFn: () => api.staff.assignments(schoolId, staffId),
  })

  const remove = useMutation({
    mutationFn: (assignmentId: string) => api.staff.unassign(schoolId, staffId, assignmentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'staff'] })
      toast.success('Removed the assignment')
      setRemoving(null)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const rows = useMemo(
    () => [...(assignmentsQuery.data ?? [])].sort((a, b) => a.section.name.localeCompare(b.section.name)),
    [assignmentsQuery.data],
  )

  const columns = useMemo<ColumnDef<TeachingAssignment, any>[]>(() => {
    const cols: ColumnDef<TeachingAssignment, any>[] = [
      {
        id: 'class',
        header: 'Class',
        size: 140,
        cell: ({ row }) => <Tag color={colorFor(row.original.section.name)}>{row.original.section.name}</Tag>,
      },
      { id: 'subject', header: 'Subject', cell: ({ row }) => row.original.subject.name },
      { id: 'from', header: 'From', size: 120, cell: ({ row }) => formatDate(row.original.validFrom) },
      {
        id: 'until',
        header: 'Until',
        size: 120,
        cell: ({ row }) => (row.original.validUntil ? formatDate(row.original.validUntil) : <span className="text-muted-foreground/60">Ongoing</span>),
      },
    ]
    if (canManage) {
      cols.push({
        id: 'actions',
        header: '',
        size: 60,
        cell: ({ row }) => (
          <Button variant="ghost" size="icon-sm" aria-label={`Remove ${row.original.subject.name}`} onClick={() => setRemoving(row.original)}>
            <Trash2 />
          </Button>
        ),
      })
    }
    return cols
  }, [canManage])

  if (isApiError(assignmentsQuery.error, 'ACCESS_DENIED')) {
    return <EmptyState icon={<BookOpen />} title="You cannot see teaching assignments" description="Ask the school owner if you need to see what this person teaches." />
  }

  if (assignmentsQuery.error) {
    return <EmptyState icon={<BookOpen />} title="We could not load teaching assignments" description={describeError(assignmentsQuery.error)} />
  }

  const subjects = new Set(rows.map((row) => row.subject.id)).size
  const sections = new Set(rows.map((row) => row.section.id)).size

  return (
    <div className="space-y-4">
      <Panel title="Teaching assignments" className="overflow-hidden" bodyClassName="p-0 pb-0">
        <DataTable
          columns={columns}
          data={rows}
          isLoading={assignmentsQuery.isLoading}
          dense
          mobileRow={(row: TeachingAssignment) => ({
            title: row.subject.name,
            subtitle: row.section.name,
            meta: <span>{formatDate(row.validFrom)}{row.validUntil ? ` – ${formatDate(row.validUntil)}` : ''}</span>,
          })}
          emptyState={<EmptyState icon={<BookOpen />} title="No subjects assigned yet" description={canManage ? 'Assign a class and a subject below.' : 'This person has no subjects assigned yet.'} />}
          footer={<span>Teaches {subjects} {subjects === 1 ? 'subject' : 'subjects'} across {sections} {sections === 1 ? 'section' : 'sections'}</span>}
        />
      </Panel>

      {canManage && <AssignmentEditor staffId={staffId} staffVersion={staffVersion} />}

      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this assignment?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing ? `${removing.subject.name} in ${removing.section.name} will no longer be taught by this person.` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={remove.isPending} onClick={() => { if (removing) remove.mutate(removing.id) }}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function AssignmentEditor({ staffId, staffVersion }: { staffId: string; staffVersion: number }) {
  const { schoolId, hasPermission } = useSchoolContext()
  const queryClient = useQueryClient()
  const { currentYearId, isLoading: yearLoading } = useAcademicYear()

  const [sectionId, setSectionId] = useState('')
  const [subjectId, setSubjectId] = useState('')
  const [validFrom, setValidFrom] = useState(new Date().toISOString().slice(0, 10))
  const [validUntil, setValidUntil] = useState('')
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})

  const sectionsQuery = useQuery({
    queryKey: qk.sections(schoolId, { academicYearId: currentYearId ?? undefined }),
    queryFn: () => api.setup.sections(schoolId, { academicYearId: currentYearId ?? undefined }),
    enabled: currentYearId !== null && hasPermission('sections.read'),
  })
  const gradesQuery = useQuery({
    queryKey: qk.grades(schoolId),
    queryFn: () => api.setup.grades(schoolId),
    enabled: hasPermission('grades.read'),
  })
  const subjectsQuery = useQuery({
    queryKey: qk.subjects(schoolId),
    queryFn: () => api.setup.subjects(schoolId),
    enabled: hasPermission('subjects.read'),
  })

  const gradeNames = useMemo(() => new Map((gradesQuery.data ?? []).map((grade) => [grade.id, grade.name])), [gradesQuery.data])
  const sectionOptions = useMemo(
    () => (sectionsQuery.data ?? []).map((section) => ({ value: section.id, label: sectionLabel(gradeNames.get(section.gradeId), section.name) })),
    [sectionsQuery.data, gradeNames],
  )
  const subjectOptions = useMemo(
    () => (subjectsQuery.data ?? []).map((subject) => ({ value: subject.id, label: subject.name })),
    [subjectsQuery.data],
  )

  const assign = useMutation({
    mutationFn: (body: Parameters<typeof api.staff.assign>[2]) => api.staff.assign(schoolId, staffId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'staff'] })
      toast.success('Saved the assignment')
      setSubjectId('')
      setReason('')
    },
    onError: (error) => toast.error(describeError(error)),
  })

  function onAssign() {
    const parsed = TeachingAssignmentRequest.safeParse({
      expectedVersion: staffVersion,
      staffId,
      sectionId,
      subjectId,
      academicYearId: currentYearId ?? '',
      validFrom,
      validUntil: validUntil === '' ? null : validUntil,
      reason,
    })
    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error))
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }
    setErrors({})
    assign.mutate(parsed.data)
  }

  const pickersReadable = hasPermission('sections.read') && hasPermission('subjects.read')

  if (yearLoading) return null
  if (!pickersReadable) {
    return (
      <Panel title="Assign a class and subject">
        <p className="text-[13px] text-muted-foreground">You cannot see the school’s classes and subjects, so assignments cannot be changed here.</p>
      </Panel>
    )
  }
  if (currentYearId === null) {
    return (
      <Panel title="Assign a class and subject">
        <p className="text-[13px] text-muted-foreground">We could not work out the current academic year, so assignments cannot be changed here.</p>
      </Panel>
    )
  }

  return (
    <Panel title="Assign a class and subject" description="Assignments belong to the current academic year.">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SelectField label="Class" value={sectionId} onChange={setSectionId} options={sectionOptions} error={errors.sectionId} />
        <SelectField label="Subject" value={subjectId} onChange={setSubjectId} options={subjectOptions} error={errors.subjectId} />
        <TextField label="From" type="date" value={validFrom} onChange={setValidFrom} error={errors.validFrom} />
        <TextField label="Until" type="date" value={validUntil} onChange={setValidUntil} error={errors.validUntil} hint="Leave empty while the assignment continues." />
        <Field label="Reason for this change" error={errors.reason} className="sm:col-span-2">
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} placeholder="Covering Class 6 science this term" />
        </Field>
      </div>
      <div className="mt-4 flex items-center justify-end gap-3">
        {assign.isPending && <span className="text-[12.5px] text-muted-foreground">Saving…</span>}
        <Button size="sm" onClick={onAssign} disabled={assign.isPending}>Save assignment</Button>
      </div>
    </Panel>
  )
}
