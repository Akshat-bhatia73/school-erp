/** The four money numbers a dashboard shows, from the fees block the server chose to send. */
import { IndianRupee, Receipt, Users, Wallet } from 'lucide-react'
import type { DashboardFees } from '@erp/contracts'
import { StatRow, StatTile } from '@/components/dashboard/blocks/stat'
import { plural } from '@/components/dashboard/format'
import { formatPaise } from '@/lib/utils'

export function FeeStatTiles({ fees, size = 'md' }: { fees: DashboardFees; size?: 'md' | 'sm' }) {
  return (
    <StatRow cols={4}>
      <StatTile
        size={size}
        label="Collected today"
        value={formatPaise(fees.collectedTodayPaise)}
        hint={plural(fees.receiptsToday, 'receipt', 'receipts')}
        tone="green"
        icon={<Receipt />}
        to="/fees/collections"
      />
      <StatTile
        size={size}
        label="Collected this month"
        value={formatPaise(fees.collectedThisMonthPaise)}
        tone="blue"
        icon={<Wallet />}
        to="/fees/collections"
      />
      <StatTile
        size={size}
        label="Outstanding dues"
        value={formatPaise(fees.outstandingPaise)}
        tone="orange"
        icon={<IndianRupee />}
        to="/fees"
      />
      <StatTile
        size={size}
        label="Pupils with dues"
        value={fees.studentsWithDues}
        tone="purple"
        icon={<Users />}
        to="/fees"
      />
    </StatRow>
  )
}
