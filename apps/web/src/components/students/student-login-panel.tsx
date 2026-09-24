/**
 * A pupil's own login, as the office sees it on the pupil's page.
 *
 * The server says what state the login is in, what stands in the way of one and whether this
 * person may act on it (`allowedActions`). This panel only turns that into words and offers the
 * one or two actions the state allows. No password is ever shown here: the server texts it to the
 * primary guardian and never sends it back.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Power, PowerOff, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { StudentLoginBlocker, StudentLoginState } from '@erp/contracts'
import { Facts, Panel } from '@/components/shared/page'
import { Tag, type TagColor } from '@/components/shared/tag'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import type { StudentLogin } from '@/lib/api/student-logins'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { formatDate } from '@/lib/utils'

export const LOGIN_STATE_LABEL: Readonly<Record<StudentLoginState, string>> = {
  none: 'No login',
  active: 'On',
  switched_off: 'Switched off',
  ended: 'Ended',
}

const LOGIN_STATE_COLOR: Readonly<Record<StudentLoginState, TagColor>> = {
  none: 'grey',
  active: 'green',
  switched_off: 'yellow',
  ended: 'grey',
}

export const LOGIN_BLOCKER_SENTENCE: Readonly<Record<StudentLoginBlocker, string>> = {
  not_senior: 'Only pupils in Class 9 to 12 get a login.',
  no_guardian_phone: 'The primary guardian has no phone number. Add one to send the password.',
  not_on_roll: 'This pupil is not on the roll.',
}

/** Which actions the state allows. Permission is read separately from the record's allowedActions. */
export function loginActionsFor(login: Pick<StudentLogin, 'state' | 'blocker' | 'version'>) {
  return {
    give: (login.state === 'none' || login.state === 'ended') && !login.blocker,
    resetPassword: login.state === 'active' || login.state === 'switched_off',
    switchOff: login.state === 'active' && login.version !== undefined,
    switchOn: login.state === 'switched_off' && login.version !== undefined,
  }
}

type Confirm = 'reset' | 'off' | 'on' | null

export function StudentLoginPanel({ studentId }: { studentId: string }) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | null>(null)

  const loginQuery = useQuery({
    queryKey: qk.studentLogins.detail(schoolId, studentId),
    queryFn: () => api.studentLogins.get(schoolId, studentId),
  })

  const done = (message: string) => {
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'studentLogins'] })
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'students'] })
    toast.success(message)
    setConfirm(null)
  }
  const failed = (error: unknown) => toast.error(describeError(error))

  const give = useMutation({
    mutationFn: () => api.studentLogins.issue(schoolId, studentId),
    onSuccess: () => done("Login given. The password was sent to the parent's phone."),
    onError: failed,
  })
  const reset = useMutation({
    mutationFn: () => api.studentLogins.resetPassword(schoolId, studentId),
    onSuccess: () => done("New password sent to the parent's phone. The pupil has been signed out."),
    onError: failed,
  })
  const switchOff = useMutation({
    mutationFn: (body: { expectedVersion: number; reason?: string }) => api.studentLogins.switchOff(schoolId, studentId, body),
    onSuccess: () => done('Login switched off. The pupil has been signed out.'),
    onError: failed,
  })
  const switchOn = useMutation({
    mutationFn: (expectedVersion: number) => api.studentLogins.switchOn(schoolId, studentId, { expectedVersion }),
    onSuccess: () => done('Login switched on. The pupil can sign in again.'),
    onError: failed,
  })

  if (loginQuery.isError) {
    return <Panel title="Student login"><p className="text-[13px] text-muted-foreground">{describeError(loginQuery.error)}</p></Panel>
  }
  const login = loginQuery.data
  if (!login) {
    return <Panel title="Student login"><Skeleton className="h-16" /></Panel>
  }

  const canManage = allows(login.allowedActions, 'students.manage_login')
  const actions = loginActionsFor(login)
  const hasLogin = login.state === 'active' || login.state === 'switched_off'

  const submitSwitchOff = () => {
    if (login.version === undefined) return
    const text = reason.trim()
    if (text !== '' && text.length < 3) {
      setReasonError('Write a few more words, or leave the reason empty.')
      return
    }
    setReasonError(null)
    switchOff.mutate({ expectedVersion: login.version, ...(text ? { reason: text } : {}) })
  }

  return (
    <Panel
      title="Student login"
      description="Pupils in Class 9 to 12 sign in with the school code, their admission number and a password."
      actions={
        canManage ? (
          <div className="flex flex-wrap justify-end gap-2">
            {actions.give && (
              <Button size="sm" variant="outline" disabled={give.isPending} onClick={() => give.mutate()}>
                <KeyRound />{give.isPending ? 'Giving…' : 'Give login'}
              </Button>
            )}
            {actions.resetPassword && (
              <Button size="sm" variant="outline" onClick={() => setConfirm('reset')}><RotateCcw />Send new password</Button>
            )}
            {actions.switchOff && (
              <Button size="sm" variant="outline" onClick={() => { setReason(''); setReasonError(null); setConfirm('off') }}>
                <PowerOff />Switch off login
              </Button>
            )}
            {actions.switchOn && (
              <Button size="sm" variant="outline" onClick={() => setConfirm('on')}><Power />Switch on login</Button>
            )}
          </div>
        ) : undefined
      }
    >
      <Facts
        columns={3}
        items={[
          { label: 'State', value: <Tag color={LOGIN_STATE_COLOR[login.state]}>{LOGIN_STATE_LABEL[login.state]}</Tag> },
          { label: 'Username', value: <span className="font-mono">{login.username}</span> },
          { label: 'School code', value: <span className="font-mono">{login.schoolCode}</span> },
          ...(hasLogin
            ? [{ label: 'Password', value: login.passwordChangePending ? 'Still the one sent to the parent' : 'Changed by the pupil' }]
            : []),
          { label: 'Sent to', value: login.guardianPhoneMasked },
          { label: 'Issued', value: login.issuedAt ? formatDate(login.issuedAt) : undefined },
          { label: 'Last signed in', value: login.lastSignInAt ? formatDate(login.lastSignInAt) : undefined },
        ]}
      />
      {login.blocker && <p className="mt-3 text-[13px] text-muted-foreground">{LOGIN_BLOCKER_SENTENCE[login.blocker]}</p>}

      <AlertDialog open={confirm === 'reset'} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send a new password?</AlertDialogTitle>
            <AlertDialogDescription>
              The pupil is signed out everywhere, and a new password is texted to the primary guardian's phone. The old
              password stops working at once.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button disabled={reset.isPending} onClick={() => reset.mutate()}>
              {reset.isPending ? 'Sending…' : 'Send new password'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm === 'off'} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch off this login?</AlertDialogTitle>
            <AlertDialogDescription>
              The pupil is signed out and cannot sign in until the login is switched on again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1.5 px-1">
            <Label htmlFor="switch-off-reason">Reason (optional)</Label>
            <Textarea id="switch-off-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            {reasonError && <p className="text-[12px] text-destructive">{reasonError}</p>}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={switchOff.isPending} onClick={submitSwitchOff}>
              {switchOff.isPending ? 'Switching off…' : 'Switch off login'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm === 'on'} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch on this login?</AlertDialogTitle>
            <AlertDialogDescription>The pupil can sign in again with the password they already have.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              disabled={switchOn.isPending}
              onClick={() => { if (login.version !== undefined) switchOn.mutate(login.version) }}
            >
              {switchOn.isPending ? 'Switching on…' : 'Switch on login'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  )
}

/** "12 logins given. 2 pupils have no guardian phone number." Counts only, never a name. */
export function issuedSummary(result: { issued: number; noGuardianPhone: number; alreadyHadLogin: number; textFailed: number }): string {
  const parts = [`${result.issued} ${result.issued === 1 ? 'login' : 'logins'} given.`]
  if (result.noGuardianPhone > 0) {
    parts.push(`${result.noGuardianPhone} ${result.noGuardianPhone === 1 ? 'pupil has' : 'pupils have'} no guardian phone number.`)
  }
  if (result.textFailed > 0) {
    parts.push(`${result.textFailed} ${result.textFailed === 1 ? 'password text' : 'password texts'} could not be sent: send a new password from the pupil's page.`)
  }
  return parts.join(' ')
}

/** The students list's "Give student logins": every pupil in Class 9 to 12 without a login gets one. */
export function GiveStudentLoginsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const issue = useMutation({
    mutationFn: () => api.studentLogins.issueMissing(schoolId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'studentLogins'] })
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'students'] })
      toast.success(issuedSummary(result))
      onOpenChange(false)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Give student logins?</AlertDialogTitle>
          <AlertDialogDescription>
            Every pupil in Class 9 to 12 who has no login gets one. Each password is texted to the pupil's primary
            guardian, and the pupil chooses their own password the first time they sign in. Pupils who already have a
            login are left as they are.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button disabled={issue.isPending} onClick={() => issue.mutate()}>
            {issue.isPending ? 'Giving logins…' : 'Give student logins'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
