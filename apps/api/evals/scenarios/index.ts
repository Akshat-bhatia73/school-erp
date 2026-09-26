import type { Scenario } from '../types.ts'
import { ACCESS } from './access.ts'
import { HINDI } from './hindi.ts'
import { READS } from './reads.ts'
import { WRITES } from './writes.ts'

/**
 * The version of the set. Bump it whenever a scenario is added, removed or
 * its question or checks change, so two reports are only compared like for
 * like. Reports carry it.
 */
export const SCENARIO_SET_VERSION = '2026-09-26.1'

export const SCENARIOS: readonly Scenario[] = [...READS, ...ACCESS, ...WRITES, ...HINDI]

const ids = new Set<string>()
for (const scenario of SCENARIOS) {
  if (ids.has(scenario.id)) throw new Error(`Two scenarios are called ${scenario.id}.`)
  ids.add(scenario.id)
}
