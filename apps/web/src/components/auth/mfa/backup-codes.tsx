import { Copy, Download } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

/** Put text on the clipboard without assuming the browser has the modern API. */
export async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied.`)
  } catch {
    toast.error('We could not copy that. Select the text and copy it yourself.')
  }
}

/** Offer the codes as a plain text file, so they can be printed or kept in a password manager. */
export function downloadCodes(codes: string[]) {
  const blob = new Blob([`School ERP backup codes\n\n${codes.join('\n')}\n`], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'school-erp-backup-codes.txt'
  link.click()
  URL.revokeObjectURL(url)
}

/** Shown once and never again: each code signs you in a single time. */
export function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <div className="grid gap-3">
      <ul className="grid grid-cols-1 gap-1.5 rounded-lg border bg-muted/40 p-3 font-mono text-[13px] md:grid-cols-2">
        {codes.map((code) => <li key={code}>{code}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="h-11 md:h-9" onClick={() => { void copyText(codes.join('\n'), 'Backup codes') }}>
          <Copy /> Copy all
        </Button>
        <Button type="button" variant="outline" className="h-11 md:h-9" onClick={() => downloadCodes(codes)}>
          <Download /> Download as a file
        </Button>
      </div>
      <p className="text-[12.5px] text-muted-foreground">Each code works once. Keep them somewhere safe and away from this device.</p>
    </div>
  )
}
