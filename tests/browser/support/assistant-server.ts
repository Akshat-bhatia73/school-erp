/**
 * The API for the browser suite: assembled exactly as apps/api/src/runtime.ts
 * assembles it, except that the assistant's model is a scripted one. The
 * tools, routes, sessions and database are all the real ones; only the words
 * and the tool calls a model would have chosen are fixed here, so no request
 * ever leaves the machine and production code carries no test switch
 * (`AppDependencies.assistant` is the existing test-only hook).
 *
 * The script reads the newest question and answers it, so each spec decides
 * what happens by what it asks:
 *
 *   "Which sections do I look after?"         find_sections, then words
 *   "Mark Eight R ... everyone present, Ravi absent"
 *                                             propose_attendance_day, then words
 *   anything containing FAIL_ONCE             fails the first time, answers after
 *
 * `ai` is not a dependency of this package, so it is loaded from the API's
 * own copy, the same way the seed reaches into apps/api.
 */
import { simulateReadableStream } from '../../../apps/api/node_modules/ai/dist/index.js'
import { MockLanguageModelV4 } from '../../../apps/api/node_modules/ai/dist/test/index.js'
import { loadConfig, type ApiConfig } from '../../../apps/api/src/config.ts'
import { createPools } from '../../../apps/api/src/db.ts'
import { createDelivery } from '../../../apps/api/src/delivery/index.ts'
import { createAuth } from '../../../apps/api/src/auth/better-auth.ts'
import { createBlobDocumentStorage } from '../../../apps/api/src/files/blob.ts'
import { createLocalDocumentStorage, type DocumentStorage } from '../../../apps/api/src/files/storage.ts'
import { initObservability } from '../../../apps/api/src/observability.ts'
import { buildApp } from '../../../apps/api/src/app.ts'
import { ASSIST_SECTION_R, ASSIST_SECTION_S } from '../setup/people.ts'
import { FAIL_ONCE, RETRIED_ANSWER, SECTIONS_ANSWER, SECTIONS_QUESTION } from './assistant-script.ts'

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
}

function finish(reason: 'stop' | 'tool-calls') {
  return { type: 'finish' as const, finishReason: { unified: reason, raw: undefined }, usage }
}

function say(text: string) {
  return {
    stream: simulateReadableStream({
      chunkDelayInMs: 10,
      chunks: [
        { type: 'text-start' as const, id: 't' },
        ...text.split(/(?<= )/).map((delta) => ({ type: 'text-delta' as const, id: 't', delta })),
        { type: 'text-end' as const, id: 't' },
        finish('stop'),
      ],
    }),
  }
}

let calls = 0
function call(toolName: string, input: unknown) {
  calls += 1
  return {
    stream: simulateReadableStream({
      chunkDelayInMs: 10,
      chunks: [
        { type: 'tool-call' as const, toolCallId: `call-${calls}`, toolName, input: JSON.stringify(input) },
        finish('tool-calls'),
      ],
    }),
  }
}

/** The parts of a prompt message the script reads. */
interface PromptMessage {
  role: string
  content: string | readonly { type: string; text?: string }[]
}

/** Questions that already failed once, so asking again gets an answer. */
const failedOnce = new Set<string>()

const model = new MockLanguageModelV4({
  provider: 'scripted',
  modelId: 'browser-suite',
  doStream: async (options: { prompt: unknown }) => {
    const prompt = options.prompt as readonly PromptMessage[]
    const newest = prompt.findLastIndex((message) => message.role === 'user')
    const content = prompt[newest]?.content
    const question = (Array.isArray(content)
      ? content.map((part) => (part.type === 'text' ? part.text ?? '' : '')).join('')
      : String(content ?? '')
    ).trim()
    const lower = question.toLowerCase()
    const toolsSoFar = prompt.slice(newest + 1).filter((message) => message.role === 'tool').length

    if (lower.includes(FAIL_ONCE.toLowerCase())) {
      if (!failedOnce.has(question)) {
        failedOnce.add(question)
        throw new Error('scripted failure, the first time only')
      }
      return say(RETRIED_ANSWER)
    }

    if (lower === SECTIONS_QUESTION.toLowerCase()) {
      if (toolsSoFar === 0) return call('find_sections', {})
      return say(SECTIONS_ANSWER)
    }

    // "Mark Eight R for today: everyone present, Ravi absent."
    const marking = lower.match(/^mark eight ([rs]) .*everyone present, (\w+) absent/)
    if (marking) {
      const section = marking[1] === 's' ? ASSIST_SECTION_S : ASSIST_SECTION_R
      if (toolsSoFar === 0) {
        return call('propose_attendance_day', {
          section: section.id,
          everyone: 'present',
          except: [{ pupil: marking[2], mark: 'absent' }],
        })
      }
      return say(`Here is ${section.label}'s register for today. Check it and press Confirm to save it.`)
    }

    return say('The browser suite has no script for that question.')
  },
})

function createDocuments(config: ApiConfig): DocumentStorage {
  if (config.DOCUMENT_STORAGE === 'blob' && config.BLOB_READ_WRITE_TOKEN)
    return createBlobDocumentStorage(config.BLOB_READ_WRITE_TOKEN)
  return createLocalDocumentStorage(config.DOCUMENT_STORAGE_DIR)
}

const config = loadConfig()
initObservability(config)
const pools = await createPools(config)
const delivery = createDelivery(config, pools.auth)
const auth = createAuth(config, pools.auth, delivery, pools.identity)
const documents = createDocuments(config)
const app = buildApp({
  config,
  auth,
  delivery,
  pools,
  documents,
  assistant: { assistantModel: model },
})

await app.listen({ port: config.PORT, host: config.HOST })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close()
    await pools.close()
  })
}
