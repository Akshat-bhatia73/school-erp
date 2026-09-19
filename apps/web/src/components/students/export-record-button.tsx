import { useMutation } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import type { PermissionKey } from '@erp/contracts'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { SubjectAccess } from '@/lib/api/students'
import { describeError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { useSchoolContext } from '@/lib/session'

/** Hands the browser a file without ever putting the record in the page or the query cache. */
function saveJson(record: SubjectAccess, fileName: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/**
 * "Export this record": one audited read of everything the school holds about a student, saved as
 * a JSON file. The answer is never cached, so every click asks the server again and the record
 * only ever lives in the file the person chose to keep.
 */
export function ExportRecordButton({ studentId, admissionNumber, allowedActions, label = 'Export this record', variant = 'outline' }: {
  studentId: string
  admissionNumber: string
  /**
   * What the record itself says the person may do. Omit it where the screen has
   * no record to hand: the school-wide capability answers instead, rather than
   * fetching a whole student detail only to read one action from it.
   */
  allowedActions?: readonly PermissionKey[] | undefined
  label?: string
  variant?: 'outline' | 'ghost'
}) {
  const { schoolId, hasPermission } = useSchoolContext()
  const exportRecord = useMutation({
    mutationFn: () => api.students.subjectAccess(schoolId, studentId),
    onSuccess: (record) => {
      saveJson(record, `${admissionNumber}-record.json`)
      toast.success('Record downloaded')
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const permitted =
    allowedActions === undefined
      ? hasPermission('students.export_subject')
      : allows(allowedActions, 'students.export_subject')
  if (!permitted) return null

  return (
    <Button size="sm" variant={variant} disabled={exportRecord.isPending} onClick={() => exportRecord.mutate()}>
      <Download />{exportRecord.isPending ? 'Preparing…' : label}
    </Button>
  )
}
