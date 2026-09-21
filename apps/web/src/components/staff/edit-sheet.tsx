/**
 * One edit sheet per field group, because the server authorizes each group on its own.
 *
 * Each sheet is only rendered when the record's own `allowedActions` carries the matching key, and
 * every save sends the version the person was looking at.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { StaffUpdateEmploymentRequest, UpdateStaffPayRequest, UpdateStaffPrivateRequest } from '@erp/contracts'
import { api } from '@/lib/api'
import type { StaffDetail } from '@/lib/api/staff'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { describeError } from '@/lib/api-errors'
import { focusFirstInvalid } from '@/lib/validation'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { Datalist, Field, SelectField, TextField, fieldErrorsFrom, type FieldErrors } from './form'
import { employmentOptions, statusOptions, type EmploymentTypeValue, type StaffStatusValue } from './shared'

interface SheetProps {
  detail: StaffDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}

function useSaveStaff(onDone: () => void) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  return { schoolId, queryClient, onSaved: () => {
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'staff'] })
    toast.success('Saved changes')
    onDone()
  } }
}

export function StaffEmploymentSheet({ detail, open, onOpenChange }: SheetProps) {
  const { staff, employment } = detail
  const { schoolId, onSaved } = useSaveStaff(() => onOpenChange(false))
  const [errors, setErrors] = useState<FieldErrors>({})
  const [designation, setDesignation] = useState(staff.designation)
  const [department, setDepartment] = useState(staff.department ?? '')
  const [employmentType, setEmploymentType] = useState<EmploymentTypeValue>(employment?.employmentType ?? 'permanent')
  const [status, setStatus] = useState<StaffStatusValue>(employment?.status ?? 'active')
  const [joiningDate, setJoiningDate] = useState(employment?.joiningDate ?? '')
  const [leavingDate, setLeavingDate] = useState('')

  const { data: departments = [] } = useQuery({
    queryKey: qk.departments(schoolId),
    queryFn: () => api.staff.departments(schoolId),
    enabled: open,
  })

  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.staff.updateEmployment>[2]) => api.staff.updateEmployment(schoolId, staff.id, body),
    onSuccess: onSaved,
    onError: (error) => toast.error(describeError(error)),
  })

  function onSave() {
    const parsed = StaffUpdateEmploymentRequest.safeParse({
      expectedVersion: staff.version,
      designation: designation.trim(),
      department: department.trim() === '' ? null : department.trim(),
      employmentType,
      status,
      ...(joiningDate === '' ? {} : { joiningDate }),
      // StaffDetailResponse never carries leavingDate, so a blank field is "unknown", not "clear it".
      ...(leavingDate === '' ? {} : { leavingDate }),
    })
    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error))
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }
    setErrors({})
    save.mutate(parsed.data)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Edit employment</SheetTitle>
          <SheetDescription>Role in the school, joining and leaving details.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 pb-2 scrollbar-thin">
          <TextField label="Designation" value={designation} onChange={setDesignation} error={errors.designation} />
          <Field label="Department" error={errors.department}>
            <Input value={department} onChange={(e) => setDepartment(e.target.value)} list="staff-edit-departments" placeholder="Science" />
            <Datalist id="staff-edit-departments" values={departments} />
          </Field>
          <SelectField label="Employment type" value={employmentType} onChange={setEmploymentType} options={employmentOptions} error={errors.employmentType} />
          <SelectField label="Status" value={status} onChange={setStatus} options={statusOptions} error={errors.status} />
          <TextField label="Joining date" type="date" value={joiningDate} onChange={setJoiningDate} error={errors.joiningDate} />
          <TextField label="Leaving date" type="date" value={leavingDate} onChange={setLeavingDate} error={errors.leavingDate} hint="Set a date when this person leaves. Leaving it empty keeps whatever is already recorded." />
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={onSave} disabled={save.isPending} title={save.isPending ? 'Saving' : undefined}>Save changes</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

export function StaffContactSheet({ detail, open, onOpenChange }: SheetProps) {
  const { staff } = detail
  const { schoolId, onSaved } = useSaveStaff(() => onOpenChange(false))
  const [errors, setErrors] = useState<FieldErrors>({})
  const [phone, setPhone] = useState(detail.private?.phone ?? '')
  const [address, setAddress] = useState(detail.private?.address ?? '')

  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.staff.updatePrivate>[2]) => api.staff.updatePrivate(schoolId, staff.id, body),
    onSuccess: onSaved,
    onError: (error) => toast.error(describeError(error)),
  })

  function onSave() {
    const parsed = UpdateStaffPrivateRequest.safeParse({ expectedVersion: staff.version, phone: phone.trim(), address })
    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error))
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }
    setErrors({})
    save.mutate(parsed.data)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Edit contact details</SheetTitle>
          <SheetDescription>How the school reaches this person.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 pb-2 scrollbar-thin">
          <TextField label="Phone" value={phone} onChange={setPhone} error={errors.phone} hint="Include the country code, like +919876543210" />
          <Field label="Address" error={errors.address}>
            <Textarea value={address} onChange={(e) => setAddress(e.target.value)} rows={4} placeholder="House 12, Gandhi Road, Jaipur" />
          </Field>
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={onSave} disabled={save.isPending}>Save changes</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

export function StaffPaySheet({ detail, open, onOpenChange }: SheetProps) {
  const { staff } = detail
  const { schoolId, onSaved } = useSaveStaff(() => onOpenChange(false))
  const [errors, setErrors] = useState<FieldErrors>({})
  const [monthlySalary, setMonthlySalary] = useState(detail.pay ? String(detail.pay.monthlySalary) : '')
  const [reason, setReason] = useState('')

  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.staff.updatePay>[2]) => api.staff.updatePay(schoolId, staff.id, body),
    onSuccess: onSaved,
    onError: (error) => toast.error(describeError(error)),
  })

  function onSave() {
    const parsed = UpdateStaffPayRequest.safeParse({
      expectedVersion: staff.version,
      monthlySalary: monthlySalary.trim() === '' ? Number.NaN : Number(monthlySalary),
      reason,
    })
    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error))
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }
    setErrors({})
    save.mutate(parsed.data)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Edit pay</SheetTitle>
          <SheetDescription>Every pay change is written to the audit log with your reason.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 pb-2 scrollbar-thin">
          <TextField label="Monthly salary (₹)" value={monthlySalary} onChange={(v) => setMonthlySalary(v.replace(/[^\d]/g, ''))} error={errors.monthlySalary} placeholder="42000" />
          <Field label="Reason for this change" error={errors.reason}>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Annual revision approved by the principal" />
          </Field>
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={onSave} disabled={save.isPending}>Save changes</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
