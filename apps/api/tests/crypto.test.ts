import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { maskApaar, open, seal } from '../src/modules/shared/crypto.ts'
import { studentProjection } from '../src/modules/students/reads.ts'

const KEY = randomBytes(32).toString('base64')

test('a sealed value round trips and hides the plain text', () => {
  const sealed = seal('123456789012', KEY)
  assert.match(sealed, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/)
  assert.equal(sealed.includes('123456789012'), false)
  assert.equal(open(sealed, KEY), '123456789012')
})

test('each seal uses a fresh nonce, so the same value seals differently', () => {
  const first = seal('123456789012', KEY)
  const second = seal('123456789012', KEY)
  assert.notEqual(first, second)
  assert.equal(open(second, KEY), '123456789012')
})

test('a tampered value, a wrong key or a wrong format is refused, never guessed', () => {
  const sealed = seal('123456789012', KEY)
  const parts = sealed.split('.')
  const flipped = Buffer.from(parts[3] as string, 'base64url')
  flipped[0] = (flipped[0] as number) ^ 0xff
  assert.throws(() => open([parts[0], parts[1], parts[2], flipped.toString('base64url')].join('.'), KEY))
  assert.throws(() => open(sealed, randomBytes(32).toString('base64')))
  assert.throws(() => open('v2.a.b.c', KEY))
  assert.throws(() => open(sealed, randomBytes(16).toString('base64')))
})

test('the mask shows four digits and nothing else', () => {
  assert.equal(maskApaar('9012'), 'XXXX-XXXX-9012')
})

test('a roster statement never names a sensitive or medical column', () => {
  const basic = studentProjection({ sensitive: false, medical: false })
  const text = JSON.stringify(basic)
  for (const column of [
    'medical_notes',
    'blood_group',
    'apaar_ciphertext',
    'apaar_last4',
    'aadhaar_last4',
    'date_of_birth',
    'address',
  ]) {
    assert.equal(text.includes(column), false, `the basic projection named ${column}`)
  }
  // The detail read, having decided both keys, is the only one that may.
  const full = JSON.stringify(studentProjection({ sensitive: true, medical: true }))
  assert.equal(full.includes('medical_notes'), true)
  assert.equal(full.includes('apaar_ciphertext'), true)
})
