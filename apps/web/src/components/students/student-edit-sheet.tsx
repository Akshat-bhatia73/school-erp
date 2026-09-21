import { useMutation, useQueryClient } from '@tanstack/react-query'
import { cloneElement, isValidElement, useState, type ReactElement } from 'react'
import { toast } from 'sonner'
import { StudentsUpdateSensitiveRequest, UpdateStudentBasicRequest } from '@erp/contracts'
import { SectionLabel } from '@/components/shared/page'
import { IdentityField } from '@/components/students/identity-fields'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import type { StudentDetail } from '@/lib/api/students'
import { useSchoolContext } from '@/lib/session'
import { fullName, humanize } from '@/lib/utils'
import { FORM_ERROR, fieldErrors, focusFirstInvalid, type FieldLabels } from '@/lib/validation'

type FieldErrors = Record<string, string>

const LABELS: FieldLabels = {
  firstName: 'first name',
  lastName: 'last name',
  dateOfBirth: 'date of birth',
  gender: { label: 'gender', kind: 'select' },
  category: { label: 'category', kind: 'select' },
  admissionType: { label: 'admission type', kind: 'select' },
  address: 'address',
  aadhaar: 'Aadhaar number',
  apaarId: 'APAAR id',
  bloodGroup: { label: 'blood group', kind: 'select' },
  medicalNotes: 'medical notes',
}

/** A rejected `Input` or `Textarea` is marked invalid, which is what the focus helper looks for. */
function Field({ label, error, hint, children, className }: { label: string; error?: string; hint?: string; children: React.ReactNode; className?: string }) {
  const injectable = isValidElement(children) && (children.type === Input || children.type === Textarea)
  const control = injectable && error
    ? cloneElement(children as ReactElement<Record<string, unknown>>, { 'aria-invalid': true })
    : children
  return (
    <div className={`grid gap-1.5 ${className ?? ''}`}>
      <Label className="text-[12.5px] text-muted-foreground">{label}</Label>
      {control}
      {error ? <p className="text-[12px] text-destructive">{error}</p> : hint ? <p className="text-[12px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

const trimmed = (value: string) => (value.trim() === '' ? undefined : value.trim())

/**
 * A field the person emptied must travel as '' so the old value is actually cleared; the request
 * omits undefined keys, so sending undefined would quietly keep what was there.
 */
const cleared = (value: string, initial: string | undefined) => {
  const next = value.trim()
  if (next !== '') return next
  return initial && initial !== '' ? '' : undefined
}

/** The name fields, the only thing students.update_basic covers. */
export function StudentBasicSheet({ open, onOpenChange, student }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  student: StudentDetail['student']
}) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [firstName, setFirstName] = useState(student.firstName)
  const [lastName, setLastName] = useState(student.lastName ?? '')
  const [errors, setErrors] = useState<FieldErrors>({})

  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.students.updateBasic>[2]) => api.students.updateBasic(schoolId, student.id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'students'] })
      toast.success('Saved changes')
      onOpenChange(false)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const submit = () => {
    const parsed = UpdateStudentBasicRequest.safeParse({
      expectedVersion: student.version,
      firstName: firstName.trim(),
      lastName: trimmed(lastName),
    })
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error, LABELS))
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }
    setErrors({})
    save.mutate(parsed.data)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Edit {fullName(student)}</SheetTitle>
          <SheetDescription>The name on every report card. Class, guardians and other details have their own actions.</SheetDescription>
        </SheetHeader>
        <div className="grid flex-1 grid-cols-2 content-start gap-3 overflow-y-auto px-4 scrollbar-thin">
          <Field label="First name" error={errors.firstName}><Input value={firstName} onChange={(e) => setFirstName(e.target.value)} /></Field>
          <Field label="Last name" error={errors.lastName}><Input value={lastName} onChange={(e) => setLastName(e.target.value)} /></Field>
          {errors[FORM_ERROR] && <p className="col-span-2 text-[12px] text-destructive">{errors[FORM_ERROR]}</p>}
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save changes'}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

const GENDERS = ['male', 'female', 'other'] as const

/**
 * The restricted demographic fields. The medical fields appear only when the server sent the
 * medical block, because writing them needs that read as well.
 */
export function StudentSensitiveSheet({ open, onOpenChange, student, sensitive, medical }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  student: StudentDetail['student']
  sensitive: NonNullable<StudentDetail['sensitive']> | undefined
  medical: StudentDetail['medical']
}) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [dateOfBirth, setDateOfBirth] = useState(sensitive?.dateOfBirth ?? '')
  const [gender, setGender] = useState<string>(sensitive?.gender ?? '')
  const [category, setCategory] = useState(sensitive?.category ?? '')
  const [admissionType, setAdmissionType] = useState(sensitive?.admissionType ?? '')
  const [address, setAddress] = useState(sensitive?.address ?? '')
  // The server only ever sends the last digits, so both identity boxes start
  // empty and an untouched box changes nothing.
  const [aadhaar, setAadhaar] = useState('')
  const [apaarId, setApaarId] = useState('')
  const [bloodGroup, setBloodGroup] = useState(medical?.bloodGroup ?? '')
  const [medicalNotes, setMedicalNotes] = useState(medical?.medicalNotes ?? '')
  const [errors, setErrors] = useState<FieldErrors>({})

  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.students.updateSensitive>[2]) => api.students.updateSensitive(schoolId, student.id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'students'] })
      toast.success('Saved changes')
      onOpenChange(false)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const submit = () => {
    const parsed = StudentsUpdateSensitiveRequest.safeParse({
      expectedVersion: student.version,
      dateOfBirth: trimmed(dateOfBirth),
      gender: gender === '' ? undefined : gender,
      category: cleared(category, sensitive?.category),
      admissionType: cleared(admissionType, sensitive?.admissionType),
      address: cleared(address, sensitive?.address),
      aadhaar: trimmed(aadhaar),
      apaarId: trimmed(apaarId),
      ...(medical
        ? { bloodGroup: cleared(bloodGroup, medical.bloodGroup), medicalNotes: cleared(medicalNotes, medical.medicalNotes) }
        : {}),
    })
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error, LABELS))
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
          <SheetTitle>Edit details</SheetTitle>
          <SheetDescription>Date of birth, category and identifiers used on government records.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 scrollbar-thin">
          <SectionLabel className="px-0">Personal</SectionLabel>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date of birth" error={errors.dateOfBirth}><Input type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} /></Field>
            <Field label="Gender" error={errors.gender}>
              <Select value={gender || undefined} onValueChange={setGender}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>{GENDERS.map((g) => <SelectItem key={g} value={g}>{humanize(g)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Category" error={errors.category}><Input value={category} onChange={(e) => setCategory(e.target.value)} /></Field>
            <Field label="Admission type" error={errors.admissionType}><Input value={admissionType} onChange={(e) => setAdmissionType(e.target.value)} /></Field>
            <IdentityField kind="aadhaar" label="Aadhaar number" value={aadhaar} onChange={setAadhaar} onFile={sensitive?.aadhaarLast4} error={errors.aadhaar} />
            <Field
              label="APAAR ID"
              error={errors.apaarId}
              hint={sensitive?.apaarMasked ? `On file: ${sensitive.apaarMasked}. Type the full id to replace it.` : undefined}
            >
              <Input value={apaarId} onChange={(e) => setApaarId(e.target.value)} />
            </Field>
            <Field label="Address" error={errors.address} className="col-span-2"><Textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
          </div>

          {medical && (
            <>
              <SectionLabel className="px-0">Health</SectionLabel>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Blood group" error={errors.bloodGroup}><Input value={bloodGroup} onChange={(e) => setBloodGroup(e.target.value)} /></Field>
                <Field label="Medical notes" error={errors.medicalNotes} className="col-span-2"><Textarea rows={3} value={medicalNotes} onChange={(e) => setMedicalNotes(e.target.value)} /></Field>
              </div>
            </>
          )}
          {errors[FORM_ERROR] && <p className="mt-3 text-[12px] text-destructive">{errors[FORM_ERROR]}</p>}
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save changes'}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
