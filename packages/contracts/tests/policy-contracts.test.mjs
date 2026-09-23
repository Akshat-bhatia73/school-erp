import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import * as c from '../src/index.ts'
import { outputPath, renderMatrix } from '../scripts/generate-matrix.mjs'

test('every role grants only supported active permission/scope pairs, without duplicates', () => {
  for (const [role, template] of Object.entries(c.ROLE_TEMPLATES)) {
    const seen = new Set()
    for (const grant of template.grants) {
      assert.equal(c.RoleGrant.safeParse(grant).success, true, `${role}: ${JSON.stringify(grant)}`)
      const key = `${grant.permission}:${grant.scope}`
      assert.equal(seen.has(key), false, `${role}: duplicate ${key}`)
      seen.add(key)
    }
  }
  assert.deepEqual(c.ROLE_TEMPLATES.student.grants, [])
})

test('malformed grants cannot introduce reserved actions, arbitrary scopes or bypass flags', () => {
  for (const grant of [
    { permission: 'roles.assign', scope: 'own_children' },
    { permission: 'communication.read', scope: 'school' },
    { permission: '*', scope: 'school' },
    { permission: 'students.read_basic', scope: 'school', bypass: true },
  ]) assert.equal(c.RoleGrant.safeParse(grant).success, false)
})

test('salary is owner/accountant only and ordinary teacher grants do not force privileged MFA', () => {
  for (const [role, template] of Object.entries(c.ROLE_TEMPLATES)) {
    if (!['owner', 'accountant'].includes(role)) assert.equal(template.grants.some((g) => g.permission.includes('_pay')), false, role)
  }
  assert.equal(c.ROLE_TEMPLATES.teacher.requiredMfa, false)
  for (const grant of c.ROLE_TEMPLATES.teacher.grants) {
    assert.equal(c.PERMISSION_CATALOGUE[grant.permission].privilegedScopes.includes(grant.scope), false, grant.permission)
  }
  for (const role of ['owner', 'principal', 'admin', 'accountant']) assert.equal(c.ROLE_TEMPLATES[role].requiredMfa, true)
})

test('parent/teacher records remain relationship scoped; admin does not read audit', () => {
  for (const role of ['teacher', 'parent']) {
    const grants = c.ROLE_TEMPLATES[role].grants.filter((g) => g.permission === 'students.read_basic')
    assert.deepEqual(grants.map((g) => g.scope), [role === 'teacher' ? 'assigned_sections' : 'own_children'])
    assert.equal(c.ROLE_TEMPLATES[role].grants.some((g) => g.permission === 'staff.read_pay' || g.permission === 'members.read'), false)
  }
  assert.equal(c.ROLE_TEMPLATES.parent.grants.some((g) => g.permission === 'staff.read_directory'), false)
  assert.equal(c.ROLE_TEMPLATES.admin.grants.some((g) => g.permission === 'audit.read'), false)
})

test('assignment and lifecycle envelopes exclude owners and limit principals/clerks to teachers', () => {
  for (const rule of Object.values(c.ROLE_DELEGATION_RULES)) {
    assert.equal(rule.assignableRoles.includes('owner'), false)
    assert.equal(rule.assignableRoles.includes('student'), false)
  }
  for (const role of ['principal', 'admin']) {
    assert.deepEqual(c.ROLE_DELEGATION_RULES[role].assignableRoles, ['teacher'])
    assert.deepEqual(c.ROLE_MANAGEMENT_RULES[role].manageableTargetRoles, ['teacher'])
  }
  assert.equal(c.ROLE_MANAGEMENT_RULES.owner.manageableTargetRoles.includes('owner'), false)
})

test('catalogue resource types and privileged scopes are closed and consistent', () => {
  assert.deepEqual(Object.keys(c.PERMISSION_CATALOGUE), c.PermissionKey.options)
  for (const meta of Object.values(c.PERMISSION_CATALOGUE)) {
    assert.equal(c.ResourceType.safeParse(meta.resourceType).success, true)
    for (const scope of meta.privilegedScopes) assert.equal(meta.scopes.includes(scope), true)
  }
})

test('application routes have active action requirements; only context/bootstrap omit an action', () => {
  for (const [key, route] of Object.entries(c.ACCESS_ENDPOINTS)) {
    if (!['me', 'context', 'acceptInvite'].includes(key)) assert.equal(c.PERMISSION_CATALOGUE[route.permission].availability, 'active', key)
    assert.equal(route.auth === 'public', false)
    for (const permission of route.additionalPermissions ?? []) assert.equal(c.PERMISSION_CATALOGUE[permission].availability, 'active')
  }
  for (const action of ['invite', 'resendInvite', 'restore']) {
    assert.deepEqual(c.ACCESS_ENDPOINTS[action].additionalPermissions, ['roles.assign'], action)
  }
  assert.equal(c.AccessExplanationQuery.safeParse({ permission: 'staff.read_pay', resourceType: 'student', resourceId: 'one' }).success, false)
})

test('terminal invitations cannot be reaccepted or revived by resend', () => {
  assert.equal(c.INVITATION_TRANSITIONS.every((t) => t.from === 'pending'), true)
  assert.equal(c.MEMBERSHIP_TRANSITIONS.some((t) => t.from === 'removed' && t.event === 'restore' && t.to === 'active'), true)
})

test('published exact matrix matches the executable constants', () => {
  assert.equal(readFileSync(outputPath, 'utf8'), renderMatrix())
})

test('operation inventory covers every current page route', () => {
  // The in-memory mock client was deleted with Task 7, so the inventory's operation rows are now
  // a record of what each screen used to call and where it went. The page routes are still live.
  const root = new URL('../../../', import.meta.url)
  const inventory = readFileSync(new URL('docs/auth/OPERATION_COVERAGE.md', root), 'utf8')
  const files = readdirSync(new URL('apps/web/src/routes/', root), { recursive: true })
  for (const file of files.filter((f) => f.endsWith('.tsx') && f !== '__root.tsx')) {
    const route = file === '_app.tsx' ? '/_app' : '/' + file.replace(/^_app\//, '').replace(/(?:^|\/)index\.tsx$/, '').replace(/\.tsx$/, '').replace(/\$(\w+)/g, ':$1').replace(/\/$/, '')
    assert.equal(inventory.includes('`' + route + '`'), true, `unmapped page ${route}`)
  }
})

test('every named safe response family in the coverage inventory has an exported schema', () => {
  const inventory = readFileSync(new URL('../../../docs/auth/OPERATION_COVERAGE.md', import.meta.url), 'utf8')
  for (const line of inventory.split('\n').filter((s) => s.startsWith('|'))) {
    const cell = line.split('|')[3] ?? ''
    for (const [, name] of cell.matchAll(/`([A-Z][A-Za-z]+)`/g)) {
      assert.equal(typeof c[name]?.safeParse, 'function', `missing response schema ${name}`)
    }
  }
})

test('the lifecycle actions are granted exactly to the roles that may take them', () => {
  const scopesOf = (role, permission) => c.ROLE_TEMPLATES[role].grants
    .filter((g) => g.permission === permission).map((g) => g.scope)
  assert.deepEqual(scopesOf('owner', 'audit.redact_notes'), ['school'])
  for (const role of ['principal', 'admin', 'accountant', 'teacher', 'parent', 'student']) {
    assert.deepEqual(scopesOf(role, 'audit.redact_notes'), [], role)
  }
  for (const permission of ['students.anonymise', 'staff.anonymise']) {
    for (const role of ['owner', 'principal']) assert.deepEqual(scopesOf(role, permission), ['school'], role)
    for (const role of ['admin', 'accountant', 'teacher', 'parent']) assert.deepEqual(scopesOf(role, permission), [], role)
  }
  for (const permission of ['students.read_consents', 'students.manage_consents']) {
    for (const role of ['owner', 'principal', 'admin']) assert.deepEqual(scopesOf(role, permission), ['school'], role)
    assert.deepEqual(scopesOf('parent', permission), ['own_children'])
    for (const role of ['accountant', 'teacher', 'student']) assert.deepEqual(scopesOf(role, permission), [], role)
  }
})

test('lifecycle routes name an active permission and stay under a school path', () => {
  for (const [key, route] of Object.entries(c.LIFECYCLE_ENDPOINTS)) {
    assert.equal(c.PERMISSION_CATALOGUE[route.permission].availability, 'active', key)
    assert.equal(route.auth, 'membership', key)
    assert.equal(route.path.startsWith('/api/schools/:schoolId/'), true, key)
  }
  assert.equal(c.LIFECYCLE_ENDPOINTS.revealApaar.permission, 'students.read_sensitive')
  assert.equal(c.LIFECYCLE_ENDPOINTS.unlinkGuardian.permission, 'students.manage_guardians')
})
