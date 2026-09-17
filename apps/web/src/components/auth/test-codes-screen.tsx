import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { AuthLayout } from '@/components/auth/auth-layout'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { heldCodes, type HeldCode } from '@/lib/held-codes'
import { timeAgo } from '@/lib/utils'

const PURPOSE: Record<HeldCode['purpose'], string> = {
  otp: 'Sign-in code',
  password_reset: 'Password reset code',
  verification: 'Verification code',
  invitation: 'Invitation',
}

/**
 * Test builds only. Text messages are not sent yet, so a tester reads a parent's code here with
 * the access code they were given. The access code lives in this component and nowhere else: it
 * is never stored, so closing the tab forgets it.
 */
export function TestCodesScreen() {
  const [draft, setDraft] = useState('')
  const [accessCode, setAccessCode] = useState<string>()

  // Not a school query, so it keeps its own key rather than one in `qk`. The access code stays
  // out of the key: a key is visible in the query cache.
  const codes = useQuery({
    queryKey: ['heldCodes'],
    queryFn: ({ signal }) => heldCodes(accessCode ?? '', signal),
    enabled: accessCode !== undefined,
    refetchInterval: 5000,
    retry: false,
    gcTime: 0,
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    const value = draft.trim()
    if (value === '') return
    setAccessCode(value)
    if (accessCode === value) void codes.refetch()
  }

  return (
    <AuthLayout
      wide
      title="Test codes"
      description="Text messages are not sent in this test build. Codes sent to a phone number appear here for ten minutes."
      footer={<Link to="/login" className="underline underline-offset-2">Back to sign in</Link>}
    >
      <form onSubmit={submit} className="flex items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="access-code">Access code</Label>
          <Input id="access-code" type="password" autoComplete="off" value={draft} onChange={(event) => setDraft(event.target.value)} />
        </div>
        <Button type="submit">Show codes</Button>
      </form>

      {codes.isError && (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>That access code did not work. Ask the person who invited you to test.</AlertDescription>
        </Alert>
      )}

      {codes.data && (
        <div className="mt-4 overflow-hidden rounded-xl border">
          {codes.data.length === 0 && (
            <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">No codes yet. Ask for a code on the sign-in screen, then wait a few seconds.</p>
          )}
          {codes.data.map((message) => (
            <div key={`${message.to}-${message.createdAt}`} className="flex items-center justify-between gap-3 border-b px-3 py-2.5 last:border-b-0">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium">{message.to}</div>
                <div className="text-[12px] text-muted-foreground">{PURPOSE[message.purpose]} · {timeAgo(message.createdAt)}</div>
              </div>
              <code className="shrink-0 select-all break-all text-[14px] font-semibold tabular-nums">{message.secret}</code>
            </div>
          ))}
        </div>
      )}
    </AuthLayout>
  )
}
