import type { PermissionKey } from '@erp/contracts'
import type { AnyReadTool } from './types.ts'

/** Every read tool the assistant has. Each one calls one or more existing GET routes as the person. */
export const READ_TOOLS: readonly AnyReadTool[] = []

/**
 * The tools offered to one person: those whose route permission they hold
 * somewhere in the school. A convenience for the model, not the boundary.
 */
export function toolsFor(capabilities: ReadonlySet<PermissionKey>): readonly AnyReadTool[] {
  return READ_TOOLS.filter((tool) => capabilities.has(tool.permission))
}
