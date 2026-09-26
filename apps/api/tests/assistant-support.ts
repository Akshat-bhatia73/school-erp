/**
 * Shared set-up for the assistant tests: a server built like the harness's,
 * with a scripted model and two tiny read tools in place of the gateway and
 * the registry. The real model is never called; there is no key.
 */
import { z } from 'zod'
import { APICallError, simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { loadConfig } from '../src/config.ts'
import { createPools } from '../src/db.ts'
import { createSandboxDelivery } from '../src/delivery/index.ts'
import { createAuth } from '../src/auth/better-auth.ts'
import { createMemoryDocumentStorage } from '../src/files/storage.ts'
import { buildApp } from '../src/app.ts'
import { readTool, refusal, type AnyReadTool } from '../src/assistant/tools/types.ts'
import { closeRateLimitPool, CookieJar, freePort, testEnv, type TestServer } from './harness.ts'

/** Reads the school context as the person: proves the inner call carries their session. */
export const schoolContextTool = readTool({
  name: 'school_context',
  description: 'The school the person is signed in to.',
  permission: 'ai_assistant.use',
  input: z.object({}),
  run: async (_input, context) => {
    const answer = await context.get('/context')
    if (!answer.ok) return refusal(answer)
    const body = answer.body as { school: { name: string }; roleKeys: string[] }
    return {
      status: 'ok',
      card: {
        kind: 'figures',
        title: 'CARD-ONLY-TITLE',
        items: [{ label: 'Roles', value: { type: 'number', value: body.roleKeys.length } }],
      },
      source: { label: 'School', href: '/' },
      forModel: { school: body.school.name },
    }
  },
})

/** A route most people may not read: the answer is "not available to you". */
export const assistantSettingsTool = readTool({
  name: 'assistant_settings',
  description: "The school's assistant settings.",
  permission: 'ai_assistant.use',
  input: z.object({}),
  run: async (_input, context) => {
    const answer = await context.get('/assistant/settings')
    if (!answer.ok) return refusal(answer)
    return { status: 'ok', forModel: answer.body }
  },
})

/** What the health tool gives the model, and the title of its card: found anywhere later, it leaked. */
export const HEALTH_FOR_MODEL = 'HEALTH-FOR-MODEL-ONLY'
export const HEALTH_CARD_TITLE = 'HEALTH-CARD-ONLY'

/** A tool behind a key an owner can take away (students.read_medical), to prove old results go with it. */
export const healthNoteTool = readTool({
  name: 'health_note',
  description: 'A health note.',
  permission: 'students.read_medical',
  input: z.object({}),
  run: async () => ({
    status: 'ok',
    card: { kind: 'figures', title: HEALTH_CARD_TITLE, items: [{ label: 'Notes', value: { type: 'number', value: 1 } }] },
    forModel: { note: HEALTH_FOR_MODEL },
  }),
})

/** A lookup that always fails, as a route that errors would. */
export const brokenLookupTool = readTool({
  name: 'broken_lookup',
  description: 'A lookup that fails.',
  permission: 'ai_assistant.use',
  input: z.object({}),
  run: async () => ({ status: 'failed' }),
})

export const TEST_TOOLS: readonly AnyReadTool[] = [
  schoolContextTool as unknown as AnyReadTool,
  assistantSettingsTool as unknown as AnyReadTool,
  healthNoteTool as unknown as AnyReadTool,
  brokenLookupTool as unknown as AnyReadTool,
]

const usage = {
  inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 7, text: 7, reasoning: undefined },
}

/** The words that make the scripted model fail, to exercise the failure path. */
export const FAIL_WORDS = 'please fail now'
/** The words that make it fail the first time it is asked them, and answer after. */
export const FAIL_ONCE_WORDS = 'please fail the first time'
/** The words that make it answer slowly, so a test can leave halfway. */
export const SLOW_WORDS = 'please answer slowly'
/** The words that make it call the health tool. */
export const HEALTH_WORDS = 'please read the health note'
/** The words that make it call the lookup that fails. */
export const BROKEN_WORDS = 'please try the broken lookup'
/** The words that make the provider refuse, with PROVIDER_SECRET in its message and body. */
export const PROVIDER_FAIL_WORDS = 'please make the provider refuse'
/** Free text in a provider's refusal: it must never reach a log. */
export const PROVIDER_SECRET = 'PROVIDER-FREE-TEXT-NEVER-LOGGED'
export const PROVIDER_REQUEST_ID = 'prov-req-4711'

/** One step that calls one tool. */
function callOne(toolName: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'tool-call' as const, toolCallId: `call-${toolName}`, toolName, input: '{}' },
        { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage },
      ],
    }),
  }
}

/**
 * A scripted model. On a new question it calls both test tools in one step;
 * once it has their results it answers in words; asked FAIL_WORDS it fails.
 */
export function scriptedModel(): MockLanguageModelV4 {
  const failedOnce = new Set<string>()
  return new MockLanguageModelV4({
    provider: 'test',
    modelId: 'scripted',
    doStream: async (options) => {
      const last = options.prompt[options.prompt.length - 1]
      const lastText = JSON.stringify(last?.content ?? '')
      if (last?.role === 'user' && lastText.includes(FAIL_WORDS)) throw new Error('scripted failure')
      if (last?.role === 'user' && lastText.includes(FAIL_ONCE_WORDS) && !failedOnce.has(lastText)) {
        failedOnce.add(lastText)
        throw new Error('scripted failure')
      }
      if (last?.role === 'user' && lastText.includes(PROVIDER_FAIL_WORDS)) {
        throw new APICallError({
          message: `Quota exceeded: ${PROVIDER_SECRET}`,
          url: 'https://provider.invalid/v1/generate',
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { 'x-request-id': PROVIDER_REQUEST_ID },
          responseBody: JSON.stringify({
            error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `Quota exceeded for ${PROVIDER_SECRET}` },
          }),
          isRetryable: false,
        })
      }
      if (last?.role === 'user' && lastText.includes(HEALTH_WORDS)) return callOne('health_note')
      if (last?.role === 'user' && lastText.includes(BROKEN_WORDS)) return callOne('broken_lookup')
      if (last?.role === 'user' && lastText.includes(SLOW_WORDS)) {
        return {
          stream: simulateReadableStream({
            chunkDelayInMs: 100,
            chunks: [
              { type: 'text-start', id: 't1' },
              ...Array.from({ length: 40 }, () => ({ type: 'text-delta' as const, id: 't1', delta: 'word ' })),
              { type: 'text-end', id: 't1' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
            ],
          }),
        }
      }
      if (last?.role === 'tool') {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'Here is what I found.' },
              { type: 'text-end', id: 't1' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
            ],
          }),
        }
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'school_context', input: '{}' },
            { type: 'tool-call', toolCallId: 'call-2', toolName: 'assistant_settings', input: '{}' },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ],
        }),
      }
    },
  })
}

export async function startAssistantServer(
  overrides: Record<string, string> = {},
  model: MockLanguageModelV4 = scriptedModel(),
): Promise<TestServer & { model: MockLanguageModelV4; logs: string[] }> {
  const port = await freePort()
  const config = loadConfig(
    testEnv(port, {
      ASSISTANT_ENABLED: 'true',
      AI_GATEWAY_API_KEY: 'test-only-never-used',
      CRON_SECRET: 'assistant-test-cron-secret-0123456789abcdef',
      ...overrides,
    }),
  )
  const pools = await createPools(config)
  const delivery = createSandboxDelivery(() => {})
  const auth = createAuth(config, pools.auth, delivery, pools.identity)
  const documents = createMemoryDocumentStorage()
  const app = buildApp({
    config,
    auth,
    delivery,
    pools,
    documents,
    assistant: { assistantModel: model, assistantTools: TEST_TOOLS },
  })
  // Every line a request logs, as JSON, so a test can prove what never
  // reaches a log. The logger is silent in tests; this sees each call anyway.
  const logs: string[] = []
  app.addHook('onRequest', async (request) => {
    const inner = request.log
    request.log = new Proxy(inner, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown
        if (typeof property === 'string' && ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(property)) {
          return (...args: unknown[]) => {
            logs.push(JSON.stringify(args))
            return (value as (...values: unknown[]) => void).apply(target, args)
          }
        }
        return typeof value === 'function' ? (value as (...values: unknown[]) => unknown).bind(target) : value
      },
    })
  })
  await app.listen({ port: config.PORT, host: '127.0.0.1' })
  const origin = `http://127.0.0.1:${config.PORT}`
  const jar = new CookieJar()
  return {
    config,
    auth,
    delivery,
    pools,
    documents,
    origin,
    jar,
    model,
    logs,
    async fetch(path, init = {}) {
      const headers = new Headers(init.headers)
      const cookie = jar.header()
      if (cookie && !headers.has('cookie')) headers.set('cookie', cookie)
      if (!headers.has('origin')) headers.set('origin', origin)
      const response = await fetch(`${origin}${path}`, { ...init, headers })
      jar.capture(response)
      return response
    },
    async close() {
      await app.close()
      await pools.close()
      await closeRateLimitPool()
    },
  }
}

/** The data lines of a UI message stream, parsed. */
export function streamParts(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>)
}
