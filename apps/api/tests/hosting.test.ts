import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { loadConfig, ConfigurationError } from '../src/config.ts'
import { createProviderDelivery } from '../src/delivery/index.ts'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
  startTestServer,
  testEnv,
  type TestServer,
} from './harness.ts'

const HELD_SMS_TOKEN = 'held-sms-token-for-tests-0123456789abcdef'
const PROVIDER = {
  DELIVERY_MODE: 'provider',
  RESEND_API_KEY: 're_test_key',
  EMAIL_FROM: 'no-reply@school.test',
}

let server: TestServer

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer({ ...PROVIDER, HELD_SMS_TOKEN })
  await adminPool().query('DELETE FROM held_sms')
})
after(async () => {
  await server.close()
  await closeAdminPool()
})

interface Sent {
  url: string
  authorization: string | null
  body: { from: string; to: string[]; subject: string; text: string }
}

function recordingFetch(status = 200): { calls: Sent[]; fetch: typeof fetch } {
  const calls: Sent[] = []
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)),
      })
      return new Response('{}', { status })
    },
  }
}

test('provider mode needs a key and a from address, and nothing else changes', () => {
  assert.throws(
    () => loadConfig(testEnv(1234, { DELIVERY_MODE: 'provider', RESEND_API_KEY: 're_x' })),
    ConfigurationError,
  )
  assert.equal(loadConfig(testEnv(1234, PROVIDER)).DELIVERY_MODE, 'provider')
})

test('the held-codes token is refused outside provider mode, and blob storage needs its token', () => {
  assert.throws(() => loadConfig(testEnv(1234, { HELD_SMS_TOKEN })), ConfigurationError)
  assert.throws(
    () => loadConfig(testEnv(1234, { DOCUMENT_STORAGE: 'blob' })),
    ConfigurationError,
  )
})

test('an invitation email links to the site and carries the token only in the link', async () => {
  const { calls, fetch } = recordingFetch()
  const delivery = createProviderDelivery({
    apiKey: 're_test_key',
    from: 'no-reply@school.test',
    appOrigin: 'https://erp.school.test',
    fetch,
  })
  await delivery.send({
    channel: 'email',
    to: 'teacher@school.test',
    purpose: 'invitation',
    secret: 'school-id.secret+/=',
  })
  assert.equal(calls.length, 1)
  const sent = calls[0]
  assert.ok(sent)
  assert.equal(sent.url, 'https://api.resend.com/emails')
  assert.equal(sent.authorization, 'Bearer re_test_key')
  assert.deepEqual(sent.body.to, ['teacher@school.test'])
  assert.ok(
    sent.body.text.includes(
      `https://erp.school.test/accept-invite?token=${encodeURIComponent('school-id.secret+/=')}`,
    ),
  )
  assert.ok(!sent.body.subject.includes('secret'))
  assert.deepEqual(delivery.outbox, [])
})

test('a reset email links to the reset screen', async () => {
  const { calls, fetch } = recordingFetch()
  const delivery = createProviderDelivery({
    apiKey: 'k',
    from: 'no-reply@school.test',
    appOrigin: 'https://erp.school.test',
    fetch,
  })
  await delivery.send({ channel: 'email', to: 'a@school.test', purpose: 'password_reset', secret: 'tok' })
  assert.ok(calls[0]?.body.text.includes('https://erp.school.test/reset-password?token=tok'))
})

test('a refused email is a failure, and the error does not echo the address', async () => {
  const { fetch } = recordingFetch(422)
  const delivery = createProviderDelivery({
    apiKey: 'k',
    from: 'no-reply@school.test',
    appOrigin: 'https://erp.school.test',
    fetch,
  })
  await assert.rejects(
    delivery.send({ channel: 'email', to: 'private@school.test', purpose: 'otp', secret: '123456' }),
    (error: Error) => !error.message.includes('private@school.test') && !error.message.includes('123456'),
  )
})

test('a text message fails when nothing holds it, so nobody is told it was sent', async () => {
  const { calls, fetch } = recordingFetch()
  const delivery = createProviderDelivery({
    apiKey: 'k',
    from: 'no-reply@school.test',
    appOrigin: 'https://erp.school.test',
    fetch,
  })
  await assert.rejects(
    delivery.send({ channel: 'sms', to: '+919800000001', purpose: 'otp', secret: '123456' }),
  )
  assert.equal(calls.length, 0)
})

test('a held text message is read with the token and by nobody else', async () => {
  const { calls, fetch } = recordingFetch()
  const delivery = createProviderDelivery({
    apiKey: 'k',
    from: 'no-reply@school.test',
    appOrigin: 'https://erp.school.test',
    heldSms: server.pools.auth,
    fetch,
  })
  await delivery.send({ channel: 'sms', to: '+919800000001', purpose: 'otp', secret: '654321' })
  assert.equal(calls.length, 0)

  for (const headers of [
    {},
    { authorization: 'Bearer wrong' },
    { authorization: HELD_SMS_TOKEN },
  ] as Record<string, string>[]) {
    const refused = await server.fetch('/api/held-codes', { headers })
    assert.equal(refused.status, 404)
    assert.ok(!(await refused.text()).includes('654321'))
  }

  const allowed = await server.fetch('/api/held-codes', {
    headers: { authorization: `Bearer ${HELD_SMS_TOKEN}` },
  })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.headers.get('cache-control'), 'no-store')
  const { messages } = (await allowed.json()) as {
    messages: { to: string; purpose: string; secret: string }[]
  }
  assert.deepEqual(
    messages.map(({ to, purpose, secret }) => ({ to, purpose, secret })),
    [{ to: '+919800000001', purpose: 'otp', secret: '654321' }],
  )
})

test('an expired held message is neither served nor kept', async () => {
  await adminPool().query("UPDATE held_sms SET expires_at = now() - interval '1 second'")
  const response = await server.fetch('/api/held-codes', {
    headers: { authorization: `Bearer ${HELD_SMS_TOKEN}` },
  })
  assert.deepEqual(await response.json(), { messages: [] })

  const delivery = createProviderDelivery({
    apiKey: 'k',
    from: 'no-reply@school.test',
    appOrigin: 'https://erp.school.test',
    heldSms: server.pools.auth,
  })
  await delivery.send({ channel: 'sms', to: '+919800000002', purpose: 'otp', secret: '111111' })
  const { rows } = await adminPool().query('SELECT recipient FROM held_sms')
  assert.deepEqual(rows, [{ recipient: '+919800000002' }])
})

test('without the token the held-codes route does not exist', async () => {
  const plain = await startTestServer()
  try {
    const response = await plain.fetch('/api/held-codes', {
      headers: { authorization: `Bearer ${HELD_SMS_TOKEN}` },
    })
    assert.equal(response.status, 404)
  } finally {
    await plain.close()
  }
})
