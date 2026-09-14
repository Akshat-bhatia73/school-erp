import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ROLE_DELEGATION_RULES } from '@erp/contracts'
import type { RoleKey } from '@erp/contracts'

import {
  assignableRolesFor,
  checkMembershipLifecycle,
  checkRoleAssignment,
  mayTransferOwnership,
} from '../src/delegation.ts'

const ACTOR = 'membership-actor'
const TARGET = 'membership-target'

function assign(input: {
  actorRoleKeys: readonly RoleKey[]
  targetCurrentRoleKeys: readonly RoleKey[]
  proposedRoleKeys: readonly RoleKey[]
  actorMembershipId?: string
  targetMembershipId?: string
}) {
  return checkRoleAssignment({
    actorMembershipId: input.actorMembershipId ?? ACTOR,
    actorRoleKeys: input.actorRoleKeys,
    targetMembershipId: input.targetMembershipId ?? TARGET,
    targetCurrentRoleKeys: input.targetCurrentRoleKeys,
    proposedRoleKeys: input.proposedRoleKeys,
  })
}

test('assignable roles are the union of the actor delegation rules', () => {
  assert.deepEqual(assignableRolesFor(['owner']), [...ROLE_DELEGATION_RULES.owner.assignableRoles])
  assert.deepEqual(assignableRolesFor(['principal', 'admin']), ['teacher'])
  assert.deepEqual(assignableRolesFor(['accountant', 'teacher', 'parent']), [])
  assert.deepEqual(assignableRolesFor([]), [])
})

test('an owner may assign every non-owner, non-student role', () => {
  for (const role of ['principal', 'admin', 'accountant', 'teacher', 'parent'] as const) {
    assert.deepEqual(assign({ actorRoleKeys: ['owner'], targetCurrentRoleKeys: [], proposedRoleKeys: [role] }), { ok: true }, role)
  }
})

test('a principal or administrator may only assign the teacher role', () => {
  for (const actor of ['principal', 'admin'] as const) {
    assert.deepEqual(assign({ actorRoleKeys: [actor], targetCurrentRoleKeys: [], proposedRoleKeys: ['teacher'] }), { ok: true })
    assert.deepEqual(assign({ actorRoleKeys: [actor], targetCurrentRoleKeys: [], proposedRoleKeys: ['accountant'] }), {
      ok: false,
      reason: 'NOT_DELEGABLE',
    })
    assert.deepEqual(assign({ actorRoleKeys: [actor], targetCurrentRoleKeys: [], proposedRoleKeys: ['principal'] }), {
      ok: false,
      reason: 'NOT_DELEGABLE',
    })
  }
})

test('changing your own roles is refused', () => {
  assert.deepEqual(
    assign({ actorRoleKeys: ['owner'], targetMembershipId: ACTOR, targetCurrentRoleKeys: ['teacher'], proposedRoleKeys: ['admin'] }),
    { ok: false, reason: 'SELF_CHANGE' },
  )
})

test('owner and student roles are never touched by generic assignment', () => {
  assert.deepEqual(assign({ actorRoleKeys: ['owner'], targetCurrentRoleKeys: [], proposedRoleKeys: ['owner'] }), {
    ok: false,
    reason: 'OWNER_OR_STUDENT_ROLE',
  })
  assert.deepEqual(assign({ actorRoleKeys: ['owner'], targetCurrentRoleKeys: ['owner'], proposedRoleKeys: ['teacher'] }), {
    ok: false,
    reason: 'OWNER_OR_STUDENT_ROLE',
  })
  assert.deepEqual(assign({ actorRoleKeys: ['owner'], targetCurrentRoleKeys: [], proposedRoleKeys: ['student'] }), {
    ok: false,
    reason: 'OWNER_OR_STUDENT_ROLE',
  })
  assert.deepEqual(assign({ actorRoleKeys: ['owner'], targetCurrentRoleKeys: ['student'], proposedRoleKeys: ['teacher'] }), {
    ok: false,
    reason: 'OWNER_OR_STUDENT_ROLE',
  })
})

test('a target that already holds an unmanageable role is refused', () => {
  assert.deepEqual(assign({ actorRoleKeys: ['principal'], targetCurrentRoleKeys: ['teacher', 'parent'], proposedRoleKeys: ['teacher'] }), {
    ok: false,
    reason: 'TARGET_NOT_MANAGEABLE',
  })
  assert.deepEqual(assign({ actorRoleKeys: ['owner'], targetCurrentRoleKeys: ['teacher', 'parent'], proposedRoleKeys: ['teacher', 'parent'] }), { ok: true })
})

test('roles left unchanged on the target still have to be assignable by the actor', () => {
  assert.deepEqual(assign({ actorRoleKeys: ['principal'], targetCurrentRoleKeys: ['teacher'], proposedRoleKeys: ['teacher', 'accountant'] }), {
    ok: false,
    reason: 'NOT_DELEGABLE',
  })
})

test('roles without delegation authority cannot assign anything', () => {
  for (const actor of ['accountant', 'teacher', 'parent'] as const) {
    assert.deepEqual(assign({ actorRoleKeys: [actor], targetCurrentRoleKeys: [], proposedRoleKeys: ['teacher'] }), {
      ok: false,
      reason: 'NO_AUTHORITY',
    })
  }
})

test('membership lifecycle needs management authority over every target role', () => {
  const lifecycle = (actorRoleKeys: readonly RoleKey[], targetRoleKeys: readonly RoleKey[], targetMembershipId = TARGET) =>
    checkMembershipLifecycle({ actorMembershipId: ACTOR, actorRoleKeys, targetMembershipId, targetRoleKeys })

  assert.deepEqual(lifecycle(['owner'], ['teacher', 'parent']), { ok: true })
  assert.deepEqual(lifecycle(['principal'], ['teacher']), { ok: true })
  assert.deepEqual(lifecycle(['principal'], ['teacher', 'accountant']), { ok: false, reason: 'TARGET_NOT_MANAGEABLE' })
  assert.deepEqual(lifecycle(['principal'], ['teacher', 'owner']), { ok: false, reason: 'OWNER_OR_STUDENT_ROLE' })
  assert.deepEqual(lifecycle(['owner'], ['owner']), { ok: false, reason: 'OWNER_OR_STUDENT_ROLE' })
  assert.deepEqual(lifecycle(['owner'], ['student']), { ok: false, reason: 'OWNER_OR_STUDENT_ROLE' })
  assert.deepEqual(lifecycle(['teacher'], ['teacher']), { ok: false, reason: 'NO_AUTHORITY' })
  assert.deepEqual(lifecycle(['owner'], ['teacher'], ACTOR), { ok: false, reason: 'SELF_CHANGE' })
})

test('only an owner may transfer ownership', () => {
  assert.equal(mayTransferOwnership(['owner']), true)
  assert.equal(mayTransferOwnership(['owner', 'teacher']), true)
  for (const role of ['principal', 'admin', 'accountant', 'teacher', 'parent', 'student'] as const) {
    assert.equal(mayTransferOwnership([role]), false, role)
  }
})
