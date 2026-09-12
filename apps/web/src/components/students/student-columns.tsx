import type { ColumnDef } from '@tanstack/react-table'
import type { StudentRow } from '@/api/client'
import { EntityCell } from '@/components/shared/data-table'
import { UserAvatar } from '@/components/shared/avatar'
import { colorFor, StatusDot, Tag } from '@/components/shared/tag'
import { ageFromDob, formatDate, fullName } from '@/lib/utils'

const ADMISSION_TAG: Record<string, { label: string; color: 'orange' | 'purple' | 'teal' } | undefined> = {
  rte: { label: 'RTE', color: 'orange' },
  staff_ward: { label: 'Staff ward', color: 'purple' },
  scholarship: { label: 'Scholarship', color: 'teal' },
}

export function classLabel(row: StudentRow) {
  if (!row.grade) return undefined
  return `${row.grade.shortName} - ${row.section?.name ?? '—'}`
}

export const studentColumns: ColumnDef<StudentRow, any>[] = [
  {
    id: 'student',
    header: 'Student',
    size: 260,
    cell: ({ row }) => (
      <EntityCell
        avatar={<UserAvatar name={fullName(row.original)} src={row.original.photoUrl} size="sm" />}
        name={fullName(row.original)}
        sub={row.original.admissionNumber}
      />
    ),
  },
  {
    id: 'class',
    header: 'Class',
    size: 110,
    cell: ({ row }) => {
      const label = classLabel(row.original)
      return label ? <Tag color={colorFor(row.original.grade!.name)}>{label}</Tag> : <span className="text-muted-foreground/60">—</span>
    },
  },
  { id: 'roll', header: 'Roll', size: 70, cell: ({ row }) => <span className="tabular-nums">{row.original.enrollment?.rollNumber ?? '—'}</span> },
  { id: 'gender', header: 'Gender', size: 76, cell: ({ row }) => <span>{row.original.gender === 'male' ? 'M' : row.original.gender === 'female' ? 'F' : 'O'}</span> },
  { id: 'age', header: 'Age', size: 64, cell: ({ row }) => <span className="tabular-nums">{ageFromDob(row.original.dateOfBirth)}</span> },
  {
    id: 'parent',
    header: 'Parent',
    size: 200,
    cell: ({ row }) => {
      const g = row.original.primaryGuardian
      if (!g) return <span className="text-muted-foreground/60">—</span>
      return (
        <div className="min-w-0">
          <div className="truncate">{fullName(g)}</div>
          <div className="truncate font-mono text-[12px] text-muted-foreground">{g.phone}</div>
        </div>
      )
    },
  },
  { id: 'category', header: 'Category', size: 96, cell: ({ row }) => <Tag className="uppercase">{row.original.category}</Tag> },
  {
    id: 'admissionType',
    header: 'Admission type',
    size: 130,
    cell: ({ row }) => {
      const t = ADMISSION_TAG[row.original.admissionType]
      return t ? <Tag color={t.color}>{t.label}</Tag> : <span className="text-muted-foreground/60">—</span>
    },
  },
  {
    id: 'status',
    header: 'Status',
    size: 92,
    cell: ({ row }) => (
      <span className="flex items-center gap-2">
        <StatusDot state={row.original.status === 'active' ? 'done' : 'warn'} title={row.original.status} />
        <span className="capitalize text-muted-foreground">{row.original.status}</span>
      </span>
    ),
  },
  { id: 'admitted', header: 'Admitted', size: 116, cell: ({ row }) => <span className="text-muted-foreground">{formatDate(row.original.admissionDate)}</span> },
]

/** Download the given students as a CSV, used by the bulk bar */
export function exportStudentsCsv(rows: StudentRow[]) {
  const head = ['Admission number', 'Name', 'Class', 'Roll', 'Gender', 'Date of birth', 'Parent', 'Parent phone', 'Category', 'Admission type', 'Status']
  const body = rows.map((r) => [
    r.admissionNumber, fullName(r), classLabel(r) ?? '', r.enrollment?.rollNumber ?? '', r.gender, r.dateOfBirth,
    r.primaryGuardian ? fullName(r.primaryGuardian) : '', r.primaryGuardian?.phone ?? '', r.category, r.admissionType, r.status,
  ])
  const csv = [head, ...body].map((line) => line.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `students-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
