import { Link } from '@tanstack/react-router'
import { Panel } from '@/components/shared/page'
import { useSchoolContext } from '@/lib/session'

/** Nothing financial is built yet, so this is the message plus the screens they can still open. */
export function AccountantDashboard({ message }: { message: string }) {
  const { hasPermission } = useSchoolContext()
  const links = [
    hasPermission('staff.read_directory') ? { to: '/staff', label: 'Staff directory' } : null,
    hasPermission('audit.read') ? { to: '/settings/audit-log', label: 'Audit log' } : null,
  ].filter((link): link is { to: string; label: string } => link !== null)

  return (
    <Panel title="Fees and payroll" description={message}>
      {links.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">There is nothing for you to open here yet.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {links.map((link) => (
            <li key={link.to}>
              <Link to={link.to} className="-mx-2 flex h-9 items-center rounded-lg px-2 text-[13.5px] hover:bg-accent">{link.label}</Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
