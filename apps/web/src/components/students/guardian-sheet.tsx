import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { StudentsAddGuardianRequest, StudentsGuardianRelation, StudentsUpdateGuardianRequest } from '@erp/contracts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { useSchoolContext } from '@/lib/session'
import { humanize } from '@/lib/utils'

type FieldErrors = Record<string, string>

function issuesOf(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): FieldErrors {
  const found: FieldErrors = {}
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || 'form'
    if (!found[key]) found[key] = issue.message
  }
  return found
}

/** People write ten digits; the contract wants the E.164 number the server stores. */
export function toE164(tenDigits: string): string {
  const digits = tenDigits.replace(/\D/g, '')
  return digits === '' ? '' : `+91${digits}`
}

/** `+919876543210` -> `9876543210`, so an edit form shows what a person typed. */
export function fromE164(phone: string): string {
  return phone.replace(/^\+91/, '')
}

const RELATIONS = StudentsGuardianRelation.options

export interface GuardianSheetEditing {
  guardianId: string
  expectedVersion: number
  displayName: string
  phone: string
  occupation?: string
  address?: string
}

/**
 * Add a parent or guardian, or edit one this school already holds. Editing needs the guardian's
 * own version, so the caller only offers it when the server sent one.
 */
export function GuardianSheet({ open, onOpenChange, studentId, editing }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  studentId: string
  editing?: GuardianSheetEditing
}) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [firstName, setFirstName] = useState(editing ? (editing.displayName.split(' ')[0] ?? '') : '')
  const [lastName, setLastName] = useState(editing ? editing.displayName.split(' ').slice(1).join(' ') : '')
  const [phone, setPhone] = useState(editing ? fromE164(editing.phone) : '')
  const [occupation, setOccupation] = useState(editing?.occupation ?? '')
  const [address, setAddress] = useState(editing?.address ?? '')
  const [relation, setRelation] = useState<string>('father')
  const [isPrimary, setIsPrimary] = useState(false)
  const [receivesNotifications, setReceivesNotifications] = useState(true)
  const [errors, setErrors] = useState<FieldErrors>({})

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'students'] })
  }

  const add = useMutation({
    mutationFn: (body: Parameters<typeof api.students.addGuardian>[2]) => api.students.addGuardian(schoolId, studentId, body),
    onSuccess: () => {
      invalidate()
      toast.success('Guardian added')
      onOpenChange(false)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const update = useMutation({
    mutationFn: (body: Parameters<typeof api.students.updateGuardian>[3]) =>
      api.students.updateGuardian(schoolId, studentId, editing!.guardianId, body),
    onSuccess: () => {
      invalidate()
      toast.success('Saved changes')
      onOpenChange(false)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const isPending = add.isPending || update.isPending

  const submit = () => {
    if (editing) {
      const parsed = StudentsUpdateGuardianRequest.safeParse({
        expectedVersion: editing.expectedVersion,
        firstName: firstName.trim(),
        lastName: lastName.trim() === '' ? undefined : lastName.trim(),
        phone: toE164(phone),
        occupation: occupation.trim() === '' ? undefined : occupation.trim(),
        address: address.trim() === '' ? undefined : address.trim(),
        relation,
        isPrimary,
        receivesNotifications,
      })
      if (!parsed.success) {
        setErrors(issuesOf(parsed.error))
        return
      }
      setErrors({})
      update.mutate(parsed.data)
      return
    }

    const parsed = StudentsAddGuardianRequest.safeParse({
      guardian: {
        firstName: firstName.trim(),
        lastName: lastName.trim() === '' ? undefined : lastName.trim(),
        phone: toE164(phone),
        occupation: occupation.trim() === '' ? undefined : occupation.trim(),
        address: address.trim() === '' ? undefined : address.trim(),
      },
      relation,
      isPrimary,
      receivesNotifications,
    })
    if (!parsed.success) {
      setErrors(issuesOf(parsed.error))
      return
    }
    setErrors({})
    add.mutate(parsed.data)
  }

  const err = (field: string) => errors[field] ?? errors[`guardian.${field}`]

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{editing ? 'Edit guardian' : 'Add guardian'}</SheetTitle>
          <SheetDescription>The phone number is how the school reaches this family.</SheetDescription>
        </SheetHeader>
        <div className="grid flex-1 grid-cols-2 content-start gap-3 overflow-y-auto px-4 scrollbar-thin">
          <div className="grid gap-1.5">
            <Label className="text-[12.5px] text-muted-foreground">First name</Label>
            <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            {err('firstName') && <p className="text-[12px] text-destructive">{err('firstName')}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label className="text-[12.5px] text-muted-foreground">Last name</Label>
            <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-[12.5px] text-muted-foreground">Relation</Label>
            <Select value={relation} onValueChange={setRelation}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{RELATIONS.map((r) => <SelectItem key={r} value={r}>{humanize(r)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-[12.5px] text-muted-foreground">Phone</Label>
            <Input value={phone} inputMode="numeric" maxLength={10} placeholder="9876543210" onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} />
            {err('phone') && <p className="text-[12px] text-destructive">Write the 10 digit mobile number.</p>}
          </div>
          <div className="col-span-2 grid gap-1.5">
            <Label className="text-[12.5px] text-muted-foreground">Occupation</Label>
            <Input value={occupation} onChange={(e) => setOccupation(e.target.value)} />
          </div>
          <div className="col-span-2 grid gap-1.5">
            <Label className="text-[12.5px] text-muted-foreground">Address</Label>
            <Textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>
          <div className="col-span-2 flex items-center justify-between rounded-lg border px-3 py-2.5">
            <span className="text-[13.5px]">Primary contact</span>
            <Switch checked={isPrimary} onCheckedChange={setIsPrimary} />
          </div>
          <div className="col-span-2 flex items-center justify-between rounded-lg border px-3 py-2.5">
            <span className="text-[13.5px]">Gets messages from the school</span>
            <Switch checked={receivesNotifications} onCheckedChange={setReceivesNotifications} />
          </div>
          {errors.form && <p className="col-span-2 text-[12px] text-destructive">{errors.form}</p>}
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={isPending}>{isPending ? 'Saving…' : editing ? 'Save changes' : 'Add guardian'}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
