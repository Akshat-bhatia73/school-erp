import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

/**
 * A link to an app path the server built, such as `/attendance?sectionId=…&date=…`. The router
 * takes the path and the search separately, so the query string is split off here. Every href
 * has already passed the AppPath contract: a path inside this app, never another site.
 */
export function AppLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const url = new URL(href, 'http://app.invalid')
  const search = Object.fromEntries(url.searchParams)
  return (
    <Link to={url.pathname} search={search as never} hash={url.hash ? url.hash.slice(1) : undefined} className={className}>
      {children}
    </Link>
  )
}
