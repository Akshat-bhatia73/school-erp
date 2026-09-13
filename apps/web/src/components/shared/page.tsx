import { Link } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface Crumb { label: string; to?: string; icon?: ReactNode }

/**
 * Top bar of a page: breadcrumb on the left, actions on the right. Matches "Companies / Database".
 * On mobile the breadcrumb collapses to a back chevron plus the current page, and `mobileActions`
 * (when given) replaces a wide action cluster that would not fit at 390px.
 */
export function PageHeader({ crumbs, actions, mobileActions, badge, hideOnMobile, className }: {
  crumbs: Crumb[]
  actions?: ReactNode
  mobileActions?: ReactNode
  badge?: ReactNode
  /** For tabbed screens: the tab row already names the page, so the title bar is a wasted row. */
  hideOnMobile?: boolean
  className?: string
}) {
  const last = crumbs[crumbs.length - 1]
  const back = [...crumbs.slice(0, -1)].reverse().find((c) => c.to)
  return (
    <div className={cn('h-12 shrink-0 items-center justify-between gap-2 border-b bg-card px-2 md:h-14 md:gap-4 md:px-5', hideOnMobile ? 'hidden md:flex' : 'flex', className)}>
      {/* Mobile: back chevron + current page */}
      <nav className="flex min-w-0 items-center gap-1 text-[15px] md:hidden">
        {back && (
          <Link to={back.to} aria-label={`Back to ${back.label}`} className="-ml-1 flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <ChevronLeft className="size-5" />
          </Link>
        )}
        <span className={cn('flex min-w-0 items-center gap-1.5 truncate font-semibold', !back && 'pl-1.5')}>
          {!back && last?.icon && <span className="[&>svg]:size-4 [&>svg]:text-muted-foreground">{last.icon}</span>}
          <span className="truncate">{last?.label}</span>
        </span>
        {badge}
      </nav>

      {/* Desktop: full breadcrumb */}
      <nav className="hidden min-w-0 items-center gap-1.5 text-[15px] md:flex">
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1
          const content = (
            <span className={cn('flex items-center gap-1.5 truncate', isLast ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {c.icon && <span className="[&>svg]:size-4 [&>svg]:text-muted-foreground">{c.icon}</span>}
              {c.label}
            </span>
          )
          return (
            <span key={i} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />}
              {c.to && !isLast ? <Link to={c.to}>{content}</Link> : content}
            </span>
          )
        })}
        {badge}
      </nav>

      {actions && <div className="hidden shrink-0 items-center gap-2 md:flex">{actions}</div>}
      {(mobileActions ?? actions) && <div className="flex shrink-0 items-center gap-1 md:hidden">{mobileActions ?? actions}</div>}
    </div>
  )
}

/**
 * Toolbar under the header: filter chips on the left, secondary actions on the right.
 * On mobile `search` gets its own full-width row and the chips scroll horizontally
 * instead of wrapping into a tall stack.
 */
export function Toolbar({ children, right, search, className }: { children?: ReactNode; right?: ReactNode; search?: ReactNode; className?: string }) {
  return (
    <div className={cn('shrink-0 border-b bg-card', className)}>
      {search && <div className="border-b px-3 py-2 md:hidden">{search}</div>}
      <div className="flex min-h-[52px] items-center justify-between gap-2 px-3 py-2 md:flex-wrap md:px-4">
        <div className="flex min-w-0 flex-nowrap items-center gap-2 overflow-x-auto no-scrollbar md:flex-wrap md:overflow-visible">
          {search && <div className="hidden md:block">{search}</div>}
          {children}
          {/* On mobile the secondary actions join the scrolling strip instead of
              squeezing the filter chips into a sliver of the row. */}
          {right && <div className="flex items-center gap-2 md:hidden">{right}</div>}
        </div>
        {right && <div className="hidden shrink-0 items-center gap-2 md:flex">{right}</div>}
      </div>
    </div>
  )
}

/**
 * Tabs row like "Companies | Deals | Forecast" under a page title.
 * On mobile it also carries the page actions, so a tabbed screen spends one row
 * of chrome on this instead of two.
 */
export function PageTabs({ tabs, actions, className }: { tabs: Array<{ label: string; to: string; count?: number }>; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex shrink-0 items-center gap-2 border-b bg-card pr-2 md:pr-3', className)}>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-3 no-scrollbar">
        {tabs.map((t) => {
          // A tab whose path is a prefix of a sibling tab (e.g. /timetable vs /timetable/teachers) must match exactly
          const exact = tabs.some((o) => o !== t && o.to.startsWith(t.to.endsWith('/') ? t.to : t.to + '/'))
          return (
          <Link
            key={t.to}
            to={t.to}
            className="relative flex h-10 shrink-0 items-center gap-2 px-2.5 text-[13.5px] text-muted-foreground hover:text-foreground md:h-11 [&.active]:font-medium [&.active]:text-foreground [&.active]:after:absolute [&.active]:after:inset-x-2 [&.active]:after:bottom-0 [&.active]:after:h-0.5 [&.active]:after:rounded-full [&.active]:after:bg-foreground"
            activeOptions={{ exact }}
          >
            {t.label}
            {t.count !== undefined && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">{t.count}</span>}
          </Link>
          )
        })}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5 md:hidden">{actions}</div>}
    </div>
  )
}

/** White panel with hairline border, used for cards on the dashboard and detail pages */
export function Panel({ title, description, actions, children, className, bodyClassName }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn('rounded-xl border bg-card', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 px-3 pt-3.5 pb-2 md:px-4">
          <div>
            {title && <h3 className="text-[13.5px] font-semibold">{title}</h3>}
            {description && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={cn('px-3 pb-4 md:px-4', !title && 'pt-4', bodyClassName)}>{children}</div>
    </section>
  )
}

/** Label / value pairs for detail pages */
export function Facts({ items, columns = 2, className }: { items: Array<{ label: string; value: ReactNode }>; columns?: 1 | 2 | 3 | 4; className?: string }) {
  // One column on mobile whatever the caller asks for: two 190px columns clip at 390px.
  const cols = { 1: 'grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-2 lg:grid-cols-3', 4: 'grid-cols-2 lg:grid-cols-4' }[columns]
  return (
    <dl className={cn('grid grid-cols-1 gap-x-6 gap-y-3', cols, className)}>
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
