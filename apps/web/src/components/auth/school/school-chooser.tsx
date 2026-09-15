/**
 * Picks the school this tab works in. The only source is the membership list the server already
 * sent with `/api/me` — the app never asks for a list of schools, and picking one here is a
 * preference, not permission: every request still names the school and the server decides again.
 */
import { useNavigate } from '@tanstack/react-router'
import { Check, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Tag, colorFor } from '@/components/shared/tag'
import { AccessUnavailable } from '@/components/auth/school/access-unavailable'
import { RedirectOnce } from '@/components/auth/app-gate'
import { ServerUnreachable } from '@/components/auth/school/server-unreachable'
import { useSession } from '@/lib/session'
import { sanitiseReturnTo } from '@/lib/return-to'
import type { MeResponse } from '@erp/contracts'

type Membership = MeResponse['memberships'][number]

function roleLabel(key: string) {
  return key.charAt(0).toUpperCase() + key.slice(1).replace(/[-_]/g, ' ')
}

export function SchoolChooser({ returnTo }: { returnTo?: string }) {
  const session = useSession()
  const navigate = useNavigate()

  if (session.status === 'loading') {
    return <div className="grid gap-2" aria-busy="true"><Skeleton className="h-14 rounded-lg" /><Skeleton className="h-14 rounded-lg" /></div>
  }
  if (session.status === 'anonymous') return <RedirectOnce to="/login" search={{ returnTo }} />
  if (session.status === 'blocked') return <AccessUnavailable reason="student" inline />
  if (session.status === 'unavailable') return <ServerUnreachable onRetry={() => { void session.refresh() }} />

  // Students never get a row: student sign-in is off, and `/api/me` only ever reports active
  // adult memberships, so a suspended or removed one simply is not in the list.
  const active = session.memberships.filter((m) => m.kind === 'adult' && m.status === 'active')

  if (active.length === 0) return <AccessUnavailable reason="no_membership" inline />

  function open(membership: Membership) {
    session.selectSchool(membership.school.id)
    void navigate({ to: sanitiseReturnTo(returnTo), replace: true } as never)
  }

  return (
    <div className="grid gap-4">
      <ul className="grid gap-2">
        {active.map((membership) => {
          const current = session.membership?.school.id === membership.school.id
          return (
            <li key={membership.id}>
              <button
                type="button"
                onClick={() => open(membership)}
                className="flex min-h-14 w-full items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-medium">{membership.school.name}</span>
                    {current && <Tag color="green"><Check className="size-3" />Current</Tag>}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="text-[12.5px] text-muted-foreground">{membership.school.code}</span>
                    {membership.roleKeys.map((key) => <Tag key={key} color={colorFor(key)}>{roleLabel(key)}</Tag>)}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          )
        })}
      </ul>
      <Separator />
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-[12.5px] text-muted-foreground">
          Signed in as <span className="text-foreground">{session.user?.displayName}</span>
        </p>
        <Button variant="outline" className="h-11 md:h-9" onClick={() => { void session.signOut() }}>Sign out</Button>
      </div>
    </div>
  )
}
