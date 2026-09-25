import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import {
  ACTIVE_PERMISSION_KEYS,
  MEMBERSHIP_TRANSITIONS,
  PERMISSION_CATALOGUE,
  ROLE_MANAGEMENT_RULES,
  type PermissionKey,
  type RoleKey,
} from '@erp/contracts'
import { api } from '@/lib/api'
import type { Member, MemberPage } from '@/lib/api/members'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { describeError, isApiError } from '@/lib/api-errors'
import { assignableRolesFor, canManageTarget, describePermission, diffRoleChange, roleLabel } from '@/lib/permissions'
import { UserAvatar } from '@/components/shared/avatar'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MemberRestrictions } from './member-restrictions'
import { memberStatusColor, memberStatusLabel, resourceGroupLabel, roleColor } from './settings-tabs'

type LifecycleEvent = 'suspend' | 'remove' | 'restore'

/** The roles a person may actually be given: ownership transfers, students cannot sign in. */
type AssignableRole = Exclude<RoleKey, 'owner' | 'student'>

const EVENT_PERMISSION: Record<LifecycleEvent, PermissionKey> = {
  suspend: 'members.suspend',
  remove: 'members.remove',
  restore: 'members.restore',
}

const EVENT_LABEL: Record<LifecycleEvent, string> = {
  suspend: 'Suspend',
  remove: 'Remove',
  restore: 'Restore',
}

/** Who this actor may act on at all, in their own words, from the rules the server enforces. */
function manageableRoles(actorRoleKeys: readonly string[]): RoleKey[] {
  const roles = new Set<RoleKey>()
  for (const role of actorRoleKeys) {
    const rule = ROLE_MANAGEMENT_RULES[role as RoleKey]
    if (!rule) continue
    for (const target of rule.manageableTargetRoles) roles.add(target)
  }
  return [...roles]
}

/** The sentence a person reads instead of a control they may not use. */
function refusalFor(options: { isSelf: boolean; isOwner: boolean; canManage: boolean; actorRoleKeys: readonly string[] }): string | null {
  if (options.isSelf) return 'You cannot change your own access.'
  if (options.isOwner) return "Only an owner can change an owner's access."
  if (!options.canManage) {
    const roles = manageableRoles(options.actorRoleKeys)
    if (roles.length === 0) return 'You cannot manage anyone in this school.'
    return `You can only manage ${roles.map((role) => `${roleLabel(role).toLowerCase()}s`).join(' and ')}.`
  }
  return null
}

/** The server refuses some changes without a fresh second step. Offer the way back. */
function FreshAuthNotice({ message }: { message: string }) {
  const navigate = useNavigate()
  const returnTo = typeof window === 'undefined' ? '/settings/users' : `${window.location.pathname}${window.location.search}`
  return (
    <div className="grid gap-2 rounded-xl border p-3">
      <p className="text-[13px] text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" className="justify-self-start" onClick={() => { void navigate({ to: '/mfa/verify', search: { returnTo } } as never) }}>
        Verify with your authenticator
      </Button>
    </div>
  )
}

export function MemberSheet({ member, onOpenChange, onUpdated }: {
  member: Member | null; onOpenChange: (open: boolean) => void; onUpdated: (next: Member) => void
}) {
  return (
    <Sheet open={!!member} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-xl">
        {member && <MemberSheetBody key={member.id} member={member} onUpdated={onUpdated} />}
      </SheetContent>
    </Sheet>
  )
}

function MemberSheetBody({ member, onUpdated }: { member: Member; onUpdated: (next: Member) => void }) {
  const { schoolId, membershipId, roleKeys, hasPermission } = useSchoolContext()
  const isSelf = member.id === membershipId
  const isOwner = member.roleKeys.includes('owner')
  const canManage = canManageTarget(roleKeys, member.roleKeys)
  const refusal = refusalFor({ isSelf, isOwner, canManage, actorRoleKeys: roleKeys })
  const showRestrictions = hasPermission('access.manage') && !isSelf
  const queryClient = useQueryClient()

  /** A restriction bumps the person's access version: refetch, then carry on with the fresh summary. */
  const refreshMember = async () => {
    await queryClient.invalidateQueries({ queryKey: [schoolId, 'members'] })
    for (const [, page] of queryClient.getQueriesData<MemberPage>({ queryKey: [schoolId, 'members', 'list'] })) {
      const fresh = page?.items.find((item) => item.id === member.id)
      if (fresh && fresh.accessVersion !== member.accessVersion) { onUpdated(fresh); return }
    }
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2.5">
          <UserAvatar name={member.displayName} size="sm" />
          {member.displayName}
        </SheetTitle>
        <SheetDescription className="flex flex-wrap items-center gap-1.5">
          <Tag color={memberStatusColor[member.status]} dot>{memberStatusLabel[member.status]}</Tag>
          {member.roleKeys.map((role) => <Tag key={role} color={roleColor[role]}>{roleLabel(role)}</Tag>)}
        </SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        <Tabs defaultValue="roles">
          <TabsList>
            <TabsTrigger value="roles">Roles</TabsTrigger>
            <TabsTrigger value="access">Access</TabsTrigger>
            {showRestrictions && <TabsTrigger value="restrictions">Restrictions</TabsTrigger>}
            <TabsTrigger value="signin">Sign-in help</TabsTrigger>
            {hasPermission('access.explain') && <TabsTrigger value="why">Why access?</TabsTrigger>}
          </TabsList>
          <TabsContent value="roles" className="pt-4">
            <RolesTab member={member} schoolId={schoolId} actorRoleKeys={roleKeys} refusal={refusal} canAssign={hasPermission('roles.assign')} onUpdated={onUpdated} />
          </TabsContent>
          <TabsContent value="access" className="pt-4">
            <LifecycleTab member={member} schoolId={schoolId} actorRoleKeys={roleKeys} refusal={refusal} hasPermission={hasPermission} onUpdated={onUpdated} />
          </TabsContent>
          {showRestrictions && (
            <TabsContent value="restrictions" className="pt-4">
              <MemberRestrictions member={member} schoolId={schoolId} onChanged={() => { void refreshMember() }} />
            </TabsContent>
          )}
          <TabsContent value="signin" className="pt-4">
            <RecoveryTab member={member} schoolId={schoolId} refusal={refusal} allowed={hasPermission('members.manage_credentials')} />
          </TabsContent>
          {hasPermission('access.explain') && (
            <TabsContent value="why" className="pt-4">
              <ExplainTab member={member} schoolId={schoolId} />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </>
  )
}

// ---------- roles ----------

function RolesTab({ member, schoolId, actorRoleKeys, refusal, canAssign, onUpdated }: {
  member: Member; schoolId: string; actorRoleKeys: string[]; refusal: string | null; canAssign: boolean
  onUpdated: (next: Member) => void
}) {
  const queryClient = useQueryClient()
  const assignable = useMemo(() => assignableRolesFor(actorRoleKeys) as AssignableRole[], [actorRoleKeys])
  const [selected, setSelected] = useState<AssignableRole[]>(() => member.roleKeys.filter((role): role is AssignableRole => assignable.includes(role as AssignableRole)))
  const [reason, setReason] = useState('')
  const [fresh, setFresh] = useState<string | null>(null)

  const diff = useMemo(() => diffRoleChange(member.roleKeys, selected), [member.roleKeys, selected])

  const save = useMutation({
    mutationFn: () => api.members.changeRoles(schoolId, member.id, {
      roleKeys: selected,
      expectedVersion: member.accessVersion,
      reason: reason.trim(),
    }),
    onSuccess: (next) => {
      onUpdated(next)
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'members'] })
      setFresh(null)
      toast.success('Saved the new roles')
    },
    onError: (error) => {
      if (isApiError(error, 'VERSION_CONFLICT')) void queryClient.invalidateQueries({ queryKey: [schoolId, 'members'] })
      if (isApiError(error, 'FRESH_AUTHENTICATION_REQUIRED')) setFresh(describeError(error))
      toast.error(describeError(error))
    },
  })

  if (!canAssign) return <p className="text-[13px] text-muted-foreground">You cannot change what people can do here.</p>
  if (refusal) return <p className="text-[13px] text-muted-foreground">{refusal}</p>

  const valid = selected.length > 0 && reason.trim().length >= 3

  return (
    <div className="grid gap-4">
      <div className="grid gap-2 rounded-xl border p-3">
        {assignable.map((role) => (
          <label key={role} className="flex items-center gap-2.5 text-[13.5px]">
            <Checkbox
              checked={selected.includes(role)}
              onCheckedChange={() => setSelected((current) => current.includes(role) ? current.filter((r) => r !== role) : [...current, role])}
              aria-label={roleLabel(role)}
            />
            <span>{roleLabel(role)}</span>
          </label>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-[12.5px] font-medium">This person gains</p>
          <ul className="mt-1 space-y-1 text-[12.5px] text-muted-foreground">
            {diff.added.length === 0 ? <li>Nothing new.</li> : diff.added.map((key) => <li key={key}>{describePermission(key)}</li>)}
          </ul>
        </div>
        <div>
          <p className="text-[12.5px] font-medium">This person loses</p>
          <ul className="mt-1 space-y-1 text-[12.5px] text-muted-foreground">
            {diff.removed.length === 0 ? <li>Nothing.</li> : diff.removed.map((key) => <li key={key}>{describePermission(key)}</li>)}
          </ul>
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="roles-reason">Why are you changing this?</Label>
        <Textarea id="roles-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Moved to the front office" />
      </div>

      {fresh && <FreshAuthNotice message={fresh} />}

      <div className="flex items-center gap-3">
        <Button disabled={!valid || save.isPending} onClick={() => save.mutate()}>Save changes</Button>
        {!valid && <span className="text-[12.5px] text-muted-foreground">Pick at least one role and say why.</span>}
      </div>
    </div>
  )
}

// ---------- lifecycle ----------

function LifecycleTab({ member, schoolId, actorRoleKeys, refusal, hasPermission, onUpdated }: {
  member: Member; schoolId: string; actorRoleKeys: string[]; refusal: string | null; hasPermission: (key: PermissionKey) => boolean
  onUpdated: (next: Member) => void
}) {
  const queryClient = useQueryClient()
  const assignable = useMemo(() => assignableRolesFor(actorRoleKeys) as AssignableRole[], [actorRoleKeys])
  const [confirm, setConfirm] = useState<'suspend' | 'remove' | null>(null)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [restoreRoles, setRestoreRoles] = useState<AssignableRole[]>(() => member.roleKeys.filter((role): role is AssignableRole => assignable.includes(role as AssignableRole)))
  const [fresh, setFresh] = useState<string | null>(null)

  const events = MEMBERSHIP_TRANSITIONS
    .filter((transition) => transition.from === member.status)
    .map((transition) => transition.event as LifecycleEvent)
    .filter((event) => hasPermission(EVENT_PERMISSION[event]))

  const onError = (error: unknown) => {
    if (isApiError(error, 'VERSION_CONFLICT')) void queryClient.invalidateQueries({ queryKey: [schoolId, 'members'] })
    if (isApiError(error, 'FRESH_AUTHENTICATION_REQUIRED')) setFresh(describeError(error))
    toast.error(describeError(error))
  }

  const onDone = (next: Member, message: string) => {
    onUpdated(next)
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'members'] })
    setReason('')
    setConfirm(null)
    setRestoreOpen(false)
    setFresh(null)
    toast.success(message)
  }

  const act = useMutation({
    mutationFn: (event: 'suspend' | 'remove') =>
      (event === 'suspend' ? api.members.suspend : api.members.remove)(schoolId, member.id, {
        expectedVersion: member.accessVersion,
        reason: reason.trim(),
      }),
    onSuccess: (next, event) => onDone(next, event === 'suspend' ? 'Suspended this person' : 'Removed this person'),
    onError,
  })

  const restore = useMutation({
    mutationFn: () => api.members.restore(schoolId, member.id, {
      roleKeys: restoreRoles,
      expectedVersion: member.accessVersion,
      reason: reason.trim(),
    }),
    onSuccess: (next) => onDone(next, 'Restored this person'),
    onError,
  })

  if (refusal) return <p className="text-[13px] text-muted-foreground">{refusal}</p>
  if (events.length === 0) return <p className="text-[13px] text-muted-foreground">There is nothing you can change about this person's access.</p>

  const reasonValid = reason.trim().length >= 3

  return (
    <div className="grid gap-3">
      <p className="text-[13px] text-muted-foreground">This person is {memberStatusLabel[member.status].toLowerCase()}.</p>
      <div className="flex flex-wrap gap-2">
        {events.map((event) => (
          <Button
            key={event}
            variant="outline"
            onClick={() => { setReason(''); if (event === 'restore') setRestoreOpen(true); else setConfirm(event) }}
          >
            {EVENT_LABEL[event]}
          </Button>
        ))}
      </div>
      {fresh && <FreshAuthNotice message={fresh} />}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === 'remove' ? 'Remove this person?' : 'Suspend this person?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'remove'
                ? `${member.displayName} loses access to this school. You can restore them later.`
                : `${member.displayName} cannot sign in to this school until you restore them.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1.5 px-6">
            <Label htmlFor="lifecycle-reason">Why?</Label>
            <Textarea id="lifecycle-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Left the school" />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button disabled={!reasonValid || act.isPending} onClick={() => confirm && act.mutate(confirm)}>
              {confirm === 'remove' ? 'Remove' : 'Suspend'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={restoreOpen} onOpenChange={setRestoreOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore {member.displayName}</DialogTitle>
            <DialogDescription>Choose the roles they come back with.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 px-6">
            <div className="grid gap-2 rounded-xl border p-3">
              {assignable.map((role) => (
                <label key={role} className="flex items-center gap-2.5 text-[13.5px]">
                  <Checkbox
                    checked={restoreRoles.includes(role)}
                    onCheckedChange={() => setRestoreRoles((current) => current.includes(role) ? current.filter((r) => r !== role) : [...current, role])}
                    aria-label={roleLabel(role)}
                  />
                  <span>{roleLabel(role)}</span>
                </label>
              ))}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="restore-reason">Why?</Label>
              <Textarea id="restore-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Back from leave" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestoreOpen(false)}>Cancel</Button>
            <Button disabled={!reasonValid || restoreRoles.length === 0 || restore.isPending} onClick={() => restore.mutate()}>Restore</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------- sign-in help ----------

function RecoveryTab({ member, schoolId, refusal, allowed }: { member: Member; schoolId: string; refusal: string | null; allowed: boolean }) {
  const [reason, setReason] = useState('')
  const [fresh, setFresh] = useState<string | null>(null)

  const start = useMutation({
    mutationFn: () => api.members.startRecovery(schoolId, member.id, { expectedVersion: member.accessVersion, reason: reason.trim() }),
    onSuccess: () => { setReason(''); setFresh(null); toast.success('We have queued a reset for this person.') },
    onError: (error) => {
      if (isApiError(error, 'FRESH_AUTHENTICATION_REQUIRED')) setFresh(describeError(error))
      toast.error(describeError(error))
    },
  })

  if (!allowed) return <p className="text-[13px] text-muted-foreground">You cannot help with sign-in for this person.</p>
  if (refusal) return <p className="text-[13px] text-muted-foreground">{refusal}</p>
  if (member.status !== 'active') return <p className="text-[13px] text-muted-foreground">Only an active person can be sent a sign-in reset.</p>

  const valid = reason.trim().length >= 3

  return (
    <div className="grid gap-3">
      <p className="text-[13px] text-muted-foreground">We send this person a way to set up their sign-in again.</p>
      <div className="grid gap-1.5">
        <Label htmlFor="recovery-reason">Why?</Label>
        <Textarea id="recovery-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Cannot sign in on their phone" />
      </div>
      {fresh && <FreshAuthNotice message={fresh} />}
      <div className="flex items-center gap-3">
        <Button disabled={!valid || start.isPending} onClick={() => start.mutate()}>Send a sign-in reset</Button>
        {!valid && <span className="text-[12.5px] text-muted-foreground">Say why first.</span>}
      </div>
    </div>
  )
}

// ---------- why access ----------

const PERMISSION_GROUPS = ACTIVE_PERMISSION_KEYS.reduce<Record<string, PermissionKey[]>>((groups, key) => {
  const group = key.split('.')[0] ?? 'other'
  ;(groups[group] ??= []).push(key)
  return groups
}, {})

function ExplainTab({ member, schoolId }: { member: Member; schoolId: string }) {
  const prefillFor = (key: PermissionKey) => {
    const kind = PERMISSION_CATALOGUE[key].resourceType
    if (kind === 'membership') return member.id
    if (kind === 'staff') return member.staffId ?? ''
    return ''
  }
  const [permission, setPermission] = useState<PermissionKey>('members.read')
  const [resourceId, setResourceId] = useState(() => prefillFor('members.read'))
  const [asked, setAsked] = useState<{ permission: PermissionKey; resourceType: string; resourceId: string } | null>(null)

  const resourceType = PERMISSION_CATALOGUE[permission].resourceType

  const { data, isFetching, error } = useQuery({
    queryKey: qk.accessExplanation(schoolId, member.id, asked ?? {}),
    queryFn: () => api.members.accessExplanation(schoolId, member.id, {
      permission: asked!.permission,
      resourceType: asked!.resourceType as never,
      resourceId: asked!.resourceId,
    }),
    enabled: asked !== null,
  })

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="explain-permission">What are you checking?</Label>
        <Select value={permission} onValueChange={(value) => {
          const key = value as PermissionKey
          setPermission(key)
          if (PERMISSION_CATALOGUE[key].resourceType !== PERMISSION_CATALOGUE[permission].resourceType) setResourceId(prefillFor(key))
          setAsked(null)
        }}>
          <SelectTrigger id="explain-permission"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(PERMISSION_GROUPS).map(([group, keys]) => (
              <SelectGroup key={group}>
                <SelectLabel>{resourceGroupLabel(group)}</SelectLabel>
                {keys.map((key) => <SelectItem key={key} value={key}>{describePermission(key)}</SelectItem>)}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="explain-resource-type">Kind of record</Label>
        <Input id="explain-resource-type" value={resourceType} readOnly />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="explain-resource-id">Record id</Label>
        <Input id="explain-resource-id" value={resourceId} onChange={(e) => { setResourceId(e.target.value); setAsked(null) }} placeholder="Paste the record id" />
      </div>
      <Button
        className="justify-self-start"
        disabled={resourceId.trim() === '' || isFetching}
        onClick={() => setAsked({ permission, resourceType, resourceId: resourceId.trim() })}
      >
        Check
      </Button>
      {error && <p className="text-[13px] text-muted-foreground">{describeError(error)}</p>}
      {data && (
        <div className="grid gap-2 rounded-xl border p-3">
          <Tag color={data.allowed ? 'green' : 'red'} dot>{data.allowed ? 'Allowed' : 'Not allowed'}</Tag>
          <ul className="space-y-1 text-[12.5px] text-muted-foreground">
            {data.sources.length === 0
              ? <li>Nothing gives this access.</li>
              : data.sources.map((source, index) => <li key={index}><span className="font-medium text-foreground">{source.kind}</span> — {source.description}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}
