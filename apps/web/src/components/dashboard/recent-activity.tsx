import { Link } from '@tanstack/react-router'
import { UserAvatar } from '@/components/shared/avatar'
import { EmptyState, Panel } from '@/components/shared/page'
import { Skeleton } from '@/components/ui/skeleton'
import { timeAgo } from '@/lib/utils'
import { ScrollText } from 'lucide-react'
import type { DashboardSummary } from '@erp/shared'

type Activity = DashboardSummary['recentActivity']

export function RecentActivity({ items, isLoading }: { items?: Activity; isLoading?: boolean }) {
  const list = items ?? []
  return (
    <Panel
      title="Recent activity"
      description="What changed in this school lately"
      actions={<Link to="/settings/audit-log" className="text-[12.5px] text-muted-foreground hover:text-foreground link-dotted">View audit log</Link>}
      className="overflow-hidden"
      bodyClassName="px-0 pb-0"
    >
      {isLoading ? (
        <div className="flex flex-col gap-3 px-4 pb-4">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
        </div>
      ) : list.length === 0 ? (
        <EmptyState icon={<ScrollText />} title="Nothing yet" description="Changes people make will show up here." className="py-10" />
      ) : (
        <ul className="divide-y border-t">
          {list.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-4 py-2.5">
              <UserAvatar name={a.actorName} size="sm" />
              <span className="min-w-0 flex-1 truncate text-[13.5px]">
                <span className="font-medium">{a.actorName}</span>{' '}
                <span className="text-muted-foreground">{a.summary}</span>
              </span>
              <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{timeAgo(a.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
