import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfigurationError, loadConfig } from '../src/config.ts'
import { assistantModel } from '../src/assistant/model.ts'
import { serviceOn } from '../src/assistant/limits.ts'
import { testEnv } from './harness.ts'

const configWith = (overrides: Record<string, string>) => loadConfig(testEnv(3999, { ASSISTANT_ENABLED: 'true', ...overrides }))

test('the gateway is the default: the model id as a string, Vertex only, zero data retention', () => {
  const config = configWith({})
  assert.equal(config.ASSISTANT_PROVIDER, 'gateway')
  assert.equal(config.ASSISTANT_MODEL, 'google/gemini-3.5-flash-lite')
  const chosen = assistantModel(config)
  assert.equal(chosen.model, 'google/gemini-3.5-flash-lite')
  assert.deepEqual(chosen.providerOptions, { gateway: { only: ['vertex'], zeroDataRetention: true } })
  assert.deepEqual(assistantModel(configWith({ ASSISTANT_ZERO_DATA_RETENTION: 'false' })).providerOptions, {
    gateway: { only: ['vertex'] },
  })
})

test('Google AI Studio is called directly with the model id behind google/', () => {
  const chosen = assistantModel(
    configWith({ ASSISTANT_PROVIDER: 'google', GOOGLE_GENERATIVE_AI_API_KEY: 'test-only-never-used' }),
  )
  assert.equal(typeof chosen.model, 'object')
  const model = chosen.model as { provider: string; modelId: string }
  assert.match(model.provider, /^google/)
  assert.equal(model.modelId, 'gemini-3.5-flash-lite')
  // No gateway routing leaks into a direct call.
  assert.deepEqual(chosen.providerOptions, {})
})

test('AI Studio needs a google/ model', () => {
  assert.throws(
    () => configWith({ ASSISTANT_PROVIDER: 'google', ASSISTANT_MODEL: 'openai/gpt-5' }),
    ConfigurationError,
  )
})

test('the service is on only with a credential for the chosen provider', () => {
  const noEnv = {} as NodeJS.ProcessEnv
  assert.equal(serviceOn(configWith({ ASSISTANT_PROVIDER: 'google' }), noEnv), false)
  assert.equal(
    serviceOn(configWith({ ASSISTANT_PROVIDER: 'google', GOOGLE_GENERATIVE_AI_API_KEY: 'k' }), noEnv),
    true,
  )
  // A gateway key does not switch on the direct provider, and the reverse.
  assert.equal(serviceOn(configWith({ ASSISTANT_PROVIDER: 'google', AI_GATEWAY_API_KEY: 'k' }), noEnv), false)
  assert.equal(serviceOn(configWith({ GOOGLE_GENERATIVE_AI_API_KEY: 'k' }), noEnv), false)
  assert.equal(serviceOn(configWith({ AI_GATEWAY_API_KEY: 'k' }), noEnv), true)
  assert.equal(serviceOn(configWith({ ASSISTANT_ENABLED: 'false', AI_GATEWAY_API_KEY: 'k' }), noEnv), false)
})
