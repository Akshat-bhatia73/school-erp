import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { EyeOff, Plus } from 'lucide-react'
import {
  CreateMemberRestrictionRequest,
  LiftMemberRestrictionRequest,
  RESTRICTABLE_PERMISSIONS,
  type RestrictablePermission,
} from '@erp/contracts'
import { api } from '@/lib/api'
import type { Member, Restriction } from '@/lib/api/members'
import { qk } from '@/lib/query'
import { describeError, isApiError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { formatDate } from '@/lib/utils'
import { FORM_ERROR, validate, type FieldErrors, type FieldLabels } from '@/lib/validation'
import { Field } from '@/components/setup/field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/** What each restriction hides, in the words an office reads. */
const RESTRICTION_LABEL: Record<RestrictablePermission, string> = {
  'students.read_sensitive': 'Sensitive details (Aadhaar, APAAR)',
  'students.read_guardians': 'Full guardian records (PAN, Aadhaar, office address)',
  'students.read_medical': 'Medical information',
}

const ADD_LABELS: FieldLabels = {
  permission: { label: 'detail to hide', kind: 'select' },
  reason: 'reason',
  expiresAt: { label: 'end date', kind: 'date' },
}

const LIFT_LABELS: FieldLabels = { reason: 'reason' }

const CONFLICT = "This person's access changed while you were working. Close and reopen their details, then try again."

/** A failure in plain English; a version clash names the person's access, not "this". */
function describeRestrictionError(error: unknown): string {
  return isApiError(error, 'VERSION_CONFLICT') ? CONFLICT : describeError(error)
}

/** Today's date in India, as the `YYYY-MM-DD` a date input holds. */
function todayInIndia(now = Date.now()): string {
  return new Date(now + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** The last moment of a chosen day in India, as the ISO timestamp the contract wants. */
function endOfDayInIndia(date: string): string {
  return new Date(`${date}T23:59:59.999+05:30`).toISOString()
}

export function MemberRestrictions({ member, schoolId, onChanged }: {
  member: Member; schoolId: string; onChanged: () => void
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: qk.memberRestrictions(schoolId, member.id),
    queryFn: () => api.members.restrictions(schoolId, member.id),
  })
  const [adding, setAdding] = useState(false)
  const [lifting, setLifting] = useState<Restriction | null>(null)

  const canChange = data ? allows(data.allowedActions, 'access.manage') : false
  const items = data?.items ?? []
  const inForce = new Set(items.map((item) => item.permission))
  const available = RESTRICTABLE_PERMISSIONS.filter((permission) => !inForce.has(permission))

  if (data && !canChange && items.length === 0) return null

  return (
    <section className="grid gap-3" aria-label="Restrictions">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[13.5px] font-medium">Restrictions</h3>
          <p className="text-[12.5px] text-muted-foreground">
            Hide these details from this person everywhere in the school, whatever their roles allow.
          </p>
        </div>
        {canChange && available.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> Add restriction
          </Button>
        )}
      </div>

      {isLoading && <Skeleton className="h-14 w-full rounded-xl" />}
      {error && <p className="text-[13px] text-muted-foreground">{describeError(error)}</p>}

      {data && (items.length === 0
        ? <p className="rounded-xl border border-dashed p-3 text-[13px] text-muted-foreground">Nothing is hidden from this person.</p>
        : (
          <ul className="divide-y rounded-xl border">
            {items.map((item) => (
              <li key={item.id} className="flex items-start gap-3 p-3">
                <EyeOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium">{RESTRICTION_LABEL[item.permission]}</p>
                  <p className="text-[12.5px] text-muted-foreground">
                    {item.expiresAt ? `Until ${formatDate(item.expiresAt)}` : 'Until lifted'}
                    {' · '}Added by {item.createdBy.displayName} on {formatDate(item.createdAt)}
                  </p>
                  <p className="mt-0.5 text-[12.5px] break-words text-muted-foreground">{item.reason}</p>
                </div>
                {canChange && (
                  <Button variant="ghost" size="sm" onClick={() => setLifting(item)} aria-label={`Lift ${RESTRICTION_LABEL[item.permission]}`}>
                    Lift
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ))}

      {canChange && adding && (
        <AddRestrictionDialog
          member={member}
          schoolId={schoolId}
          available={available}
          onClose={() => setAdding(false)}
          onChanged={onChanged}
        />
      )}
      {canChange && lifting && (
        <LiftRestrictionDialog
          member={member}
          schoolId={schoolId}
          restriction={lifting}
          onClose={() => setLifting(null)}
          onChanged={onChanged}
        />
      )}
    </section>
  )
}

function AddRestrictionDialog({ member, schoolId, available, onClose, onChanged }: {
  member: Member; schoolId: string; available: RestrictablePermission[]; onClose: () => void; onChanged: () => void
}) {
  const [permission, setPermission] = useState<RestrictablePermission | ''>(available[0] ?? '')
  const [reason, setReason] = useState('')
  const [until, setUntil] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})

  const add = useMutation({
    mutationFn: (body: CreateMemberRestrictionRequest) => api.members.addRestriction(schoolId, member.id, body),
    onSuccess: () => {
      toast.success('Restriction added')
      onChanged()
      onClose()
    },
    onError: (err) => {
      if (isApiError(err, 'VERSION_CONFLICT')) onChanged()
      const message = describeRestrictionError(err)
      setErrors({ [FORM_ERROR]: message })
      toast.error(message)
    },
  })

  const submit = () => {
    const expiresAt = until ? endOfDayInIndia(until) : undefined
    const checked = validate(CreateMemberRestrictionRequest, {
      permission: permission || undefined,
      reason,
      ...(expiresAt ? { expiresAt } : {}),
      expectedAccessVersion: member.accessVersion,
    }, ADD_LABELS)
    const next: FieldErrors = checked.ok ? {} : { ...checked.errors }
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) next.expiresAt = 'Choose today or a later date'
    setErrors(next)
    if (!checked.ok || Object.keys(next).length > 0) return
    add.mutate(checked.data)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restrict {member.displayName}</DialogTitle>
          <DialogDescription>They stop seeing this across the whole school, whatever their roles allow.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 px-6">
          <div className="grid gap-1.5">
            <Label className="text-[12.5px] text-muted-foreground">What to hide</Label>
            <RadioGroup
              value={permission}
              onValueChange={(value) => setPermission(value as RestrictablePermission)}
              className="gap-2 rounded-xl border p-3"
              aria-label="What to hide"
            >
              {available.map((key) => (
                <label key={key} className="flex items-center gap-2.5 text-[13.5px]">
                  <RadioGroupItem value={key} aria-label={RESTRICTION_LABEL[key]} />
                  <span>{RESTRICTION_LABEL[key]}</span>
                </label>
              ))}
            </RadioGroup>
            {errors.permission && <p role="alert" className="text-[12px] text-tag-red">{errors.permission}</p>}
          </div>
          <Field label="Reason" error={errors.reason} hint="Only people who manage access can see this.">
            <Textarea aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Handles admissions only, no need for Aadhaar" />
          </Field>
          <Field label="End date (optional)" error={errors.expiresAt} hint="Leave empty to keep it until someone lifts it.">
            <Input aria-label="End date" type="date" min={todayInIndia()} value={until} onChange={(e) => setUntil(e.target.value)} />
          </Field>
          {errors[FORM_ERROR] && <p role="alert" className="text-[12px] text-tag-red">{errors[FORM_ERROR]}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={add.isPending} onClick={submit}>Restrict access</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LiftRestrictionDialog({ member, schoolId, restriction, onClose, onChanged }: {
  member: Member; schoolId: string; restriction: Restriction; onClose: () => void; onChanged: () => void
}) {
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})

  const lift = useMutation({
    mutationFn: (body: LiftMemberRestrictionRequest) => api.members.liftRestriction(schoolId, member.id, restriction.id, body),
    onSuccess: () => {
      toast.success('Restriction lifted')
      onChanged()
      onClose()
    },
    onError: (err) => {
      if (isApiError(err, 'VERSION_CONFLICT')) onChanged()
      const message = describeRestrictionError(err)
      setErrors({ [FORM_ERROR]: message })
      toast.error(message)
    },
  })

  const submit = () => {
    const checked = validate(LiftMemberRestrictionRequest, { expectedVersion: restriction.version, reason }, LIFT_LABELS)
    if (!checked.ok) { setErrors(checked.errors); return }
    setErrors({})
    lift.mutate(checked.data)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Lift this restriction?</DialogTitle>
          <DialogDescription>
            {member.displayName} can see {RESTRICTION_LABEL[restriction.permission]} again wherever their roles allow.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 px-6">
          <Field label="Reason" error={errors.reason}>
            <Textarea aria-label="Why are you lifting it?" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Now handles the medical room" />
          </Field>
          {errors[FORM_ERROR] && <p role="alert" className="text-[12px] text-tag-red">{errors[FORM_ERROR]}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={lift.isPending} onClick={submit}>Lift restriction</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
