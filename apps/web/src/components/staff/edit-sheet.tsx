import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { Staff, StaffInput } from '@erp/shared'
import { api } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { SectionLabel } from '@/components/shared/page'
import { qk } from '@/lib/query'
import { AddressFields, EmploymentFields, PayFields, PersonalFields, StatusFields, draftFromStaff, validateDraft, type FieldErrors, type StaffDraft } from './form'

export function StaffEditSheet({ staff, open, onOpenChange, showPay }: { staff: Staff; open: boolean; onOpenChange: (v: boolean) => void; showPay: boolean }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<StaffDraft>(() => draftFromStaff(staff))
  const [errors, setErrors] = useState<FieldErrors>({})
  const set = (p: Partial<StaffDraft>) => setDraft((d) => ({ ...d, ...p }))
  const { data: departments = [] } = useQuery({ queryKey: qk.departments, queryFn: () => api.staff.departments() })

  const save = useMutation({
    mutationFn: (input: StaffInput) => api.staff.update(staff.id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.staffMember(staff.id) })
      qc.invalidateQueries({ queryKey: ['staff'] })
      toast.success('Saved changes')
      onOpenChange(false)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  function onSave() {
    const result = validateDraft(draft)
    if (!result.ok) {
      setErrors(result.errors)
      toast.error('Check the highlighted fields')
      return
    }
    setErrors({})
    save.mutate(result.value)
  }

  return (
    <Sheet open={open} onOpenChange={(v) => { if (v) setDraft(draftFromStaff(staff)); onOpenChange(v) }}>
      <SheetContent className="flex w-full flex-col sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Edit staff member</SheetTitle>
          <SheetDescription>Changes are saved to the staff record straight away.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-2 overflow-auto px-4 pb-2 scrollbar-thin">
          <SectionLabel className="px-0">Personal</SectionLabel>
          <PersonalFields d={draft} set={set} errors={errors} />
          <SectionLabel className="px-0">Employment</SectionLabel>
          <EmploymentFields d={draft} set={set} errors={errors} departments={departments} />
          <SectionLabel className="px-0">Status</SectionLabel>
          <StatusFields d={draft} set={set} errors={errors} />
          {showPay && (
            <>
              <SectionLabel className="px-0">Pay & bank</SectionLabel>
              <PayFields d={draft} set={set} errors={errors} />
            </>
          )}
          <SectionLabel className="px-0">Address</SectionLabel>
          <AddressFields d={draft} set={set} errors={errors} />
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={onSave} disabled={save.isPending}>Save changes</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
