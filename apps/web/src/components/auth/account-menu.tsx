import { useNavigate } from '@tanstack/react-router'
import { Building2, ChevronsUpDown, LogOut, Moon, ShieldCheck, Sun } from 'lucide-react'
import { UserAvatar } from '@/components/shared/avatar'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useSession } from '@/lib/session'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'

/** The signed-in person, their school, and the few things they can do about either. */
export function AccountMenu({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const { user, school, activeMemberships, signOut } = useSession()
  const { theme, toggle } = useTheme()
  const navigate = useNavigate()
  const name = user?.displayName ?? 'Signed in'
  const canSwitch = activeMemberships.length > 1

  const go = (to: string) => {
    onNavigate?.()
    void navigate({ to })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account menu for ${name}`}
          className={cn('flex w-full items-center gap-2 rounded-lg p-1.5 text-left hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', collapsed && 'w-auto justify-center')}
        >
          <UserAvatar name={name} size="md" />
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium leading-tight">{name}</span>
                <span className="block truncate text-[11.5px] leading-tight text-muted-foreground">{school?.name ?? 'No school selected'}</span>
              </span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-64">
        {canSwitch && (
          <DropdownMenuItem onClick={() => go('/select-school')} className="gap-2 min-h-11 md:min-h-8"><Building2 className="size-4" />Switch school</DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => go('/account/security')} className="gap-2 min-h-11 md:min-h-8"><ShieldCheck className="size-4" />Account security</DropdownMenuItem>
        <DropdownMenuItem onClick={toggle} className="gap-2 min-h-11 md:min-h-8">
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => { onNavigate?.(); void signOut().then(() => navigate({ to: '/login' })) }}
          className="gap-2 min-h-11 md:min-h-8"
        >
          <LogOut className="size-4" />Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
