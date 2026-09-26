/**
 * Runs the assistant's evaluation set against a fresh copy of the seeded
 * Sunrise school and writes a report. See docs/assistant/EVALS.md.
 *
 *   EVAL_DATABASE_URL=postgres://erp_migrator:erp_migrator@127.0.0.1:54329/erp_evals \
 *     pnpm --filter @erp/api eval [--scripted] [--no-seed] [--only id,prefix*] [--role teacher]
 *                                 [--language hi] [--repeat 3] [--gap-ms 4500]
 *
 * Without --scripted it calls the real configured model (ASSISTANT_PROVIDER,
 * ASSISTANT_MODEL and its key) and refuses to start without the key.
 */
import path from 'node:path'
import { parseArgs } from 'node:util'
import { openEnvironment } from './environment.ts'
import { EVALS_DIR } from './fixture.ts'
import { writeReport } from './report.ts'
import { runScenarios } from './runner.ts'
import { SCENARIO_SET_VERSION, SCENARIOS } from './scenarios/index.ts'
import type { Scenario } from './types.ts'

const { values } = parseArgs({
  options: {
    scripted: { type: 'boolean', default: false },
    'no-seed': { type: 'boolean', default: false },
    only: { type: 'string' },
    role: { type: 'string' },
    language: { type: 'string' },
    repeat: { type: 'string', default: '3' },
    'gap-ms': { type: 'string', default: process.env.EVAL_GAP_MS ?? '4500' },
    out: { type: 'string', default: path.join(EVALS_DIR, 'reports') },
  },
})

function selected(): Scenario[] {
  const only = values.only?.split(',').map((item) => item.trim()).filter(Boolean)
  return SCENARIOS.filter(
    (scenario) =>
      (!only || only.some((item) => (item.endsWith('*') ? scenario.id.startsWith(item.slice(0, -1)) : scenario.id === item))) &&
      (!values.role || scenario.role === values.role) &&
      (!values.language || scenario.language === values.language),
  )
}

const scenarios = selected()
if (scenarios.length === 0) {
  console.error('No scenario matches those options.')
  process.exit(1)
}
const repeat = Math.max(1, Number(values.repeat))
const gapMs = Math.max(0, Number(values['gap-ms']))
const log = (line: string) => console.info(line)

let env
try {
  env = await openEnvironment({ scripted: values.scripted, seed: !values['no-seed'], gapMs: values.scripted ? 0 : gapMs, log })
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

const startedAt = new Date().toISOString()
log(`Running ${scenarios.length} scenarios (set ${SCENARIO_SET_VERSION}) with ${env.modelId}.`)
try {
  const results = await runScenarios(env, scenarios, { repeat, log })
  const written = await writeReport(
    values.out,
    {
      setVersion: SCENARIO_SET_VERSION,
      modelId: env.modelId,
      provider: env.provider,
      scripted: values.scripted,
      startedAt,
      finishedAt: new Date().toISOString(),
      schoolDay: env.facts.today,
      repeat,
      gapMs: values.scripted ? 0 : gapMs,
    },
    results,
  )
  const run = results.filter((result) => !result.skipped)
  log(`\n${run.filter((result) => result.passed).length} of ${run.length} scenarios passed; ${results.length - run.length} skipped.`)
  log(`Report: ${written.markdown}`)
} finally {
  await env.close()
}
