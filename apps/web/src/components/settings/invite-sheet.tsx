import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Check, Search } from 'lucide-react'
import { InviteMemberRequest, type RoleKey } from '@erp/contracts'
import { api } from '@/lib/api'
import type { Invitation } from '@/lib/api/members'

/** The roles a person may actually be given: ownership transfers, students cannot sign in. */
type AssignableRole = Exclude<RoleKey, 'owner' | 'student'>
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { describeError } from '@/lib/api-errors'
import { assignableRolesFor, roleLabel } from '@/lib/permissions'
import { formatDate } from '@/lib/utils'
import { Facts, Panel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { roleColor } from './settings-tabs'

/** Ten digits, the way an Indian mobile is typed. The contract wants +91 in front of it. */
const TEN_DIGITS = /^\d{10}$/

function identifierFor(contact: string) {
  const trimmed = contact.trim()
  const digits = trimmed.replace(/[\s-]/g, '')
  if (TEN_DIGITS.test(digits)) return { kind: 'phone' as const, value: `+91${digits}` }
  return { kind: 'email' as const, value: trimmed }
}

export interface InviteSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Prefill from the staff login tab: ?invite=<staffId>&name=<display name>. */
  prefill?: { staffId?: string; displayName?: string }
  onInvited: (invitation: Invitation) => void
}

export function InviteSheet({ open, onOpenChange, prefill, onInvited }: InviteSheetProps) {
  const { schoolId, roleKeys } = useSchoolContext()
  const queryClient = useQueryClient()
  const assignable = useMemo(() => assignableRolesFor(roleKeys) as AssignableRole[], [roleKeys])

  const [displayName, setDisplayName] = useState('')
  const [contact, setContact] = useState('')
  const [selectedRoles, setSelectedRoles] = useState<AssignableRole[]>([])
  const [staffId, setStaffId] = useState<string | undefined>(undefined)
  const [staffLabel, setStaffLabel] = useState('')
  const [staffQuery, setStaffQuery] = useState('')
  const [staffOpen, setStaffOpen] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return
    setDisplayName(prefill?.displayName ?? '')
    setContact('')
    setSelectedRoles([])
    setStaffId(prefill?.staffId)
    setStaffLabel(prefill?.staffId ? (prefill.displayName ?? 'Selected staff record') : '')
    setStaffQuery('')
    setErrors({})
    // Only when the sheet opens: reopening is what resets the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const needsStaff = selectedRoles.some((role) => role !== 'parent')

  const { data: staffMatches = [] } = useQuery({
    queryKey: qk.staffSearch(schoolId, staffQuery.trim()),
    queryFn: () => api.staff.search(schoolId, staffQuery.trim()),
    enabled: open && needsStaff && staffQuery.trim().length >= 2,
  })

  const invite = useMutation({
    mutationFn: () =>
      api.members.invite(schoolId, {
        displayName: displayName.trim(),
        identifier: identifierFor(contact),
        roleKeys: selectedRoles,
        ...(needsStaff && staffId ? { staffId } : {}),
      }),
    onSuccess: (invitation) => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'members'] })
      toast.success('Invitation sent')
      onInvited(invitation)
      onOpenChange(false)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const submit = () => {
    const candidate = {
      displayName: displayName.trim(),
      identifier: identifierFor(contact),
      roleKeys: selectedRoles,
      ...(needsStaff && staffId ? { staffId } : {}),
    }
    const parsed = InviteMemberRequest.safeParse(candidate)
    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? 'form')
        next[field] ??= issue.message
      }
      if (next.identifier) next.identifier = 'Enter an email address or a 10 digit mobile number.'
      if (next.roleKeys) next.roleKeys = 'Pick at least one role.'
      setErrors(next)
      return
    }
    setErrors({})
    invite.mutate()
  }

  const toggleRole = (role: AssignableRole) => {
    setSelectedRoles((current) => (current.includes(role) ? current.filter((r) => r !== role) : [...current, role]))
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Invite someone</SheetTitle>
          <SheetDescription>They get a link to set up their sign-in. It works for 48 hours.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-6">
          <div className="grid gap-1.5">
            <Label htmlFor="invite-name">Name</Label>
            <Input id="invite-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Asha Rao" />
            {errors.displayName && <p className="text-[12.5px] text-tag-red">{errors.displayName}</p>}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="invite-contact">Email or mobile</Label>
            <Input id="invite-contact" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="asha@school.in or 9876543210" />
            {errors.identifier && <p className="text-[12.5px] text-tag-red">{errors.identifier}</p>}
          </div>

          <div className="grid gap-1.5">
            <span className="text-[12.5px] font-medium">Roles</span>
            <div className="grid gap-2 rounded-xl border p-3">
              {assignable.map((role) => (
                <label key={role} className="flex items-center gap-2.5 text-[13.5px]">
                  <Checkbox checked={selectedRoles.includes(role)} onCheckedChange={() => toggleRole(role)} aria-label={roleLabel(role)} />
                  <span>{roleLabel(role)}</span>
                </label>
              ))}
            </div>
            {errors.roleKeys && <p className="text-[12.5px] text-tag-red">{errors.roleKeys}</p>}
          </div>

          {needsStaff && (
            <div className="grid gap-1.5">
              <span className="text-[12.5px] font-medium">Staff record</span>
              <Popover open={staffOpen} onOpenChange={setStaffOpen}>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" className="justify-start">
                    <Search className="size-4" />
                    {staffLabel || 'Find a staff record'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-0">
                  <Command shouldFilter={false}>
                    <div className="border-b p-2">
                      <Input value={staffQuery} onChange={(e) => setStaffQuery(e.target.value)} placeholder="Type at least 2 letters" className="h-8" aria-label="Search staff" />
                    </div>
                    <CommandList>
                      {staffQuery.trim().length < 2 && <CommandEmpty>Type at least 2 letters.</CommandEmpty>}
                      {staffQuery.trim().length >= 2 && staffMatches.length === 0 && <CommandEmpty>No staff match.</CommandEmpty>}
                      <CommandGroup>
                        {staffMatches.map((person) => (
                          <CommandItem
                            key={person.id}
                            value={person.id}
                            onSelect={() => { setStaffId(person.id); setStaffLabel(person.displayName); setStaffOpen(false) }}
                          >
                            <span className="flex-1 truncate">{person.displayName}</span>
                            <span className="text-[12px] text-muted-foreground">{person.designation}</span>
                            {staffId === person.id && <Check className="size-4" />}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              <p className="text-[12px] text-muted-foreground">Anyone other than a parent needs a staff record.</p>
              {errors.staffId && <p className="text-[12.5px] text-tag-red">{errors.staffId}</p>}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={invite.isPending}>{invite.isPending ? 'Sending…' : 'Send invitation'}</Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

const deliveryColor = { queued: 'orange', sent: 'green', failed: 'red' } as const

/** One invitation created in this session, with the only two things you can still do to it. */
export function InvitationPanel({ invitation, onChanged }: { invitation: Invitation; onChanged: (next: Invitation) => void }) {
  const { schoolId } = useSchoolContext()

  const resend = useMutation({
    mutationFn: () => api.members.resendInvitation(schoolId, invitation.id, { expectedVersion: invitation.version }),
    onSuccess: (next) => { onChanged(next); toast.success('Invitation sent again') },
    onError: (error) => toast.error(describeError(error)),
  })

  const revoke = useMutation({
    mutationFn: () => api.members.revokeInvitation(schoolId, invitation.id, { expectedVersion: invitation.version }),
    onSuccess: (next) => { onChanged(next); toast.success('Invitation cancelled') },
    onError: (error) => toast.error(describeError(error)),
  })

  const isPending = invitation.status === 'pending'

  return (
    <Panel
      title={invitation.displayName}
      description={`Sent to ${invitation.maskedDestination}`}
      actions={isPending ? (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={resend.isPending} onClick={() => resend.mutate()}>Resend</Button>
          <Button size="sm" variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate()}>Revoke</Button>
        </div>
      ) : undefined}
    >
      <Facts
        columns={3}
        items={[
          { label: 'Roles', value: <span className="flex flex-wrap gap-1.5">{invitation.roleKeys.map((role: AssignableRole) => <Tag key={role} color={roleColor[role]}>{roleLabel(role)}</Tag>)}</span> },
          { label: 'Expires', value: formatDate(invitation.expiresAt) },
          { label: 'Delivery', value: <Tag color={deliveryColor[invitation.deliveryStatus]} dot>{invitation.deliveryStatus === 'queued' ? 'Queued' : invitation.deliveryStatus === 'sent' ? 'Sent' : 'Failed'}</Tag> },
        ]}
      />
    </Panel>
  )
}
