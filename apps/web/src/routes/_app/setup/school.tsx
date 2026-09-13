import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '@/components/shared/page'
import { SetupTabs } from '@/components/setup/setup-tabs'
import { SchoolProfileBody, useSchoolProfile } from '@/components/setup/school-profile'
import { Button } from '@/components/ui/button'
import { useSession } from '@/lib/session'

export const Route = createFileRoute('/_app/setup/school')({ component: Page })

function Page() {
  const ctl = useSchoolProfile()
  const canEdit = useSession().can('school_setup', 'edit')
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'School setup' }, { label: 'School profile' }]}
        actions={canEdit ? <Button size="sm" disabled={!ctl.dirty || ctl.saving} onClick={ctl.submit}>Save changes</Button> : undefined}
        hideOnMobile
      />
      <SetupTabs actions={canEdit ? <Button size="sm" disabled={!ctl.dirty || ctl.saving} onClick={ctl.submit}>Save</Button> : undefined} />
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <SchoolProfileBody ctl={ctl} canEdit={canEdit} />
      </div>
    </>
  )
}
