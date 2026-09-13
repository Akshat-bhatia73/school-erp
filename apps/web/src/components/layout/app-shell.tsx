import { Outlet, useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { CommandMenu } from './command-menu'
import { MobileTabBar, MobileTopBar } from './mobile-nav'
import { Sidebar } from './sidebar'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useHotkey } from '@/lib/hotkeys'

/**
 * Desktop: grey canvas with the white app card inside, like the reference screenshots.
 * Mobile (<md): the card framing is dropped so content gets the full viewport width,
 * the sidebar moves into a drawer, and a bottom tab bar carries the primary modules.
 */
export function AppShell() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('erp.sidebar') === 'collapsed')
  const toggle = () => setCollapsed((c) => { localStorage.setItem('erp.sidebar', c ? 'open' : 'collapsed'); return !c })
  const [cmdOpen, setCmdOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  useHotkey('mod+k', useCallback((e: KeyboardEvent) => { e.preventDefault(); setCmdOpen((o) => !o) }, []))

  // A drawer left open across a navigation would cover the page it just opened.
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  useEffect(() => { setNavOpen(false) }, [pathname])

  return (
    <div className="h-[100dvh] w-screen overflow-hidden bg-background md:p-3">
      <div className="flex h-full w-full overflow-hidden border-0 bg-card md:rounded-2xl md:border md:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.12)]">
        <div className="hidden h-full md:flex">
          <Sidebar collapsed={collapsed} onToggle={toggle} onOpenQuickActions={() => setCmdOpen(true)} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <MobileTopBar onOpenNav={() => setNavOpen(true)} onOpenQuickActions={() => setCmdOpen(true)} />
          {/* Bottom padding clears the floating tab island */}
          <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pb-[4.5rem] md:pb-0">
            <Outlet />
          </main>
          <MobileTabBar />
        </div>
      </div>

      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        {/* The drawer has its own close control in the header row, so the default one would overlap it */}
        <SheetContent side="left" showCloseButton={false} className="w-[86vw] max-w-80 gap-0 p-0 md:hidden">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Sidebar variant="drawer" onOpenQuickActions={() => setCmdOpen(true)} onNavigate={() => setNavOpen(false)} />
        </SheetContent>
      </Sheet>

      <CommandMenu open={cmdOpen} onOpenChange={setCmdOpen} />
    </div>
  )
}
