/** "Export" with the two file kinds the fee exports produce. */
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

/** The two file kinds every fee export offers. */
export type FeeFileFormat = 'xlsx' | 'pdf'

export function FeeExportMenu({ onPick, isPending }: { onPick: (format: FeeFileFormat) => void; isPending?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline"><Download />{isPending ? 'Preparing…' : 'Export'}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onPick('xlsx')}>Excel</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onPick('pdf')}>PDF</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
