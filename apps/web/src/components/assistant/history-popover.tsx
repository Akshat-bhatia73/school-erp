import type { AssistantThreadSummary } from '@erp/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { useSchoolContext } from '@/lib/session'
import { cn } from '@/lib/utils'
import { groupThreads } from './format'

/**
 * The button at the top left: "New chat" on a new conversation, the conversation's title
 * otherwise. It opens the person's past conversations grouped by day; there is no second sidebar.
 */
export function HistoryPopover({ title, threads, loading, failed, onRetry, currentId, onOpen }: {
  title: string
  threads: readonly AssistantThreadSummary[]
  loading?: boolean
  /** The list could not be loaded, which is not the same as there being none. */
  failed?: boolean
  onRetry?: () => void
  currentId?: string
  /** Open a conversation; no id starts a new one. */
  onOpen: (threadId?: string) => void
}) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [toDelete, setToDelete] = useState<AssistantThreadSummary | null>(null)
  const groups = useMemo(() => groupThreads(threads), [threads])

  const remove = useMutation({
    mutationFn: (threadId: string) => api.assistant.deleteThread(schoolId, threadId),
    onSuccess: (_, threadId) => {
      toast.success('Conversation deleted')
      setToDelete(null)
      if (threadId === currentId) onOpen(undefined)
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'assistant'] })
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const choose = (threadId?: string) => {
    setOpen(false)
    onOpen(threadId)
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-8 max-w-[min(360px,70vw)] items-center gap-1.5 rounded-lg px-2.5 text-[14px] font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[state=open]:bg-accent"
          >
            <span className="truncate">{title}</span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={6} className="w-[min(360px,calc(100vw-1.5rem))] rounded-xl p-0">
          <p className="border-b px-3.5 py-2.5 text-[13px] text-muted-foreground">Chat history</p>
          <div className="max-h-[min(460px,60vh)] overflow-y-auto py-1 scrollbar-thin">
            <button
              type="button"
              onClick={() => choose(undefined)}
              className="mx-1 flex h-8 w-[calc(100%-0.5rem)] items-center gap-2 rounded-md px-2.5 text-left text-[13.5px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            >
              <Plus className="size-4 text-muted-foreground" />
              New chat
            </button>

            {failed && (
              <div className="flex items-center justify-between gap-3 px-3.5 py-3 text-[13px] text-muted-foreground" role="alert">
                <span>Could not load your conversations.</span>
                {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>}
              </div>
            )}
            {loading && !failed && (
              <div className="flex flex-col gap-2 px-3.5 py-3">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3.5 w-1/2" />
              </div>
            )}
            {!loading && !failed && threads.length === 0 && (
              <p className="px-3.5 py-3 text-[13px] text-muted-foreground">Your conversations of the last 30 days show here.</p>
            )}

            {groups.map((group) => (
              <div key={group.label} className="mt-1 border-t pt-1">
                <p className="px-3.5 pt-2 pb-1 text-[12px] text-muted-foreground">{group.label}</p>
                {group.items.map(({ thread, age }) => (
                  <div key={thread.id} className={cn('group relative mx-1 rounded-md hover:bg-accent', thread.id === currentId && 'bg-accent')}>
                    <button
                      type="button"
                      onClick={() => choose(thread.id)}
                      aria-current={thread.id === currentId ? 'true' : undefined}
                      className="flex h-8 w-full items-center gap-3 rounded-md pr-9 pl-2.5 text-left text-[13.5px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:pr-2.5"
                    >
                      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                      <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground md:group-focus-within:invisible md:group-hover:invisible">{age}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${thread.title}`}
                      title="Delete"
                      onClick={() => { setOpen(false); setToDelete(thread) }}
                      className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <AlertDialog open={toDelete !== null} onOpenChange={(value) => !value && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              “{toDelete?.title}” and everything in it is removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => toDelete && remove.mutate(toDelete.id)}>
              {remove.isPending ? 'Deleting…' : 'Delete conversation'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
