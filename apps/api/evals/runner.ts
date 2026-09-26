/**
 * Runs scenarios: each run in a fresh conversation, through the real turn
 * and confirm routes, as the scenario's person; then the checks.
 */
import { randomUUID } from 'node:crypto'
import { checkTurn } from './check.ts'
import type { InjectClient } from './client.ts'
import type { EvalEnvironment } from './environment.ts'
import { parseTurn } from './stream.ts'
import type { Failure, Scenario, Script, TurnRecord } from './types.ts'

export interface RunOptions {
  /** How many times a high-risk scenario runs. */
  readonly repeat: number
  readonly log?: (line: string) => void
}

export interface RunRecord {
  readonly passed: boolean
  readonly failures: readonly Failure[]
  /** The measured turn: the last one. Earlier turns are setup. */
  readonly turn: TurnRecord
  readonly setupFailures: readonly Failure[]
  readonly ms: number
}

export interface ScenarioResult {
  readonly scenario: Scenario
  readonly question: string
  readonly skipped?: string
  readonly runs: readonly RunRecord[]
  /** Every run passed. */
  readonly passed: boolean
}

/** What the turn route says when the provider refused for being busy (src/assistant/turn.ts). */
const BUSY = 'The assistant is busy right now'
const BUSY_WAIT_MS = 60_000

/** Writing scenarios last: they change registers other scenarios read blank. */
export function runOrder(scenarios: readonly Scenario[]): Scenario[] {
  return [...scenarios.filter((scenario) => !scenario.writes), ...scenarios.filter((scenario) => scenario.writes)]
}

async function ask(env: EvalEnvironment, client: InjectClient, threadId: string, text: string): Promise<TurnRecord> {
  const answer = await client.post(`/api/schools/${env.facts.schoolId}/assistant/threads/${threadId}/turns`, {
    messageId: randomUUID(),
    text,
  })
  return parseTurn(answer.status, answer.body)
}

async function runOnce(env: EvalEnvironment, scenario: Scenario, question: string): Promise<RunRecord> {
  const started = Date.now()
  const { facts } = env
  const client = env.clients[scenario.role]
  const base = `/api/schools/${facts.schoolId}/assistant`
  const created = await client.post(`${base}/threads`)
  if (created.status !== 201) throw new Error(`A conversation could not be started for ${scenario.role}: ${created.status}`)
  const threadId = created.json<{ id: string }>().id
  const setScript = (script: Script | undefined) => env.setScriptedTurn({ script, facts, language: scenario.language })

  const setupFailures: Failure[] = []
  for (const [index, setup] of (scenario.setup ?? []).entries()) {
    setScript(setup.script)
    const turn = await ask(env, client, threadId, setup.question(facts))
    if (turn.errored) setupFailures.push({ kind: 'error', reason: `setup turn ${index + 1} failed` })
    if (!setup.confirm) continue
    const proposal = turn.proposals.at(-1)
    if (!proposal) {
      setupFailures.push({ kind: 'proposal', reason: `setup turn ${index + 1} made no proposal to confirm` })
      continue
    }
    const confirmed = await client.post(`${base}/proposals/${proposal.id}/confirm`, { preview: setup.confirm(proposal.preview, facts) })
    const status = confirmed.status === 200 ? confirmed.json<{ proposal: { status: string; outcome?: string } }>().proposal : undefined
    if (status?.status !== 'done') {
      setupFailures.push({ kind: 'error', reason: `confirming setup turn ${index + 1} did not save: ${confirmed.status} ${status?.outcome ?? confirmed.body.slice(0, 200)}` })
    }
  }

  setScript(scenario.script)
  const turn = await ask(env, client, threadId, question)
  env.setScriptedTurn(undefined)
  const truth = scenario.truth ? await scenario.truth({ db: env.db, facts }) : undefined
  const failures = [...setupFailures, ...checkTurn({ checks: scenario.checks(facts), truth, language: scenario.language }, turn)]
  return { passed: failures.length === 0, failures, turn, setupFailures, ms: Date.now() - started }
}

/** Every scenario, in run order. A scenario that cannot run today, or has no script in scripted mode, is skipped. */
export async function runScenarios(env: EvalEnvironment, scenarios: readonly Scenario[], options: RunOptions): Promise<ScenarioResult[]> {
  const log = options.log ?? (() => {})
  const scripted = env.modelId === 'scripted'
  const results: ScenarioResult[] = []
  for (const scenario of runOrder(scenarios)) {
    const question = scenario.question(env.facts)
    const skipped =
      scenario.skip?.(env.facts) ??
      (scripted && (!scenario.script || (scenario.setup ?? []).some((turn) => !turn.script)) ? 'no script for --scripted' : null)
    if (skipped) {
      log(`- ${scenario.id}: skipped (${skipped})`)
      results.push({ scenario, question, skipped, runs: [], passed: false })
      continue
    }
    const times = scenario.writes ? 1 : scenario.risk === 'high' ? options.repeat : 1
    const runs: RunRecord[] = []
    for (let attempt = 0; attempt < times; attempt += 1) {
      let run = await runOnce(env, scenario, question)
      // A provider that said "too many" gets a minute, twice, before the run counts.
      for (let retry = 0; retry < 2 && !scripted && run.turn.text.includes(BUSY); retry += 1) {
        log(`  ${scenario.id}: the provider is busy; waiting a minute`)
        await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS))
        run = await runOnce(env, scenario, question)
      }
      runs.push(run)
    }
    const passed = runs.every((run) => run.passed)
    log(`${passed ? '✓' : '✗'} ${scenario.id} (${runs.filter((run) => run.passed).length}/${runs.length})`)
    for (const failure of new Set(runs.flatMap((run) => run.failures.map((item) => `${item.kind}: ${item.reason}`)))) log(`    ${failure}`)
    results.push({ scenario, question, runs, passed })
  }
  return results
}
