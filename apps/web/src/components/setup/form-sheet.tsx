import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'

/** Side panel used for every quick add/edit form in School setup. */
export function FormSheet({ open, onOpenChange, title, description, submitLabel = 'Save', onSubmit, busy, formError, children }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  description?: string
  submitLabel?: string
  onSubmit: () => void
  busy?: boolean
  /** A problem that belongs to the whole form rather than to one field. */
  formError?: string
  children: ReactNode
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <form
          className="min-h-0 flex-1 overflow-auto scrollbar-thin px-4"
          onSubmit={(e) => { e.preventDefault(); onSubmit() }}
          id="setup-form-sheet"
        >
          <div className="grid gap-3.5 pb-4">
            {formError ? <p role="alert" className="text-[12.5px] text-tag-red">{formError}</p> : null}
            {children}
          </div>
        </form>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form="setup-form-sheet" size="sm" disabled={busy}>{submitLabel}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
