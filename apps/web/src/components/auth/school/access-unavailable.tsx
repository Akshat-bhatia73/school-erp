/**
 * One screen for every "you cannot open this" answer the server gives. The copy says what
 * happened and who can fix it; it never shows a code and never hints at what is behind the door.
 */
import { Link } from '@tanstack/react-router'
import { Ban, Building2, KeyRound, Lock, SearchX, ShieldAlert, UserX } from 'lucide-react'
import type { ComponentType } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AuthLayout } from '@/components/auth/auth-layout'
import { useSession } from '@/lib/session'
import type { AccessReason } from '@/components/auth/school/access-error'

interface Copy {
  title: string
  body: string
  icon: ComponentType<{ className?: string }>
  dashboard?: boolean
  otherSchool?: boolean
  security?: boolean
}

const COPY: Record<AccessReason, Copy> = {
  no_membership: {
    title: 'No school yet',
    body: 'Your login is not linked to any school right now. You may not have been invited yet, or your access may have been suspended or removed. Ask your school office to check, then open the link they send.',
    icon: Building2,
    security: true,
  },
  suspended: {
    title: 'Access suspended',
    body: 'Your access to this school is suspended. Contact the school office.',
    icon: Ban,
    otherSchool: true,
  },
  school: {
    title: 'School unavailable',
    body: 'This school is not available right now. If this keeps happening, ask the school office to check your access.',
    icon: Building2,
    otherSchool: true,
  },
  student: {
    title: 'Student sign-in is off',
    body: 'Student access is not enabled yet. Your school will tell you when students can sign in.',
    icon: Lock,
  },
  disabled: {
    title: 'Account disabled',
    body: 'This account is disabled. Contact the school office to have it turned back on.',
    icon: UserX,
  },
  forbidden: {
    title: 'Not allowed here',
    body: 'You do not have access to that page. If you need it, ask someone who manages people at your school.',
    icon: ShieldAlert,
    dashboard: true,
    otherSchool: true,
  },
  not_found: {
    title: 'Not found',
    body: 'We could not find that record. It may have been removed, or the link may be out of date.',
    icon: SearchX,
    dashboard: true,
  },
}

export function AccessUnavailable({ reason = 'forbidden', inline = false }: { reason?: AccessReason; inline?: boolean }) {
  const session = useSession()
  const copy = COPY[reason]
  const Icon = copy.icon
  const canChooseSchool = copy.otherSchool && session.activeMemberships.length > 0
  const signedIn = session.status === 'authenticated'
  const loading = session.status === 'loading'

  const chip = <div className="flex size-10 items-center justify-center rounded-xl border bg-muted/50 text-tag-orange"><Icon className="size-5" /></div>

  const actions = loading ? (
    <div className="mt-1 flex w-full flex-col gap-2" aria-busy="true">
      <Skeleton className="h-11 w-full rounded-lg md:h-9" />
      <Skeleton className="h-11 w-full rounded-lg md:h-9" />
    </div>
  ) : (
    <div className="mt-1 flex w-full flex-col gap-2">
      {canChooseSchool && (
        <Button asChild className="h-11 w-full md:h-9"><Link to="/select-school">Choose another school</Link></Button>
      )}
      {copy.dashboard && (
        <Button asChild variant={canChooseSchool ? 'outline' : 'default'} className="h-11 w-full md:h-9"><Link to="/dashboard">Back to dashboard</Link></Button>
      )}
      {signedIn && copy.security && (
        <Button asChild variant="outline" className="h-11 w-full md:h-9"><Link to="/account/security"><KeyRound />Account security</Link></Button>
      )}
      {signedIn && (
        <Button variant="ghost" className="h-11 w-full md:h-9" onClick={() => { void session.signOut() }}>Sign out</Button>
      )}
      {!signedIn && (
        <Button asChild variant="outline" className="h-11 w-full md:h-9"><Link to="/login">Go to sign in</Link></Button>
      )}
    </div>
  )

  if (inline) {
    return (
      <div className="flex flex-col items-center gap-3 text-center" role="status">
        {chip}
        <p className="text-[15px] font-semibold">{copy.title}</p>
        <p className="max-w-sm text-[13px] text-muted-foreground">{copy.body}</p>
        {actions}
      </div>
    )
  }

  return (
    <AuthLayout title={copy.title} description={copy.body}>
      <div className="flex flex-col items-center gap-3">
        {chip}
        {actions}
      </div>
    </AuthLayout>
  )
}
