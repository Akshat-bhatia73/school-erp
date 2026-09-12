import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface Crumb { label: string; to?: string; icon?: ReactNode }

/** Top bar of a page: breadcrumb on the left, actions on the right. Matches "Companies / Database". */
export function PageHeader({ crumbs, actions, badge, className }: { crumbs: Crumb[]; actions?: ReactNode; badge?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex h-14 shrink-0 items-center justify-between gap-4 border-b bg-card px-5', className)}>
      <nav className="flex min-w-0 items-center gap-1.5 text-[15px]">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1
          const content = (
            <span className={cn('flex items-center gap-1.5 truncate', last ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {c.icon && <span className="[&>svg]:size-4 [&>svg]:text-muted-foreground">{c.icon}</span>}
              {c.label}
            </span>
          )
          return (
            <span key={i} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />}
              {c.to && !last ? <Link to={c.to}>{content}</Link> : content}
            </span>
          )
        })}
        {badge}
      </nav>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Toolbar under the header: filter chips on the left, secondary actions on the right */
export function Toolbar({ children, right, className }: { children?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-h-[52px] shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-card px-4 py-2', className)}>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  )
}

/** Tabs row like "Companies | Deals | Forecast" under a page title */
export function PageTabs({ tabs, className }: { tabs: Array<{ label: string; to: string; count?: number }>; className?: string }) {
  return (
    <div className={cn('flex shrink-0 items-center gap-1 border-b bg-card px-3', className)}>
      {tabs.map((t) => {
        // A tab whose path is a prefix of a sibling tab (e.g. /timetable vs /timetable/teachers) must match exactly
        const exact = tabs.some((o) => o !== t && o.to.startsWith(t.to.endsWith('/') ? t.to : t.to + '/'))
        return (
        <Link
          key={t.to}
          to={t.to}
          className="relative flex h-11 items-center gap-2 px-2.5 text-[13.5px] text-muted-foreground hover:text-foreground [&.active]:font-medium [&.active]:text-foreground [&.active]:after:absolute [&.active]:after:inset-x-2 [&.active]:after:bottom-0 [&.active]:after:h-0.5 [&.active]:after:rounded-full [&.active]:after:bg-foreground"
          activeOptions={{ exact }}
        >
          {t.label}
          {t.count !== undefined && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">{t.count}</span>}
        </Link>
        )
      })}
    </div>
  )
}

/** White panel with hairline border, used for cards on the dashboard and detail pages */
export function Panel({ title, description, actions, children, className, bodyClassName }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn('rounded-xl border bg-card', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
          <div>
            {title && <h3 className="text-[13.5px] font-semibold">{title}</h3>}
            {description && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={cn('px-4 pb-4', !title && 'pt-4', bodyClassName)}>{children}</div>
    </section>
  )
}

/** Label / value pairs for detail pages */
export function Facts({ items, columns = 2, className }: { items: Array<{ label: string; value: ReactNode }>; columns?: 1 | 2 | 3 | 4; className?: string }) {
  const cols = { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4' }[columns]
  return (
    <dl className={cn('grid gap-x-6 gap-y-3', cols, className)}>
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <dt className="text-[12px] text-muted-foreground">{it.label}</dt>
          <dd className="mt-0.5 truncate text-[13.5px]">{it.value ?? <span className="text-muted-foreground/60">—</span>}</dd>
        </div>
      ))}
    </dl>
  )
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-16 text-center', className)}>
      {icon && <div className="mb-1 flex size-10 items-center justify-center rounded-xl border bg-muted/50 text-muted-foreground [&>svg]:size-5">{icon}</div>}
      <p className="text-[14px] font-medium">{title}</p>
      {description && <p className="max-w-sm text-[13px] text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

/** Uppercase small section label like "General", "Favorites", "TEAM" */
export function SectionLabel({ children, className, action }: { children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <div className={cn('flex items-center justify-between px-2 pt-4 pb-1.5', className)}>
      <span className="text-[12px] font-medium tracking-wide text-muted-foreground">{children}</span>
      {action}
    </div>
  )
}
