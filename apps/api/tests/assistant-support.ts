/**
 * Shared set-up for the assistant tests: a server built like the harness's,
 * with a scripted model and two tiny read tools in place of the gateway and
 * the registry. The real model is never called; there is no key.
 */
import { z } from 'zod'
import { simulateReadableStream } from 'ai'
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

export const TEST_TOOLS: readonly AnyReadTool[] = [
  schoolContextTool as unknown as AnyReadTool,
  assistantSettingsTool as unknown as AnyReadTool,
]

const usage = {
  inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 7, text: 7, reasoning: undefined },
}

/** The words that make the scripted model fail, to exercise the failure path. */
export const FAIL_WORDS = 'please fail now'
/** The words that make it answer slowly, so a test can leave halfway. */
export const SLOW_WORDS = 'please answer slowly'

/**
 * A scripted model. On a new question it calls both test tools in one step;
 * once it has their results it answers in words; asked FAIL_WORDS it fails.
 */
export function scriptedModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'test',
    modelId: 'scripted',
    doStream: async (options) => {
      const last = options.prompt[options.prompt.length - 1]
      const lastText = JSON.stringify(last?.content ?? '')
      if (last?.role === 'user' && lastText.includes(FAIL_WORDS)) throw new Error('scripted failure')
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
): Promise<TestServer & { model: MockLanguageModelV4 }> {
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
