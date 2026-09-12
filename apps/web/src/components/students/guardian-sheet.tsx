import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { GuardianInput, GuardianRelation } from '@erp/shared'
import { api } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { qk } from '@/lib/query'
import { humanize } from '@/lib/utils'

const emptyGuardian = { firstName: '', lastName: '', phone: '', email: '', occupation: '' }

/** Side panel to add a parent or guardian to a student */
export function GuardianSheet({ open, onOpenChange, studentId }: { open: boolean; onOpenChange: (v: boolean) => void; studentId: string }) {
  const qc = useQueryClient()
  const [form, setForm] = useState(emptyGuardian)
  const [relation, setRelation] = useState<GuardianRelation>('father')
  const [isPrimary, setIsPrimary] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const set = (k: keyof typeof emptyGuardian, v: string) => setForm((p) => ({ ...p, [k]: v }))

  const add = useMutation({
    mutationFn: (guardian: GuardianInput) => api.students.addGuardian(studentId, { guardian, relation, isPrimary }),
    onSuccess: () => {
      toast.success('Guardian added')
      qc.invalidateQueries({ queryKey: qk.studentGuardians(studentId) })
      qc.invalidateQueries({ queryKey: qk.student(studentId) })
      setForm(emptyGuardian)
      setIsPrimary(false)
      onOpenChange(false)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const submit = () => {
    const parsed = GuardianInput.safeParse({
      firstName: form.firstName,
      lastName: form.lastName || undefined,
      phone: form.phone,
      email: form.email || undefined,
      occupation: form.occupation || undefined,
    })
    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues) next[issue.path.join('.')] = issue.message
      setErrors(next)
      return
    }
    setErrors({})
    add.mutate(parsed.data)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Add guardian</SheetTitle>
          <SheetDescription>The phone number is how the parent will log in later.</SheetDescription>
        </SheetHeader>
        <div className="grid flex-1 grid-cols-2 content-start gap-3 overflow-y-auto px-4">
          <div className="grid gap-1.5">
            <Label className="text-[12.5px] text-muted-foreground">First name</Label>
            <Input value={form.firstName} onChange={(e) => set('firstName', e.target.value)} />
            {errors.firstName && <p className="text-[12px] text-destructive">{errors.firstName}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label className="text-[12.5px] text-muted-foreground">Last name</Label>
            <Input value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-[12.5px] text-muted-foreground">Relation</Label>
            <Select value={relation} onValueChange={(v) => setRelation(v as GuardianRelation)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{GuardianRelation.options.map((r) => <SelectItem key={r} value={r}>{humanize(r)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-[12.5px] text-muted-foreground">Phone</Label>
            <Input value={form.phone} inputMode="numeric" maxLength={10} onChange={(e) => set('phone', e.target.value)} />
            {errors.phone && <p className="text-[12px] text-destructive">{errors.phone}</p>}
          </div>
          <div className="col-span-2 grid gap-1.5">
            <Label className="text-[12.5px] text-muted-foreground">Email</Label>
            <Input value={form.email} onChange={(e) => set('email', e.target.value)} />
            {errors.email && <p className="text-[12px] text-destructive">{errors.email}</p>}
          </div>
          <div className="col-span-2 grid gap-1.5">
            <Label className="text-[12.5px] text-muted-foreground">Occupation</Label>
            <Input value={form.occupation} onChange={(e) => set('occupation', e.target.value)} />
          </div>
          <div className="col-span-2 flex items-center justify-between rounded-lg border px-3 py-2.5">
            <span className="text-[13.5px]">Primary contact</span>
            <Switch checked={isPrimary} onCheckedChange={setIsPrimary} />
          </div>
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={add.isPending}>Add guardian</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
