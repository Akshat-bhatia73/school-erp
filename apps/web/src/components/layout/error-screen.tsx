import { Link, type ErrorComponentProps } from '@tanstack/react-router'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** Shown by the router when a screen throws. Gives the user a way out and shows the message for bug reports. */
export function ErrorScreen({ error, reset }: ErrorComponentProps) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex size-10 items-center justify-center rounded-xl border bg-muted/50 text-tag-orange"><AlertTriangle className="size-5" /></div>
      <p className="text-[15px] font-semibold">This screen hit a problem</p>
      <p className="max-w-md text-[13px] text-muted-foreground">Nothing was saved. Reloading usually fixes it. If it keeps happening, send us the message below.</p>
      <pre className="max-w-lg overflow-auto rounded-lg border bg-muted/40 px-3 py-2 text-left font-mono text-[12px] text-muted-foreground">{message}</pre>
      <div className="mt-2 flex gap-2">
        <Button variant="outline" onClick={() => { reset(); window.location.reload() }}><RotateCcw />Reload</Button>
        <Button asChild><Link to="/dashboard">Go to dashboard</Link></Button>
      </div>
    </div>
  )
}
