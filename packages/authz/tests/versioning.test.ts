import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { AuthorizationError } from '../src/errors.ts'
import {
  assertAccessVersionCurrent,
  commitAccessChange,
  lockMembershipForAccessChange,
} from '../src/versioning.ts'
import { cleanup, contextFor, fx, insertMembership, seed, withRuntime } from './harness.ts'

let schoolA = ''

before(async () => {
  await seed()
  schoolA = fx('schoolA')
})

after(cleanup)

function contextOf(membershipId: string, accessVersion: number) {
  return contextFor({ schoolId: schoolA, membershipId, roleKeys: ['teacher'], accessVersion })
}

test('a missing membership is not found and a stale version conflicts', async () => {
  const { membershipId } = await insertMembership({ schoolId: schoolA, roleKeys: ['teacher'] })
  const context = contextOf(membershipId, 1)
  await assert.rejects(
    () =>
      withRuntime(context, (conn) =>
        lockMembershipForAccessChange(conn, schoolA, crypto.randomUUID(), 1),
      ),
    (error: unknown) => error instanceof AuthorizationError && error.code === 'RESOURCE_NOT_FOUND',
  )
  await assert.rejects(
    () => withRuntime(context, (conn) => lockMembershipForAccessChange(conn, schoolA, membershipId, 7)),
    (error: unknown) => error instanceof AuthorizationError && error.code === 'VERSION_CONFLICT',
  )
})

test('two access changes on the same membership serialise', async () => {
  const { membershipId } = await insertMembership({ schoolId: schoolA, roleKeys: ['teacher'] })
  const context = contextOf(membershipId, 1)
  const order: string[] = []
  let releaseFirst = (): void => {}
  const firstHasLock = new Promise<void>((resolveHasLock) => {
    const gate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate
    })
    void withRuntime(context, async (conn) => {
      await lockMembershipForAccessChange(conn, schoolA, membershipId, 1)
      order.push('first locked')
      resolveHasLock()
      await gate
      await commitAccessChange(conn, schoolA, membershipId, 1)
      order.push('first committed')
    }).then(() => order.push('first done'))
  })
  await firstHasLock

  const second = withRuntime(context, async (conn) => {
    const locked = await lockMembershipForAccessChange(conn, schoolA, membershipId, 2)
    order.push('second locked')
    return locked
  })
  // The second transaction is blocked on the row lock until the first commits.
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.deepEqual(order, ['first locked'])
  releaseFirst()
  const locked = await second
  assert.deepEqual(order.slice(0, 3), ['first locked', 'first committed', 'first done'])
  assert.equal(order[3], 'second locked')
  assert.equal(locked.version, 2)
  assert.equal(locked.accessVersion, 2)
})

test('committing with a stale expected version conflicts and invalidates old contexts', async () => {
  const { membershipId } = await insertMembership({ schoolId: schoolA, roleKeys: ['teacher'] })
  const staleContext = contextOf(membershipId, 1)
  const committed = await withRuntime(staleContext, (conn) =>
    commitAccessChange(conn, schoolA, membershipId, 1),
  )
  assert.deepEqual(committed, { version: 2, accessVersion: 2 })

  await assert.rejects(
    () => withRuntime(staleContext, (conn) => commitAccessChange(conn, schoolA, membershipId, 1)),
    (error: unknown) => error instanceof AuthorizationError && error.code === 'VERSION_CONFLICT',
  )
  await assert.rejects(
    () => withRuntime(staleContext, (conn) => assertAccessVersionCurrent(conn, staleContext)),
    (error: unknown) => error instanceof AuthorizationError && error.code === 'VERSION_CONFLICT',
  )
  const fresh = contextOf(membershipId, 2)
  await withRuntime(fresh, (conn) => assertAccessVersionCurrent(conn, fresh))
})

test('a membership that is no longer active fails the access version check', async () => {
  const { membershipId } = await insertMembership({
    schoolId: schoolA,
    roleKeys: ['teacher'],
    status: 'suspended',
  })
  const context = contextOf(membershipId, 1)
  await assert.rejects(
    () => withRuntime(context, (conn) => assertAccessVersionCurrent(conn, context)),
    (error: unknown) => error instanceof AuthorizationError && error.code === 'ACCESS_DENIED',
  )
})
