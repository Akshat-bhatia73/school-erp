import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '@/components/shared/page'
import { SetupTabs } from '@/components/setup/setup-tabs'
import { SchoolProfileBody, useSchoolProfile } from '@/components/setup/school-profile'
import { Button } from '@/components/ui/button'

export const Route = createFileRoute('/_app/setup/school')({ component: Page })

function Page() {
  const ctl = useSchoolProfile()
  const saveButton = (label: string) => (
    <Button size="sm" disabled={!ctl.dirty || ctl.saving} title={ctl.dirty ? undefined : 'Nothing to save yet'} onClick={ctl.submit}>{label}</Button>
  )
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'School setup' }, { label: 'School profile' }]}
        actions={ctl.canEdit ? saveButton('Save changes') : undefined}
        hideOnMobile
      />
      <SetupTabs actions={ctl.canEdit ? saveButton('Save') : undefined} />
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <SchoolProfileBody ctl={ctl} />
      </div>
    </>
  )
}
