import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ShieldOff } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { AnonymiseRequest } from '@erp/contracts'
import { Panel } from '@/components/shared/page'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import type { StaffDetail } from '@/lib/api/staff'
import { useSchoolContext } from '@/lib/session'

/**
 * Clearing the private and pay fields of somebody who left. The server refuses while the eight
 * year period is still running, so this only ever asks.
 */
export function StaffAnonymisePanel({ staff }: { staff: StaffDetail['staff'] }) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const anonymise = useMutation({
    mutationFn: (body: Parameters<typeof api.staff.anonymise>[2]) => api.staff.anonymise(schoolId, staff.id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'staff'] })
      toast.success('Record anonymised')
      setOpen(false)
    },
    onError: (mutationError) => toast.error(describeError(mutationError)),
  })

  const submit = () => {
    const parsed = AnonymiseRequest.safeParse({ expectedVersion: staff.version, reason: reason.trim() })
    if (!parsed.success) {
      setError('Say why this record is being anonymised.')
      return
    }
    setError(null)
    anonymise.mutate(parsed.data)
  }

  return (
    <Panel title="Anonymise record" description="For somebody who left long enough ago that the school no longer needs their personal details.">
      <p className="text-[13px] text-muted-foreground">
        The name, employee code, designation, department, joining and leaving dates stay. Phone, email, address,
        date of birth, salary, bank and PAN details are cleared for good.
      </p>
      <Button className="mt-3" variant="destructive" size="sm" onClick={() => { setReason(''); setError(null); setOpen(true) }}>
        <ShieldOff />Anonymise record
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Anonymise this record?</AlertDialogTitle>
            <AlertDialogDescription>
              What stays: name, employee code, designation, department, employment dates and status.
              What goes, permanently: phone, email, address, date of birth, blood group, salary, bank account and PAN.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1.5 px-1">
            <Label>Reason</Label>
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Retention period is over" />
            {error && <p className="text-[12px] text-destructive">{error}</p>}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={anonymise.isPending} onClick={submit}>
              {anonymise.isPending ? 'Anonymising…' : 'Anonymise record'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  )
}
