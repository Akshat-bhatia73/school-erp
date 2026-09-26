import type { PermissionKey } from '@erp/contracts'
import type { AnyProposeTool, ProposeToolDefinition } from './types.ts'
import { proposeAttendanceDay } from './attendance.ts'
import { proposeCoScholastic } from './co-scholastic.ts'
import { proposeExamMarks } from './exam-marks.ts'
import { proposeStaffAttendanceDay } from './staff-attendance.ts'

/**
 * The tools as the registry holds them. A definition with a typed input and
 * preview is not assignable to AnyProposeTool as written, so the list is
 * widened here, once, after each definition has been checked against its own.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function proposeToolList(...tools: readonly ProposeToolDefinition<any, any>[]): readonly AnyProposeTool[] {
  return tools as unknown as readonly AnyProposeTool[]
}

/** Every change tool the assistant has. Each proposes one call to an existing write route. */
export const PROPOSE_TOOLS: readonly AnyProposeTool[] = proposeToolList(
  proposeAttendanceDay,
  proposeStaffAttendanceDay,
  proposeExamMarks,
  proposeCoScholastic,
)

/** The change tools offered to one person: those whose write permission they hold somewhere. */
export function proposeToolsFor(capabilities: ReadonlySet<PermissionKey>): readonly AnyProposeTool[] {
  return PROPOSE_TOOLS.filter((tool) => capabilities.has(tool.permission))
}

export function proposeToolNamed(name: string): AnyProposeTool | undefined {
  return PROPOSE_TOOLS.find((tool) => tool.name === name)
}
