/** The school's notice templates. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { MESSAGE_BODY_MAX, MESSAGE_TITLE_MAX, PLACEHOLDERS_BY_KIND, unknownPlaceholders } from '@erp/contracts'
import { FileText, Mail, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { PlaceholderList } from '@/components/messages/placeholder-list'
import { DataTable } from '@/components/shared/data-table'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import type { TemplateRecord } from '@/lib/api/messages'
import { describeError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

export const Route = createFileRoute('/_app/messages/templates/')({ component: Page })

function Page() {
  const { schoolId, hasPermission } = useSchoolContext()
  const [showArchived, setShowArchived] = useState(false)
  // null: closed; 'new': a new template; otherwise the one being edited.
  const [open, setOpen] = useState<TemplateRecord | 'new' | null>(null)
  const params = { kind: 'notice' as const, show: showArchived ? ('all' as const) : ('live' as const) }
  const templatesQuery = useQuery({ queryKey: qk.messages.templates(schoolId, params), queryFn: () => api.messages.templates(schoolId, params) })
  const items = templatesQuery.data?.items ?? []
  const canManage = hasPermission('communication.manage')

  const columns = useMemo<ColumnDef<TemplateRecord>[]>(() => [
    {
      id: 'name',
      header: 'Name',
      size: 240,
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium">{row.original.name}</span>
          {row.original.archived && <Tag>Archived</Tag>}
        </span>
      ),
    },
    { id: 'title', header: 'Title', size: 360, cell: ({ row }) => <span className="truncate text-muted-foreground">{row.original.title}</span> },
  ], [])

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Messages', to: '/messages', icon: <Mail /> }, { label: 'Templates' }]}
        actions={canManage ? <Button size="sm" onClick={() => setOpen('new')}><Plus />New template</Button> : undefined}
        mobileActions={canManage ? <Button size="sm" onClick={() => setOpen('new')}><Plus />New</Button> : undefined}
      />
      <Toolbar>
        <FilterChip
          label="Show"
          value={showArchived ? 'archived' : undefined}
          allLabel="In use"
          options={[{ value: 'archived', label: 'Show archived' }]}
          onChange={(value) => setShowArchived(value === 'archived')}
        />
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-hidden">
        {templatesQuery.isError ? (
          <EmptyState icon={<FileText />} title="Templates are not available" description={describeError(templatesQuery.error)} />
        ) : (
          <DataTable
            columns={columns}
            data={items}
            isLoading={templatesQuery.isLoading}
            getRowId={(row) => row.id}
            onRowClick={(row) => setOpen(row)}
            mobileRow={(row) => ({ title: row.name, subtitle: row.title })}
            emptyState={<EmptyState icon={<FileText />} title="No templates yet" description="A template saves the words of a notice the school sends often." />}
            footer={`${items.length} ${items.length === 1 ? 'template' : 'templates'}`}
          />
        )}
      </div>
      <TemplateSheet key={open === null ? 'closed' : open === 'new' ? 'new' : open.id} template={open} onClose={() => setOpen(null)} />
    </>
  )
}

function TemplateSheet({ template, onClose }: { template: TemplateRecord | 'new' | null; onClose: () => void }) {
  const { schoolId, hasPermission } = useSchoolContext()
  const queryClient = useQueryClient()
  const existing = template && template !== 'new' ? template : undefined
  const [name, setName] = useState(existing?.name ?? '')
  const [title, setTitle] = useState(existing?.title ?? '')
  const [body, setBody] = useState(existing?.body ?? '')
  const [errors, setErrors] = useState<{ name?: string; title?: string; body?: string }>({})

  // A record's own actions win; a new template needs manage on the school.
  const canEdit = existing ? !existing.archived && allows(existing.allowedActions, 'communication.manage') : hasPermission('communication.manage')
  const invalidate = () => queryClient.invalidateQueries({ queryKey: [schoolId, 'messages'] })
  const onError = (failure: unknown) => toast.error(describeError(failure))

  const save = useMutation({
    mutationFn: () => existing
      ? api.messages.updateTemplate(schoolId, existing.id, { expectedVersion: existing.version, name: name.trim(), title: title.trim(), body: body.trim() })
      : api.messages.createTemplate(schoolId, { kind: 'notice', name: name.trim(), title: title.trim(), body: body.trim() }),
    onSuccess: () => { void invalidate(); toast.success('Template saved'); onClose() },
    onError,
  })
  const archive = useMutation({
    mutationFn: () => api.messages.archiveTemplate(schoolId, existing!.id, { expectedVersion: existing!.version }),
    onSuccess: () => { void invalidate(); toast.success('Template archived'); onClose() },
    onError,
  })

  function onSave() {
    const next: typeof errors = {}
    if (!name.trim()) next.name = 'Give the template a name.'
    if (!title.trim()) next.title = 'Give it a title.'
    if (!body.trim()) next.body = 'Write the words.'
    const unknown = [...unknownPlaceholders(title, 'notice'), ...unknownPlaceholders(body, 'notice')]
    if (unknown.length > 0) next.body = `A notice cannot use ${[...new Set(unknown)].map((p) => `{${p}}`).join(', ')}.`
    setErrors(next)
    if (Object.keys(next).length === 0) save.mutate()
  }

  return (
    <Sheet open={template !== null} onOpenChange={(value) => { if (!value) onClose() }}>
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{existing ? existing.name : 'New template'}</SheetTitle>
          <SheetDescription>
            A template fills in the title and words of a new message. Pupil placeholders work only when the message goes to one pupil's family.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4">
          <div className="space-y-1.5">
            <Label htmlFor="template-name" className="text-[12.5px] text-muted-foreground">Name</Label>
            <Input id="template-name" value={name} maxLength={80} readOnly={!canEdit} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} />
            {errors.name && <p role="alert" className="text-[12.5px] text-tag-red">{errors.name}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="template-title" className="text-[12.5px] text-muted-foreground">Title</Label>
            <Input id="template-title" value={title} maxLength={MESSAGE_TITLE_MAX} readOnly={!canEdit} onChange={(e) => setTitle(e.target.value)} aria-invalid={!!errors.title} />
            {errors.title && <p role="alert" className="text-[12.5px] text-tag-red">{errors.title}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="template-body" className="text-[12.5px] text-muted-foreground">Message</Label>
            <Textarea id="template-body" rows={10} value={body} maxLength={MESSAGE_BODY_MAX} readOnly={!canEdit} onChange={(e) => setBody(e.target.value)} aria-invalid={!!errors.body} />
            {errors.body && <p role="alert" className="text-[12.5px] text-tag-red">{errors.body}</p>}
            <PlaceholderList names={PLACEHOLDERS_BY_KIND.notice} />
          </div>
        </div>
        {canEdit && (
          <SheetFooter className="flex-row justify-between">
            {existing ? <Button variant="outline" disabled={archive.isPending} onClick={() => archive.mutate()}>Archive</Button> : <span />}
            <Button disabled={save.isPending} onClick={onSave}>Save template</Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}

