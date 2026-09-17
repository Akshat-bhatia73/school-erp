import type { ColumnDef } from '@tanstack/react-table'
import { UserAvatar } from '@/components/shared/avatar'
import { EntityCell } from '@/components/shared/data-table'
import { colorFor, Tag } from '@/components/shared/tag'
import type { StudentSummary } from '@/lib/api/students'
import { fullName } from '@/lib/utils'

/** "6 - A" from the enrollment the server sent, or nothing when there is no enrollment. */
export function classLabel(student: StudentSummary): string | undefined {
  const enrollment = student.enrollment
  if (!enrollment) return undefined
  return `${enrollment.grade.name} - ${enrollment.section.name}`
}

const STATUS_COLOR: Record<StudentSummary['status'], 'green' | 'grey' | 'orange'> = {
  active: 'green',
  left: 'grey',
  alumni: 'grey',
  suspended: 'orange',
}

export function StudentStatusTag({ status }: { status: StudentSummary['status'] }) {
  return <Tag className="capitalize" color={STATUS_COLOR[status]} dot>{status}</Tag>
}

/**
 * The roster columns. Everything here comes from the bounded list the server sent: the class is
 * rendered only when the row carries an enrollment, because a person who may not read enrollments
 * gets the row without one.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const studentColumns: ColumnDef<StudentSummary, any>[] = [
  {
    id: 'student',
    header: 'Student',
    size: 280,
    cell: ({ row }) => (
      <EntityCell
        avatar={<UserAvatar name={fullName(row.original)} size="sm" />}
        name={fullName(row.original)}
        sub={row.original.admissionNumber}
      />
    ),
  },
  {
    id: 'admissionNumber',
    header: 'Admission no',
    size: 150,
    cell: ({ row }) => <span className="font-mono text-[12.5px]">{row.original.admissionNumber}</span>,
  },
  {
    id: 'class',
    header: 'Class',
    size: 120,
    cell: ({ row }) => {
      const label = classLabel(row.original)
      if (!label) return <span className="text-muted-foreground/60">—</span>
      return <Tag color={colorFor(row.original.enrollment!.grade.name)}>{label}</Tag>
    },
  },
  {
    id: 'roll',
    header: 'Roll',
    size: 70,
    cell: ({ row }) => <span className="tabular-nums">{row.original.enrollment?.rollNumber ?? '—'}</span>,
  },
  {
    id: 'status',
    header: 'Status',
    size: 110,
    cell: ({ row }) => <StudentStatusTag status={row.original.status} />,
  },
]
