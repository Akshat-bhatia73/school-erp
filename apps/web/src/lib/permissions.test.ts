import { describe, expect, it } from 'vitest'
import {
  allows,
  assignableRolesFor,
  audienceFor,
  audiencesFor,
  canManageTarget,
  describePermission,
  diffRoleChange,
  permissionsForRoles,
  roleLabel,
} from '@/lib/permissions'

describe('allows', () => {
  it('reads the actions the server listed on a record', () => {
    expect(allows(['students.update_basic'], 'students.update_basic')).toBe(true)
    expect(allows(['students.update_basic'], 'students.update_sensitive')).toBe(false)
  })

  it('says no when the server sent no list at all', () => {
    expect(allows(undefined, 'students.update_basic')).toBe(false)
    expect(allows([], 'students.update_basic')).toBe(false)
  })
})

describe('roleLabel', () => {
  it('uses the template display name', () => {
    expect(roleLabel('principal')).toBe('Principal')
    expect(roleLabel('admin')).toBe('Administrator')
  })
})

describe('assignableRolesFor', () => {
  it('lets an owner hand out the five delegated roles', () => {
    expect(assignableRolesFor(['owner']).sort()).toEqual(['accountant', 'admin', 'parent', 'principal', 'teacher'])
  })

  it('lets a principal hand out only teacher', () => {
    expect(assignableRolesFor(['principal'])).toEqual(['teacher'])
  })

  it('never offers owner or student, and ignores a role it does not know', () => {
    expect(assignableRolesFor(['owner'])).not.toContain('owner')
    expect(assignableRolesFor(['owner'])).not.toContain('student')
    expect(assignableRolesFor(['not-a-role'])).toEqual([])
  })

  it('unions the roles of somebody who holds two', () => {
    expect(assignableRolesFor(['accountant', 'principal'])).toEqual(['teacher'])
  })
})

describe('canManageTarget', () => {
  it('lets an owner manage a principal', () => {
    expect(canManageTarget(['owner'], ['principal'])).toBe(true)
  })

  it('lets a principal manage a teacher', () => {
    expect(canManageTarget(['principal'], ['teacher'])).toBe(true)
  })

  it('refuses a principal a teacher who is also an owner', () => {
    expect(canManageTarget(['principal'], ['teacher', 'owner'])).toBe(false)
  })

  it('refuses an accountant anybody, and refuses a target with no roles', () => {
    expect(canManageTarget(['accountant'], ['teacher'])).toBe(false)
    expect(canManageTarget(['owner'], [])).toBe(false)
  })
})

describe('permissionsForRoles', () => {
  it('unions what each role grants', () => {
    const teacher = permissionsForRoles(['teacher'])
    expect(teacher.has('timetable.read')).toBe(true)
    expect(teacher.has('members.read')).toBe(false)
    expect(permissionsForRoles(['teacher', 'admin']).has('members.read')).toBe(true)
  })

  it('ignores an unknown role', () => {
    expect(permissionsForRoles(['not-a-role']).size).toBe(0)
  })
})

describe('diffRoleChange', () => {
  it('lists what a teacher gains on becoming an administrator', () => {
    const { added, removed } = diffRoleChange(['teacher'], ['admin'])
    expect(added).toContain('members.read')
    expect(removed).toEqual([])
    expect([...added]).toEqual([...added].sort())
  })

  it('lists what an administrator loses on becoming a teacher', () => {
    const { added, removed } = diffRoleChange(['admin'], ['teacher'])
    expect(removed).toContain('members.read')
    expect(added).toEqual([])
  })

  it('says nothing changed when the roles are the same', () => {
    expect(diffRoleChange(['teacher'], ['teacher'])).toEqual({ added: [], removed: [] })
  })
})

describe('audienceFor', () => {
  it('puts owner, principal and admin in the office', () => {
    expect(audienceFor(['owner'])).toBe('office')
    expect(audienceFor(['principal'])).toBe('office')
    expect(audienceFor(['admin'])).toBe('office')
  })

  it('falls through office, accountant, teacher, parent', () => {
    expect(audienceFor(['parent', 'teacher'])).toBe('teacher')
    expect(audienceFor(['teacher', 'admin'])).toBe('office')
    expect(audienceFor(['accountant', 'parent'])).toBe('accountant')
    expect(audienceFor(['parent', 'accountant', 'teacher'])).toBe('accountant')
  })

  it('lists every view the roles earn, in the same order', () => {
    expect(audiencesFor(['parent', 'teacher'])).toEqual(['teacher', 'parent'])
    expect(audiencesFor(['accountant', 'parent'])).toEqual(['accountant', 'parent'])
    expect(audiencesFor(['owner', 'teacher'])).toEqual(['office', 'teacher'])
    expect(audiencesFor(['principal'])).toEqual(['office'])
    expect(audiencesFor(['student'])).toEqual(['student'])
  })

  it('has nothing to show a role with no dashboard', () => {
    expect(audienceFor([])).toBe('none')
  })

  it('gives a pupil their own home', () => {
    expect(audienceFor(['student'])).toBe('student')
  })
})

describe('describePermission', () => {
  it('prefers the catalogue description', () => {
    expect(describePermission('students.read_basic')).toBe(
      'Read the safe basic student record and authorized roster/search results.',
    )
  })

  it('reads as a sentence for every active permission', () => {
    expect(describePermission('timetable.read').length).toBeGreaterThan(0)
    expect(describePermission('ownership.transfer')).toMatch(/^[A-Z]/)
  })
})
