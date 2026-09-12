import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { UserInput, type Role } from '@erp/shared'
import { api, type UserRow } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { qk } from '@/lib/query'
import { fullName } from '@/lib/utils'
import { Tag } from '@/components/shared/tag'
import { roleColor } from './settings-tabs'

function RoleCheckboxes({ roles, value, onChange, error }: { roles: Role[]; value: string[]; onChange: (v: string[]) => void; error?: string }) {
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  return (
    <div className="space-y-1.5">
      <Label>Roles</Label>
      <div className="divide-y rounded-lg border">
        {roles.map((r) => (
          <label key={r.id} className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-accent/50">
            <Checkbox checked={value.includes(r.id)} onCheckedChange={() => toggle(r.id)} className="mt-0.5" />
            <span className="min-w-0">
              <span className="flex items-center gap-2">
                <span className="text-[13.5px] font-medium">{r.name}</span>
                <Tag color={roleColor[r.key]}>{r.key}</Tag>
              </span>
              {r.description && <span className="mt-0.5 block text-[12.5px] text-muted-foreground">{r.description}</span>}
            </span>
          </label>
        ))}
      </div>
      {error && <p className="text-[12.5px] text-tag-red">{error}</p>}
    </div>
  )
}

/** Invite a new login */
export function InviteUserSheet({ open, onOpenChange, roles }: { open: boolean; onOpenChange: (v: boolean) => void; roles: Role[] }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [roleIds, setRoleIds] = useState<string[]>([])
  const [staffId, setStaffId] = useState<string>('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (open) { setName(''); setPhone(''); setEmail(''); setRoleIds([]); setStaffId(''); setErrors({}) }
  }, [open])

  const { data: staffList } = useQuery({ queryKey: qk.staff({ forInvite: true }), queryFn: () => api.staff.list({ pageSize: 200 }) })

  const create = useMutation({
    mutationFn: (input: UserInput) => api.users.create(input),
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: qk.users })
      qc.invalidateQueries({ queryKey: qk.auditLogs() })
      toast.success(`Invited ${u.name}`)
      onOpenChange(false)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const submit = () => {
    const parsed = UserInput.safeParse({
      name: name.trim(),
      phone: phone.trim(),
      email: email.trim() || undefined,
      roleIds,
      staffId: staffId || undefined,
      status: 'invited',
    })
    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues) next[String(issue.path[0] ?? 'form')] = issue.message
      setErrors(next)
      return
    }
    setErrors({})
    create.mutate(parsed.data)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Invite user</SheetTitle>
          <SheetDescription>They will sign in with this phone number and an OTP.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto scrollbar-thin px-4 pb-4">
          <div className="space-y-1.5">
            <Label htmlFor="iu-name">Name</Label>
            <Input id="iu-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Meera Nair" />
            {errors.name && <p className="text-[12.5px] text-tag-red">{errors.name}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="iu-phone">Phone</Label>
            <Input id="iu-phone" value={phone} inputMode="numeric" maxLength={10} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} placeholder="9876543210" className="font-mono" />
            {errors.phone && <p className="text-[12.5px] text-tag-red">{errors.phone}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="iu-email">Email (optional)</Label>
            <Input id="iu-email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="meera@school.in" />
            {errors.email && <p className="text-[12.5px] text-tag-red">{errors.email}</p>}
          </div>
          <RoleCheckboxes roles={roles} value={roleIds} onChange={setRoleIds} error={errors.roleIds} />
          <div className="space-y-1.5">
            <Label>Link to staff member (optional)</Label>
            <Select value={staffId || 'none'} onValueChange={(v) => setStaffId(v === 'none' ? '' : v)}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Not linked" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not linked</SelectItem>
                {(staffList?.items ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>{fullName(s)} — {s.designation}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={create.isPending}>{create.isPending ? 'Inviting…' : 'Send invite'}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/** Change which roles a user has */
export function EditRolesSheet({ user, onOpenChange, roles }: { user: UserRow | null; onOpenChange: (v: boolean) => void; roles: Role[] }) {
  const qc = useQueryClient()
  const [roleIds, setRoleIds] = useState<string[]>([])
  const [error, setError] = useState<string>()

  useEffect(() => { if (user) { setRoleIds(user.roleIds); setError(undefined) } }, [user])

  const save = useMutation({
    mutationFn: () => api.users.update(user!.id, { roleIds }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.users })
      qc.invalidateQueries({ queryKey: qk.auditLogs() })
      toast.success(`Updated roles for ${user!.name}`)
      onOpenChange(false)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <Sheet open={!!user} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Edit roles</SheetTitle>
          <SheetDescription>{user?.name}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4 pb-4">
          <RoleCheckboxes roles={roles} value={roleIds} onChange={setRoleIds} error={error} />
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            size="sm"
            disabled={save.isPending}
            onClick={() => { if (roleIds.length === 0) { setError('Pick at least one role'); return } save.mutate() }}
          >
            Save changes
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
