import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { StudentInput, type Student } from '@erp/shared'
import { api } from '@/api/client'
import { SectionLabel } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { qk } from '@/lib/query'
import { fullName, humanize } from '@/lib/utils'

const EditSchema = StudentInput.omit({ guardians: true, sectionId: true, rollNumber: true })
type EditValues = z.infer<typeof EditSchema>

const BLOOD = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown'] as const
const CATEGORY = ['general', 'obc', 'sc', 'st', 'ews', 'other'] as const
const GENDER = ['male', 'female', 'other'] as const
const ADMISSION = ['regular', 'rte', 'staff_ward', 'scholarship'] as const

function Field({ label, error, children, className }: { label: string; error?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`grid gap-1.5 ${className ?? ''}`}>
      <Label className="text-[12.5px] text-muted-foreground">{label}</Label>
      {children}
      {error && <p className="text-[12px] text-destructive">{error}</p>}
    </div>
  )
}

/** Side panel to edit the student's own fields. Class and guardians are changed elsewhere. */
export function StudentEditSheet({ open, onOpenChange, student }: { open: boolean; onOpenChange: (v: boolean) => void; student: Student }) {
  const qc = useQueryClient()
  const [values, setValues] = useState<EditValues>(() => {
    const parsed = EditSchema.safeParse({ ...student })
    return parsed.success ? parsed.data : ({ ...student } as unknown as EditValues)
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const set = <K extends keyof EditValues>(k: K, v: EditValues[K]) => setValues((p) => ({ ...p, [k]: v }))
  const setAddr = (k: keyof EditValues['address'], v: string) => setValues((p) => ({ ...p, address: { ...p.address, [k]: v } }))
  const opt = (v: string) => (v.trim() === '' ? undefined : v)

  const save = useMutation({
    mutationFn: (v: EditValues) => api.students.update(student.id, v),
    onSuccess: () => {
      toast.success('Changes saved')
      qc.invalidateQueries({ queryKey: qk.student(student.id) })
      qc.invalidateQueries({ queryKey: ['students'] })
      onOpenChange(false)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const submit = () => {
    const parsed = EditSchema.safeParse(values)
    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues) next[issue.path.join('.')] = issue.message
      setErrors(next)
      return
    }
    setErrors({})
    save.mutate(parsed.data)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Edit {fullName(student)}</SheetTitle>
          <SheetDescription>Class, roll number and guardians are changed from their own actions.</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 scrollbar-thin">
          <SectionLabel className="px-0">Personal</SectionLabel>
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name" error={errors.firstName}><Input value={values.firstName} onChange={(e) => set('firstName', e.target.value)} /></Field>
            <Field label="Last name" error={errors.lastName}><Input value={values.lastName ?? ''} onChange={(e) => set('lastName', opt(e.target.value))} /></Field>
            <Field label="Date of birth" error={errors.dateOfBirth}><Input type="date" value={values.dateOfBirth} onChange={(e) => set('dateOfBirth', e.target.value)} /></Field>
            <Field label="Gender" error={errors.gender}>
              <Select value={values.gender} onValueChange={(v) => set('gender', v as EditValues['gender'])}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{GENDER.map((g) => <SelectItem key={g} value={g}>{humanize(g)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Blood group" error={errors.bloodGroup}>
              <Select value={values.bloodGroup} onValueChange={(v) => set('bloodGroup', v as EditValues['bloodGroup'])}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{BLOOD.map((b) => <SelectItem key={b} value={b}>{b === 'unknown' ? 'Not known' : b}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Category" error={errors.category}>
              <Select value={values.category} onValueChange={(v) => set('category', v as EditValues['category'])}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{CATEGORY.map((c) => <SelectItem key={c} value={c}>{c === 'general' || c === 'other' ? humanize(c) : c.toUpperCase()}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Religion" error={errors.religion}><Input value={values.religion ?? ''} onChange={(e) => set('religion', opt(e.target.value))} /></Field>
            <Field label="Mother tongue" error={errors.motherTongue}><Input value={values.motherTongue ?? ''} onChange={(e) => set('motherTongue', opt(e.target.value))} /></Field>
            <Field label="Nationality" error={errors.nationality}><Input value={values.nationality} onChange={(e) => set('nationality', e.target.value)} /></Field>
            <Field label="Aadhaar last 4" error={errors.aadhaarLast4}><Input value={values.aadhaarLast4 ?? ''} maxLength={4} inputMode="numeric" onChange={(e) => set('aadhaarLast4', opt(e.target.value))} /></Field>
            <Field label="APAAR ID" error={errors.apaarId}><Input value={values.apaarId ?? ''} onChange={(e) => set('apaarId', opt(e.target.value))} /></Field>
            <Field label="House" error={errors.house}><Input value={values.house ?? ''} onChange={(e) => set('house', opt(e.target.value))} /></Field>
          </div>

          <SectionLabel className="px-0">Address</SectionLabel>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Address line 1" error={errors['address.line1']} className="col-span-2"><Input value={values.address.line1} onChange={(e) => setAddr('line1', e.target.value)} /></Field>
            <Field label="Address line 2" error={errors['address.line2']} className="col-span-2"><Input value={values.address.line2 ?? ''} onChange={(e) => setAddr('line2', e.target.value)} /></Field>
            <Field label="City" error={errors['address.city']}><Input value={values.address.city} onChange={(e) => setAddr('city', e.target.value)} /></Field>
            <Field label="District" error={errors['address.district']}><Input value={values.address.district ?? ''} onChange={(e) => setAddr('district', e.target.value)} /></Field>
            <Field label="State" error={errors['address.state']}><Input value={values.address.state} onChange={(e) => setAddr('state', e.target.value)} /></Field>
            <Field label="PIN code" error={errors['address.pincode']}><Input value={values.address.pincode} inputMode="numeric" maxLength={6} onChange={(e) => setAddr('pincode', e.target.value)} /></Field>
          </div>

          <SectionLabel className="px-0">Admission</SectionLabel>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Admission number" error={errors.admissionNumber}><Input value={values.admissionNumber} onChange={(e) => set('admissionNumber', e.target.value)} /></Field>
            <Field label="Admission date" error={errors.admissionDate}><Input type="date" value={values.admissionDate} onChange={(e) => set('admissionDate', e.target.value)} /></Field>
            <Field label="Admission type" error={errors.admissionType}>
              <Select value={values.admissionType} onValueChange={(v) => set('admissionType', v as EditValues['admissionType'])}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{ADMISSION.map((a) => <SelectItem key={a} value={a}>{a === 'rte' ? 'RTE' : humanize(a)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Previous school" error={errors.previousSchool}><Input value={values.previousSchool ?? ''} onChange={(e) => set('previousSchool', opt(e.target.value))} /></Field>
            <Field label="Medical notes" error={errors.medicalNotes} className="col-span-2"><Textarea rows={2} value={values.medicalNotes ?? ''} onChange={(e) => set('medicalNotes', opt(e.target.value))} /></Field>
            <div className="col-span-2 flex items-center justify-between rounded-lg border px-3 py-2.5">
              <span className="text-[13.5px]">Uses school transport</span>
              <Switch checked={values.usesTransport} onCheckedChange={(v) => set('usesTransport', v)} />
            </div>
          </div>
        </div>

        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={save.isPending}>Save changes</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
