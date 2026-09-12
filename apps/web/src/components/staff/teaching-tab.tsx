import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { BookOpen } from 'lucide-react'
import { api, type StaffRow } from '@/api/client'
import { DataTable } from '@/components/shared/data-table'
import { EmptyState, Panel } from '@/components/shared/page'
import { Tag, colorFor } from '@/components/shared/tag'
import { qk } from '@/lib/query'
import { sectionLabel } from './shared'

type Row = Awaited<ReturnType<typeof api.staff.assignments>>[number]

export function TeachingTab({ staff }: { staff: StaffRow }) {
  const { data: assignments = [], isLoading } = useQuery({ queryKey: qk.staffAssignments(staff.id), queryFn: () => api.staff.assignments(staff.id) })

  const rows = useMemo(
    () => [...assignments].sort((a, b) => sectionLabel(a.grade?.name, a.section?.name ?? '').localeCompare(sectionLabel(b.grade?.name, b.section?.name ?? ''))),
    [assignments],
  )

  const columns = useMemo<ColumnDef<Row, any>[]>(() => [
    {
      id: 'class',
      header: 'Class',
      size: 120,
      cell: ({ row }) => {
        const label = sectionLabel(row.original.grade?.name, row.original.section?.name ?? '—')
        return <Tag color={colorFor(row.original.grade?.name ?? label)}>{label}</Tag>
      },
    },
    { id: 'subject', header: 'Subject', cell: ({ row }) => row.original.subject?.name ?? <span className="text-muted-foreground/60">—</span> },
    { id: 'room', header: 'Room', size: 140, cell: ({ row }) => row.original.section?.roomNumber ?? <span className="text-muted-foreground/60">—</span> },
  ], [])

  if (staff.staffType !== 'teaching') {
    return <EmptyState icon={<BookOpen />} title="No teaching assignments" description="This person is not teaching staff, so they do not have classes or subjects." />
  }

  const subjects = new Set(rows.map((r) => r.subjectId)).size
  const sections = new Set(rows.map((r) => r.sectionId)).size
  const classTeacherOf = staff.classTeacherOf ?? []

  return (
    <div className="space-y-4">
      <Panel title="Class teacher of" description={classTeacherOf.length ? undefined : 'Not a class teacher this year.'}>
        {classTeacherOf.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {classTeacherOf.map((c) => (
              <Tag key={c.section.id} color={colorFor(c.grade?.name ?? c.section.name)}>{sectionLabel(c.grade?.name, c.section.name)}</Tag>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Subjects taught" className="overflow-hidden" bodyClassName="p-0 pb-0">
        <DataTable
          columns={columns}
          data={rows}
          isLoading={isLoading}
          dense
          emptyState={<EmptyState icon={<BookOpen />} title="No subjects assigned yet" description="Assign subjects from the class timetable screen." />}
          footer={<span>Teaches {subjects} {subjects === 1 ? 'subject' : 'subjects'} across {sections} {sections === 1 ? 'section' : 'sections'}</span>}
        />
      </Panel>
    </div>
  )
}
