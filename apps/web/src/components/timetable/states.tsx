import { CalendarDays, Lock } from 'lucide-react'
import { EmptyState } from '@/components/shared/page'
import { useSchoolContext } from '@/lib/session'

/** Shown when no academic year could be found for this person. */
export function NoAcademicYearState() {
  const { hasPermission } = useSchoolContext()
  return hasPermission('academic_years.read')
    ? <EmptyState icon={<CalendarDays />} title="No academic year is set up yet" description="Add an academic year in Setup before building the timetable." />
    : <EmptyState icon={<CalendarDays />} title="Nothing is assigned to you this year" description="Once a class is assigned to you, its week shows up here." />
}

/** One sentence for a screen the server refused. */
export function RefusedState({ sentence }: { sentence: string }) {
  return <EmptyState icon={<Lock />} title={sentence} />
}
