/**
 * The session could not be derived because the server did not answer. This is not a refusal:
 * nothing is known about this person yet, so the only honest thing to offer is another try.
 */
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function ServerUnreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center" role="status">
      <div className="flex size-10 items-center justify-center rounded-xl border bg-muted/50 text-tag-orange"><AlertTriangle className="size-5" /></div>
      <p className="text-[15px] font-semibold">We cannot reach the server</p>
      <p className="max-w-sm text-[13px] text-muted-foreground">Your work is safe. Check your connection and try again.</p>
      <Button className="mt-1 h-11 w-full md:h-9" onClick={onRetry}>Try again</Button>
    </div>
  )
}
