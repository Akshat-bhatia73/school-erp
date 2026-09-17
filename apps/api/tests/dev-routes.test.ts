import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import pg from 'pg'
import { fixtureIds } from '@erp/db/fixtures'
import {
  MIGRATOR_URL,
  clientFor,
  resetRateLimits,
  seedDatabaseFixtures,
  startTestServer,
  type TestServer,
} from './harness.ts'

const PHONE = '+919000000009'

interface ErrorBody {
  error: { code: string; requestId: string }
}

interface OutboxBody {
  messages: {
    channel: string
    to: string
    purpose: string
    secret: string
    createdAt?: string
  }[]
}

let plain: TestServer
let withOutbox: TestServer
const admin = new pg.Pool({ connectionString: MIGRATOR_URL })

before(async () => {
  await seedDatabaseFixtures()
  plain = await startTestServer()
  withOutbox = await startTestServer({ DEV_SANDBOX_OUTBOX: 'true' })
  // A verified number is what makes the provider actually send a code.
  await admin.query(
    `UPDATE auth_user
        SET phone_number = $2, phone_number_verified = true
      WHERE id = $1`,
    [fixtureIds.parentA2User, PHONE],
  )
})

after(async () => {
  await plain.close()
  await withOutbox.close()
  await admin.end()
})

test('the development outbox does not exist by default', async () => {
  const response = await plain.fetch('/api/dev/outbox')
  assert.equal(response.status, 404)
  const body = (await response.json()) as ErrorBody
  assert.equal(body.error.code, 'RESOURCE_NOT_FOUND')
  assert.equal(typeof body.error.requestId, 'string')
})

test('the flag publishes the code the sandbox held', async () => {
  await resetRateLimits()
  const client = clientFor(withOutbox)
  const sent = await client.fetch('/api/auth/phone-number/send-otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phoneNumber: PHONE }),
  })
  assert.equal(sent.status, 200)

  const response = await withOutbox.fetch('/api/dev/outbox')
  assert.equal(response.status, 200)
  const body = (await response.json()) as OutboxBody
  const message = body.messages.at(0)
  assert.ok(message, 'the outbox listed no message')
  assert.equal(message.channel, 'sms')
  assert.equal(message.to, PHONE)
  assert.equal(message.purpose, 'otp')
  assert.match(message.secret, /^\d{6}$/)
  assert.ok(body.messages.length <= 50)
})
