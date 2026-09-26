import type { PermissionKey } from '@erp/contracts'
import type { AnyReadTool } from './types.ts'
import { ATTENDANCE_TOOLS } from './attendance.ts'
import { EXAM_TOOLS } from './exams.ts'
import { FEE_TOOLS } from './fees.ts'
import { MESSAGE_TOOLS } from './messages.ts'
import { REPORT_CARD_TOOLS } from './report-cards.ts'
import { SCHOOL_TOOLS } from './school.ts'
import { SETUP_TOOLS } from './setup.ts'
import { STAFF_TOOLS } from './staff.ts'
import { STUDENT_TOOLS } from './students.ts'
import { TIMETABLE_TOOLS } from './timetable.ts'

/** Every read tool the assistant has. Each one calls one or more existing GET routes as the person. */
export const READ_TOOLS: readonly AnyReadTool[] = [
  ...SCHOOL_TOOLS,
  ...SETUP_TOOLS,
  ...STUDENT_TOOLS,
  ...STAFF_TOOLS,
  ...TIMETABLE_TOOLS,
  ...ATTENDANCE_TOOLS,
  ...FEE_TOOLS,
  ...EXAM_TOOLS,
  ...REPORT_CARD_TOOLS,
  ...MESSAGE_TOOLS,
]

/** Whether one person is offered one tool: they hold every key it names somewhere in the school. */
export function isOffered(tool: AnyReadTool, capabilities: ReadonlySet<PermissionKey>): boolean {
  return capabilities.has(tool.permission) && (tool.alsoRequires ?? []).every((key) => capabilities.has(key))
}

/**
 * The tools offered to one person: those whose permissions they hold
 * somewhere in the school. A convenience for the model, not the boundary.
 */
export function toolsFor(capabilities: ReadonlySet<PermissionKey>): readonly AnyReadTool[] {
  return READ_TOOLS.filter((tool) => isOffered(tool, capabilities))
}
