import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { UpdateSchoolRequest } from '@erp/contracts'
import { Facts, Panel } from '@/components/shared/page'
import { Field, toE164, validate, type FieldErrors } from '@/components/setup/field'
import { CHECK_FIELDS, type FieldLabels } from '@/lib/validation'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import type { SchoolProfile, UpdateSchoolInput } from '@/lib/api/setup'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

const BOARD_LABEL: Record<string, string> = { cbse: 'CBSE', icse: 'ICSE', state: 'State board', ib: 'IB', other: 'Other' }
const BOARDS = ['cbse', 'icse', 'state', 'ib', 'other'] as const

type Form = {
  name: string
  shortName: string
  board: (typeof BOARDS)[number]
  address: string
  phone: string
  email: string
  affiliationNumber: string
  udiseCode: string
}

const LABELS: FieldLabels = {
  name: 'school name',
  shortName: 'short name',
  board: { label: 'board', kind: 'select' },
  affiliationNumber: 'affiliation number',
  udiseCode: 'UDISE code',
  phone: 'phone number',
  email: 'email address',
  address: 'address',
}

function toForm(school: SchoolProfile): Form {
  return {
    name: school.name,
    shortName: school.shortName,
    board: school.board,
    address: school.address,
    phone: school.phone ?? '',
    email: school.email ?? '',
    affiliationNumber: school.affiliationNumber ?? '',
    udiseCode: school.udiseCode ?? '',
  }
}

/** School profile form. The route renders its own save button through the returned controller. */
export function useSchoolProfile() {
  const { schoolId, hasPermission } = useSchoolContext()
  const queryClient = useQueryClient()
  const canEdit = hasPermission('school.update')

  const { data, isLoading, error } = useQuery({
    queryKey: qk.school(schoolId),
    queryFn: () => api.setup.school(schoolId),
  })
  const [form, setForm] = useState<Form | null>(null)
  const [errors, setErrors] = useState<FieldErrors>({})

  useEffect(() => { if (data) setForm(toForm(data)) }, [data])

  const save = useMutation({
    mutationFn: (input: UpdateSchoolInput) => api.setup.updateSchool(schoolId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.school(schoolId) })
      toast.success('Saved changes')
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const dirty = !!form && !!data && JSON.stringify(form) !== JSON.stringify(toForm(data))

  function submit() {
    if (!form || !data) return
    const candidate = {
      name: form.name,
      shortName: form.shortName,
      board: form.board,
      address: form.address,
      phone: toE164(form.phone),
      email: form.email.trim(),
      affiliationNumber: form.affiliationNumber.trim() || undefined,
      udiseCode: form.udiseCode.trim() || undefined,
      expectedVersion: data.version,
    }
    const checked = validate(UpdateSchoolRequest, candidate, LABELS)
    if (!checked.ok) {
      setErrors(checked.errors)
      toast.error(CHECK_FIELDS)
      return
    }
    setErrors({})
    save.mutate(checked.data)
  }

  return { school: data, form, setForm, errors, dirty, isLoading, error, canEdit, submit, saving: save.isPending }
}

type Controller = ReturnType<typeof useSchoolProfile>

export function SchoolProfileBody({ ctl }: { ctl: Controller }) {
  const { form, setForm, errors, isLoading, error, canEdit } = ctl
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => (f ? { ...f, [key]: value } : f))

  if (error) {
    return <p className="p-5 text-[13.5px] text-muted-foreground">{describeError(error)}</p>
  }
  if (isLoading || !form) {
    return <div className="grid max-w-4xl gap-4 p-5 md:grid-cols-2">{[0, 1].map((i) => <Skeleton key={i} className="h-96 rounded-xl" />)}</div>
  }

  return (
    <div className="max-w-4xl space-y-4 p-5">
      <Panel bodyClassName="pt-4">
        <div className="flex items-center gap-4">
          <div className="flex size-16 items-center justify-center rounded-xl border bg-muted/60 text-[20px] font-semibold tracking-tight">{form.shortName}</div>
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold">{form.name}</h2>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">{BOARD_LABEL[form.board]}</p>
          </div>
        </div>
      </Panel>

      {!canEdit ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Panel title="Basic details">
            <Facts items={[
              { label: 'School name', value: form.name },
              { label: 'Short name', value: form.shortName },
              { label: 'Board', value: BOARD_LABEL[form.board] },
              { label: 'Affiliation number', value: form.affiliationNumber || null },
              { label: 'UDISE code', value: form.udiseCode || null },
            ]} />
          </Panel>
          <Panel title="Contact">
            <Facts items={[
              { label: 'Phone', value: form.phone || null },
              { label: 'Email', value: form.email || null },
            ]} />
            <p className="mt-3 text-[12px] text-muted-foreground">Address</p>
            <p className="mt-0.5 text-[13.5px] whitespace-pre-line">{form.address || '—'}</p>
          </Panel>
        </div>
      ) : (
      <fieldset className="grid gap-4 md:grid-cols-2">
        <Panel title="Basic details">
          <div className="grid gap-3">
            <Field label="School name" error={errors.name}><Input value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Short name" error={errors.shortName}><Input value={form.shortName} onChange={(e) => set('shortName', e.target.value)} /></Field>
              <Field label="Board" error={errors.board}>
                <Select value={form.board} onValueChange={(v) => set('board', v as Form['board'])}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{BOARDS.map((b) => <SelectItem key={b} value={b}>{BOARD_LABEL[b]}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Affiliation number" error={errors.affiliationNumber}><Input value={form.affiliationNumber} onChange={(e) => set('affiliationNumber', e.target.value)} /></Field>
              <Field label="UDISE code" error={errors.udiseCode}><Input value={form.udiseCode} onChange={(e) => set('udiseCode', e.target.value)} /></Field>
            </div>
          </div>
        </Panel>

        <Panel title="Contact">
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Phone" error={errors.phone} hint="10 digits, or a number starting with +">
                <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} />
              </Field>
              <Field label="Email" error={errors.email}><Input value={form.email} onChange={(e) => set('email', e.target.value)} /></Field>
            </div>
            <Field label="Address" error={errors.address}>
              <Textarea rows={5} value={form.address} onChange={(e) => set('address', e.target.value)} />
            </Field>
          </div>
        </Panel>
      </fieldset>
      )}
    </div>
  )
}
