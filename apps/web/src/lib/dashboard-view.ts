/**
 * Which of a person's dashboards this browser shows them.
 *
 * A membership can carry more than one role (a teacher who is also a parent, an accountant who is
 * also a parent). Their permissions are the union and every list shows the union; only the home
 * screen and the shape of the navigation pick one view. The choice is a browser preference, kept
 * per user id in localStorage: the session belongs to the identity, not to one school membership,
 * and a person can hold different roles in different schools, so it is not a session or database
 * field. The server still decides: it accepts a requested audience only when the caller's own roles
 * earn it, and a stored view those roles do not earn is dropped here before it is ever sent.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { audiencesFor, type DashboardAudience } from '@/lib/permissions'
import { useSession } from '@/lib/session'

export type DashboardView = Exclude<DashboardAudience, 'none'>

const VIEW_PREFIX = 'erp.dashboardView.'
/** Written by the login screen, read once by the first signed-in screen that asks for a view. */
const SEED_KEY = 'erp.dashboardView.seed'

/** What the login tab says about the person: they came in as a parent, or as a member of staff. */
export type LoginSeed = 'parent' | 'staff'

const VIEWS: readonly DashboardView[] = ['office', 'accountant', 'teacher', 'parent']

function isView(value: string | null): value is DashboardView {
  return value !== null && (VIEWS as readonly string[]).includes(value)
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // A browser with storage blocked simply lands on the default view each time.
  }
}

const listeners = new Set<() => void>()
function notify(): void {
  for (const listener of listeners) listener()
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  window.addEventListener('storage', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}

/** The login screen calls this with the tab the person signed in from. */
export function rememberLoginSeed(seed: LoginSeed): void {
  write(SEED_KEY, seed)
}

/** Move a pending login seed onto this user's own preference, then forget it. */
function applySeed(userId: string): void {
  const seed = read(SEED_KEY)
  if (seed === null) return
  write(SEED_KEY, null)
  // From the parent tab they land on the parent home; from a staff tab, on their highest staff
  // view, which is what the default order gives once any stored parent choice is gone.
  write(VIEW_PREFIX + userId, seed === 'parent' ? 'parent' : null)
}

/** The stored view for this user, or null when none is stored or storage is unavailable. */
export function readDashboardView(userId: string): DashboardView | null {
  applySeed(userId)
  const stored = read(VIEW_PREFIX + userId)
  return isView(stored) ? stored : null
}

/** Remember the view this user chose, in this browser. */
export function writeDashboardView(userId: string, view: DashboardView | null): void {
  write(VIEW_PREFIX + userId, view)
  notify()
}

/**
 * The view to draw for these roles: the stored one when the roles still earn it, else the first
 * one they earn, else 'none'. `preferred` is the stored view only when it will be sent to the
 * server; the default is never sent, so the server's own order decides.
 */
export function resolveDashboardView(
  roleKeys: readonly string[],
  stored: DashboardView | null,
): { view: DashboardAudience; preferred: DashboardView | null; options: DashboardView[] } {
  const options = audiencesFor(roleKeys)
  if (stored !== null && options.includes(stored)) return { view: stored, preferred: stored, options }
  return { view: options[0] ?? 'none', preferred: null, options }
}

/**
 * The chosen dashboard view for a signed-in person, and the way to change it. `options` lists the
 * views their roles earn; a switcher is only worth drawing when there is more than one.
 */
export function useDashboardView(userId: string | null, roleKeys: readonly string[]): {
  view: DashboardAudience
  preferred: DashboardView | null
  options: DashboardView[]
  setView: (view: DashboardView) => void
} {
  const stored = useSyncExternalStore(
    subscribe,
    () => (userId === null ? null : readDashboardView(userId)),
    () => null,
  )
  const setView = useCallback(
    (view: DashboardView) => {
      if (userId !== null) writeDashboardView(userId, view)
    },
    [userId],
  )
  return { ...resolveDashboardView(roleKeys, stored), setView }
}

/** The name a person reads for a view. */
export function viewLabel(view: DashboardView): string {
  switch (view) {
    case 'office':
      return 'Office'
    case 'accountant':
      return 'Accountant'
    case 'teacher':
      return 'Teacher'
    case 'parent':
      return 'Parent'
  }
}

/** The chosen view inside the app shell, from the session's own user and roles. */
export function useSchoolDashboardView() {
  const { user, roleKeys } = useSession()
  return useDashboardView(user?.id ?? null, roleKeys)
}
