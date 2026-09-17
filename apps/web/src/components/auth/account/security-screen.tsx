import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { AlertTriangle, ArrowLeft, Laptop, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Facts, Panel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Field } from '@/components/setup/field'
import { BackupCodes } from '@/components/auth/mfa/backup-codes'
import { RedirectOnce } from '@/components/auth/app-gate'
import { describeError, isApiError } from '@/lib/api-errors'
import { changePassword, listSessions, revokeOtherSessions, revokeSession, twoFactorDisable, twoFactorGenerateBackupCodes, type DeviceSession } from '@/lib/auth-client'
import { useSession } from '@/lib/session'
import { formatDate, timeAgo } from '@/lib/utils'

/** Query keys for this screen only. The shared key list is owned elsewhere. */
const deviceSessionsKey = ['account', 'sessions'] as const

/** Everything a person can change about their own sign-in, without needing a school. */
export function SecurityScreen() {
  const session = useSession()

  if (session.status === 'loading') return <Shell><Skeleton className="h-40 w-full rounded-xl" /></Shell>
  if (session.status === 'anonymous') return <RedirectOnce to="/login" search={{ returnTo: '/account/security' }} />
  if (session.status === 'blocked') return <RedirectOnce to="/access-unavailable" search={{ reason: 'student' }} />
  // Without an answer from the server every panel below would state something untrue: no email, no
  // phone, two-step off. Say what is actually wrong instead.
  if (session.status === 'unavailable') {
    return (
      <Shell>
        <div className="grid justify-items-center gap-3 rounded-xl border bg-card p-6 text-center">
          <div className="flex size-10 items-center justify-center rounded-xl border bg-muted/50 text-tag-orange"><AlertTriangle className="size-5" /></div>
          <p className="text-[15px] font-semibold">We cannot reach the server</p>
          <p className="max-w-sm text-[13px] text-muted-foreground">Nothing has changed on your account. Check your connection and try again.</p>
          <Button className="mt-1 h-11 md:h-9" onClick={() => { void session.refresh() }}>Try again</Button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      <div className="grid gap-4">
        <AccountPanel />
        <PasswordPanel />
        <TwoFactorPanel />
        <SessionsPanel />
        <Panel title="Sign out">
          <p className="mb-3 text-[13px] text-muted-foreground">Sign out of this device only.</p>
          <Button variant="outline" className="h-11 md:h-9" onClick={() => { void session.signOut() }}>Sign out</Button>
        </Panel>
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-background px-4 py-6 md:py-10">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h1 className="text-[15px] font-semibold">Account security</h1>
          <Link to="/dashboard" className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" /> Back to app
          </Link>
        </div>
        <div className="pb-[env(safe-area-inset-bottom)]">{children}</div>
      </div>
    </div>
  )
}

/** An inline error a screen reader announces as soon as it appears. */
function ErrorText({ children }: { children: string | null }) {
  if (!children) return null
  return <p role="alert" className="text-[12px] text-tag-red">{children}</p>
}

function AccountPanel() {
  const { user } = useSession()
  return (
    <Panel title="Account" description="Contact changes are made by your school office.">
      <Facts
        columns={1}
        items={[
          { label: 'Name', value: user?.displayName ?? '—' },
          { label: 'Email', value: user?.email ?? 'Not set' },
          { label: 'Phone', value: user?.phone ?? 'Not set' },
        ]}
      />
    </Panel>
  )
}

function PasswordPanel() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async () => {
    setError(null)
    if (next.length < 12) { setError('Use at least 12 characters.'); return }
    if (next !== confirm) { setError('The two new passwords do not match.'); return }
    setPending(true)
    try {
      await changePassword({ currentPassword: current, newPassword: next })
      setCurrent(''); setNext(''); setConfirm('')
      toast.success('Password changed. Other devices were signed out.')
    } catch (caught) {
      setError(isApiError(caught, 'INVALID_REQUEST') || isApiError(caught, 'AUTHENTICATION_REQUIRED')
        ? 'That current password did not match.'
        : describeError(caught))
    } finally {
      setPending(false)
    }
  }

  return (
    <Panel title="Password" description="Changing it signs you out everywhere else.">
      <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <Field label="Current password">
          <Input id="current-password" type="password" autoComplete="current-password" aria-label="Current password" value={current} disabled={pending} onChange={(e) => setCurrent(e.target.value)} className="h-11 text-[16px] md:h-9 md:text-[13px]" />
        </Field>
        <Field label="New password" hint="At least 12 characters.">
          <Input id="new-password" type="password" autoComplete="new-password" aria-label="New password" value={next} disabled={pending} onChange={(e) => setNext(e.target.value)} className="h-11 text-[16px] md:h-9 md:text-[13px]" />
        </Field>
        <Field label="Confirm new password">
          <Input id="confirm-password" type="password" autoComplete="new-password" aria-label="Confirm new password" value={confirm} disabled={pending} onChange={(e) => setConfirm(e.target.value)} className="h-11 text-[16px] md:h-9 md:text-[13px]" />
          <ErrorText>{error}</ErrorText>
        </Field>
        <div>
          <Button type="submit" className="h-11 md:h-9" disabled={pending || !current || !next}>{pending ? 'Saving…' : 'Change password'}</Button>
        </div>
      </form>
    </Panel>
  )
}

function TwoFactorPanel() {
  const session = useSession()
  const navigate = useNavigate()
  const [codesOpen, setCodesOpen] = useState(false)
  const [offOpen, setOffOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [needsFresh, setNeedsFresh] = useState(false)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [pending, setPending] = useState(false)

  const reset = () => { setPassword(''); setError(null); setPending(false) }

  const generate = async () => {
    setPending(true); setError(null)
    try {
      const result = await twoFactorGenerateBackupCodes(password)
      setCodes(result.backupCodes)
      setPassword('')
      toast.success('New backup codes made. The old ones no longer work.')
    } catch (caught) {
      setError(isApiError(caught, 'INVALID_REQUEST') ? 'That password did not match.' : describeError(caught))
    } finally {
      setPending(false)
    }
  }

  const turnOff = async () => {
    setPending(true); setError(null); setNeedsFresh(false)
    try {
      await twoFactorDisable(password)
      setPassword('')
      setOffOpen(false)
      await session.refresh()
      toast.success('Two-step verification is off.')
    } catch (caught) {
      // The server refuses this change unless a second factor was completed in the last few
      // minutes; an unverified session is turned away as unauthenticated, which looks the same
      // from here, so both lead to the same offer.
      if (isApiError(caught, 'FRESH_AUTHENTICATION_REQUIRED') || isApiError(caught, 'AUTHENTICATION_REQUIRED')) {
        setNeedsFresh(true)
        setError('Verify with your authenticator first, then check your password.')
      } else {
        setError(isApiError(caught, 'INVALID_REQUEST') ? 'That password did not match.' : describeError(caught))
      }
    } finally {
      setPending(false)
    }
  }

  if (!session.twoFactorEnabled) {
    return (
      <Panel title="Two-step verification" description="An authenticator app code as well as your password.">
        <p className="mb-3 text-[13px] text-muted-foreground">Two-step verification is off. Some schools will not open without it.</p>
        <Button className="h-11 md:h-9" onClick={() => { void navigate({ to: '/mfa/setup', search: { returnTo: '/account/security' } } as never) }}>
          <ShieldCheck /> Set up authenticator
        </Button>
      </Panel>
    )
  }

  return (
    <Panel title="Two-step verification" description="An authenticator app code as well as your password.">
      <div className="mb-3 flex items-center gap-2">
        <Tag color="green" dot>On</Tag>
        <span className="text-[13px] text-muted-foreground">Your authenticator app is set up.</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="h-11 md:h-9" onClick={() => { setCodes(null); reset(); setCodesOpen(true) }}>Generate new backup codes</Button>
        <Button variant="outline" className="h-11 md:h-9" onClick={() => { reset(); setNeedsFresh(false); setOffOpen(true) }}>Turn off</Button>
      </div>

      <Dialog open={codesOpen} onOpenChange={(open) => { setCodesOpen(open); if (!open) { reset(); setCodes(null) } }}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New backup codes</DialogTitle>
            <DialogDescription>Confirm your password. The codes you have now will stop working.</DialogDescription>
          </DialogHeader>
          {codes ? <BackupCodes codes={codes} /> : (
            <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void generate() }}>
              <Field label="Your password">
                <Input type="password" autoComplete="current-password" aria-label="Your password" value={password} disabled={pending} onChange={(e) => setPassword(e.target.value)} className="h-11 text-[16px] md:h-9 md:text-[13px]" />
                <ErrorText>{error}</ErrorText>
              </Field>
              <DialogFooter>
                <Button type="submit" className="h-11 md:h-9" disabled={pending || !password}>{pending ? 'Working…' : 'Generate codes'}</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={offOpen} onOpenChange={(open) => { setOffOpen(open); if (!open) reset() }}>
        <AlertDialogContent className="max-h-[85dvh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off two-step verification?</AlertDialogTitle>
            <AlertDialogDescription>Schools that need a second step will stop opening for you.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-3">
            <Field label="Your password">
              <Input type="password" autoComplete="current-password" aria-label="Your password" value={password} disabled={pending} onChange={(e) => setPassword(e.target.value)} className="h-11 text-[16px] md:h-9 md:text-[13px]" />
              <ErrorText>{error}</ErrorText>
            </Field>
            {needsFresh && (
              <Button variant="outline" className="h-11 justify-self-start md:h-9" onClick={() => { void navigate({ to: '/mfa/verify', search: { returnTo: '/account/security' } } as never) }}>
                Verify with your authenticator
              </Button>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it on</AlertDialogCancel>
            <AlertDialogAction disabled={pending || !password} onClick={(event) => { event.preventDefault(); void turnOff() }}>Turn off</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  )
}

function SessionsPanel() {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState<DeviceSession | null>(null)
  const sessions = useQuery({ queryKey: deviceSessionsKey, queryFn: listSessions })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: deviceSessionsKey })

  const revokeOne = useMutation({
    mutationFn: (id: string) => revokeSession(id),
    onSuccess: async () => { setConfirming(null); await invalidate(); toast.success('That device was signed out.') },
    onError: (error) => toast.error(describeError(error)),
  })

  const revokeOthers = useMutation({
    mutationFn: () => revokeOtherSessions(),
    onSuccess: async () => { await invalidate(); toast.success('Every other device was signed out.') },
    onError: (error) => toast.error(describeError(error)),
  })

  return (
    <Panel title="Devices" description="Where you are signed in right now.">
      {sessions.isPending && <Skeleton className="h-20 w-full rounded-lg" />}
      {sessions.isError && <p role="alert" className="text-[13px] text-tag-red">{describeError(sessions.error)}</p>}
      {sessions.data && (
        <ul className="grid gap-2">
          {sessions.data.sessions.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
              <Laptop className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">{device.current ? 'This device' : 'Another device'}</p>
                <p className="text-[12px] text-muted-foreground">
                  Signed in {formatDate(device.createdAt)} · last used {timeAgo(device.lastActiveAt)}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <Tag color={device.assurance === 'mfa' ? 'green' : 'grey'}>{device.assurance === 'mfa' ? 'Two-step' : 'Password only'}</Tag>
                {device.sharedDevice && <Tag color="orange">Shared device</Tag>}
              </div>
              <Button variant="outline" size="sm" className="h-11 md:h-7" onClick={() => setConfirming(device)}>Sign out</Button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3">
        <Button variant="outline" className="h-11 md:h-9" disabled={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>
          Sign out everywhere else
        </Button>
      </div>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign this device out?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.current ? 'This is the device you are using now, so you will be signed out here.' : 'That device will have to sign in again.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={revokeOne.isPending}
              onClick={(event) => { event.preventDefault(); if (confirming) revokeOne.mutate(confirming.id) }}
            >
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  )
}
