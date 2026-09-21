import { Tag, colorFor } from '@/components/shared/tag'
import { cn } from '@/lib/utils'

export interface TimelineLesson {
  section: { id: string; name: string }
  subject: { id: string; name: string }
  roomNumber?: string
  cover: boolean
  coveredBy?: { id: string; name: string }
}

export interface TimelineSlotItem {
  periodIndex: number
  name: string
  startTime?: string
  endTime?: string
  type: 'period' | 'break' | 'lunch' | 'assembly'
  lesson?: TimelineLesson
}

/** The muted second line: what the grid shows under the tag. */
function secondary(lesson: TimelineLesson, mode: 'staff' | 'section'): string {
  const parts: string[] = []
  if (mode === 'staff') parts.push(lesson.subject.name)
  if (lesson.roomNumber) parts.push(`Room ${lesson.roomNumber}`)
  if (lesson.coveredBy) parts.push(`Covered by ${lesson.coveredBy.name}`)
  return parts.join(' · ')
}

function slotTimes(slot: TimelineSlotItem): string {
  return slot.startTime && slot.endTime ? `${slot.startTime}–${slot.endTime}` : slot.startTime ?? ''
}

/**
 * The day, one row per slot, reading like a column of the timetable grid: a period tag over a
 * muted second line, grey rows for breaks and a dashed box for a free period.
 */
export function DayTimeline({ slots, nowIndex, mode = 'staff', className }: {
  slots: TimelineSlotItem[]
  nowIndex?: number
  /** 'staff' leads with the class, 'section' leads with the subject. */
  mode?: 'staff' | 'section'
  className?: string
}) {
  return (
    <div className={cn('flex flex-col divide-y', className)}>
      {slots.map((slot) => {
        const times = slotTimes(slot)
        if (slot.type !== 'period') {
          return (
            <div key={`${slot.periodIndex}-${slot.name}`} className="-mx-1 flex min-h-8 items-center gap-3 rounded-md bg-muted/50 px-3 text-[12px] text-muted-foreground">
              <span className="tabular-nums">{times}</span>
              <span className="truncate">{slot.name}</span>
            </div>
          )
        }
        const isNow = nowIndex !== undefined && slot.periodIndex === nowIndex
        const lesson = slot.lesson
        return (
          <div
            key={`${slot.periodIndex}-${slot.name}`}
            className={cn('grid min-h-[52px] grid-cols-[6.5rem_1fr] items-center gap-2 py-1', isNow && 'rounded-md bg-accent/60')}
          >
            <div className="min-w-0 px-1">
              <p className="truncate text-[13px] font-medium">{slot.name}</p>
              {times && <p className="text-[12px] tabular-nums text-muted-foreground">{times}</p>}
            </div>
            {lesson ? (
              <div className="flex min-w-0 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  {mode === 'section'
                    ? <Tag color={colorFor(lesson.subject.id)}>{lesson.subject.name}</Tag>
                    : <Tag color={colorFor(lesson.section.id)}>{lesson.section.name}</Tag>}
                  {lesson.cover && <Tag color="orange">Cover</Tag>}
                  {isNow && <Tag color="blue">Now</Tag>}
                </span>
                <span className="truncate text-[12px] text-muted-foreground">{secondary(lesson, mode)}</span>
              </div>
            ) : (
              <div className="flex h-10 items-center rounded-lg border border-dashed px-2 text-[12.5px] text-muted-foreground">Free</div>
            )}
          </div>
        )
      })}
    </div>
  )
}
