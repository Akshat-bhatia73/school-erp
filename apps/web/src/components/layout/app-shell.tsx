import { Outlet } from '@tanstack/react-router'
import { useState } from 'react'
import { Sidebar } from './sidebar'

/** Grey canvas with the white app card inside, like the reference screenshots */
export function AppShell() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('erp.sidebar') === 'collapsed')
  const toggle = () => setCollapsed((c) => { localStorage.setItem('erp.sidebar', c ? 'open' : 'collapsed'); return !c })
  return (
    <div className="h-screen w-screen overflow-hidden bg-background p-3">
      <div className="flex h-full w-full overflow-hidden rounded-2xl border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.12)]">
        <Sidebar collapsed={collapsed} onToggle={toggle} />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
