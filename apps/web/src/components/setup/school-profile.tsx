import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Board, SchoolInput, type School } from '@erp/shared'
import { api } from '@/api/client'
import { Panel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Field, validate, type FieldErrors } from '@/components/setup/field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { humanize } from '@/lib/utils'

const BOARD_LABEL: Record<string, string> = { cbse: 'CBSE', icse: 'ICSE', state: 'State board', ib: 'IB', other: 'Other' }

function toInput(s: School): SchoolInput {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = s
  return rest
}

/** School profile form. Renders its own save button through `actionsSlot`. */
export function useSchoolProfile() {
  const { school } = useSession()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: [...qk.schools, school.id], queryFn: () => api.schools.get(school.id) })
  const [form, setForm] = useState<SchoolInput | null>(null)
  const [errors, setErrors] = useState<FieldErrors>({})

  useEffect(() => { if (data) setForm(toInput(data)) }, [data])

  const save = useMutation({
    mutationFn: (input: SchoolInput) => api.schools.update(school.id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.schools })
      toast.success('School profile saved')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const dirty = !!form && !!data && JSON.stringify(form) !== JSON.stringify(toInput(data))

  function submit() {
    if (!form) return
    const res = validate(SchoolInput, form)
    if (!res.ok) { setErrors(res.errors); toast.error('Please fix the highlighted fields'); return }
    setErrors({})
    save.mutate(res.data)
  }

  return { school: data, form, setForm, errors, dirty, isLoading, submit, saving: save.isPending }
}

type Ctl = ReturnType<typeof useSchoolProfile>

export function SchoolProfileBody({ ctl, canEdit = true }: { ctl: Ctl; canEdit?: boolean }) {
  const { form, setForm, errors, isLoading, school } = ctl
  const set = <K extends keyof SchoolInput>(k: K, v: SchoolInput[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))
  const setAddr = (k: keyof SchoolInput['address'], v: string) => setForm((f) => (f ? { ...f, address: { ...f.address, [k]: v } } : f))

  if (isLoading || !form) {
    return <div className="grid max-w-4xl gap-4 p-5 md:grid-cols-2">{[0, 1].map((i) => <Skeleton key={i} className="h-96 rounded-xl" />)}</div>
  }

  return (
    <div className="max-w-4xl space-y-4 p-5">
      <Panel bodyClassName="pt-4">
        <div className="flex items-center gap-4">
          <div className="flex size-16 items-center justify-center rounded-xl border bg-muted/60 text-[20px] font-semibold tracking-tight">{form.shortName}</div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[15px] font-semibold">{form.name}</h2>
              <Tag color={form.status === 'active' ? 'green' : form.status === 'trial' ? 'orange' : 'grey'} dot>{humanize(form.status)}</Tag>
            </div>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">{BOARD_LABEL[form.board]} · {form.address.city}{school?.establishedYear ? ` · Since ${school.establishedYear}` : ''}</p>
            <Button variant="outline" size="sm" className="mt-2.5" disabled><Upload /> Upload logo</Button>
          </div>
        </div>
      </Panel>

      <fieldset disabled={!canEdit} className="grid gap-4 md:grid-cols-2">
        <Panel title="Basic details">
          <div className="grid gap-3">
            <Field label="School name" error={errors.name}><Input value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Short name" error={errors.shortName}><Input value={form.shortName} onChange={(e) => set('shortName', e.target.value)} /></Field>
              <Field label="Board" error={errors.board}>
                <Select value={form.board} onValueChange={(v) => set('board', v as SchoolInput['board'])}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{Board.options.map((b) => <SelectItem key={b} value={b}>{BOARD_LABEL[b]}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Affiliation number" error={errors.affiliationNumber}><Input value={form.affiliationNumber ?? ''} onChange={(e) => set('affiliationNumber', e.target.value || undefined)} /></Field>
              <Field label="UDISE code" error={errors.udiseCode}><Input value={form.udiseCode ?? ''} onChange={(e) => set('udiseCode', e.target.value || undefined)} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Established year" error={errors.establishedYear}>
                <Input inputMode="numeric" value={form.establishedYear ?? ''} onChange={(e) => set('establishedYear', e.target.value ? Number(e.target.value) : undefined)} />
              </Field>
              <Field label="Status"><div className="flex h-9 items-center"><Tag color={form.status === 'active' ? 'green' : form.status === 'trial' ? 'orange' : 'grey'} dot>{humanize(form.status)}</Tag></div></Field>
            </div>
            <Field label="Principal name" error={errors.principalName}><Input value={form.principalName} onChange={(e) => set('principalName', e.target.value)} /></Field>
          </div>
        </Panel>

        <Panel title="Contact">
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Phone" error={errors.phone}><Input value={form.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
              <Field label="Email" error={errors.email}><Input value={form.email} onChange={(e) => set('email', e.target.value)} /></Field>
            </div>
            <Field label="Website" error={errors.website}><Input value={form.website ?? ''} onChange={(e) => set('website', e.target.value || undefined)} /></Field>
            <Field label="Address line 1" error={errors['address.line1']}><Input value={form.address.line1} onChange={(e) => setAddr('line1', e.target.value)} /></Field>
            <Field label="Address line 2" error={errors['address.line2']}><Input value={form.address.line2 ?? ''} onChange={(e) => setAddr('line2', e.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="City" error={errors['address.city']}><Input value={form.address.city} onChange={(e) => setAddr('city', e.target.value)} /></Field>
              <Field label="District" error={errors['address.district']}><Input value={form.address.district ?? ''} onChange={(e) => setAddr('district', e.target.value)} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="State" error={errors['address.state']}><Input value={form.address.state} onChange={(e) => setAddr('state', e.target.value)} /></Field>
              <Field label="PIN code" error={errors['address.pincode']}><Input value={form.address.pincode} onChange={(e) => setAddr('pincode', e.target.value)} /></Field>
            </div>
          </div>
        </Panel>
      </fieldset>
    </div>
  )
}
