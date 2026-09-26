import type { PermissionKey } from '@erp/contracts'
import type { AnyProposeTool } from './types.ts'

/** Every change tool the assistant has. Each proposes one call to an existing write route. */
export const PROPOSE_TOOLS: readonly AnyProposeTool[] = []

/** The change tools offered to one person: those whose write permission they hold somewhere. */
export function proposeToolsFor(capabilities: ReadonlySet<PermissionKey>): readonly AnyProposeTool[] {
  return PROPOSE_TOOLS.filter((tool) => capabilities.has(tool.permission))
}

export function proposeToolNamed(name: string): AnyProposeTool | undefined {
  return PROPOSE_TOOLS.find((tool) => tool.name === name)
}
