import { z } from 'zod'
import { Id, IndianPhone, TenantRecord } from './common'

/** Modules the permission system knows about. Phase 2+ modules included so the matrix is complete. */
export const Module = z.enum([
  'school_setup',
  'students',
  'staff',
  'student_attendance',
  'staff_attendance',
  'timetable',
  'fee_structure',
  'fee_collection',
  'fee_reports',
  'exams',
  'report_cards',
  'communication',
  'ai_assistant',
  'users_roles',
  'audit_log',
])
export type Module = z.infer<typeof Module>

export const Action = z.enum(['view', 'create', 'edit', 'delete', 'approve', 'export'])
export type Action = z.infer<typeof Action>

/** How far a permission reaches */
export const Scope = z.enum([
  'all', // whole school
  'own_classes', // sections the user teaches / is class teacher of
  'own_children', // parent
  'self', // own profile / own records
  'none',
])
export type Scope = z.infer<typeof Scope>

export const Permission = z.object({
  module: Module,
  actions: z.array(Action),
  scope: Scope,
})
export type Permission = z.infer<typeof Permission>

export const RoleKey = z.enum(['owner', 'admin', 'accountant', 'teacher', 'parent', 'student', 'custom'])
export type RoleKey = z.infer<typeof RoleKey>

export const Role = TenantRecord.extend({
  key: RoleKey,
  name: z.string(), // "Owner / Principal"
  description: z.string().optional(),
  isSystem: z.boolean(), // system roles cannot be deleted
  permissions: z.array(Permission),
})
export type Role = z.infer<typeof Role>

export const UserStatus = z.enum(['active', 'invited', 'disabled'])
export type UserStatus = z.infer<typeof UserStatus>

/** A login. Linked to a staff member or a guardian. */
export const User = TenantRecord.extend({
  name: z.string(),
  phone: IndianPhone,
  email: z.string().email().optional(),
  avatarUrl: z.string().optional(),
  roleIds: z.array(Id).min(1),
  staffId: Id.optional(),
  guardianId: Id.optional(),
  status: UserStatus,
  lastActiveAt: z.string().optional(),
})
export type User = z.infer<typeof User>

export const UserInput = User.omit({ id: true, createdAt: true, updatedAt: true, schoolId: true, lastActiveAt: true })
export type UserInput = z.infer<typeof UserInput>

export const RoleInput = Role.omit({ id: true, createdAt: true, updatedAt: true, schoolId: true, isSystem: true })
export type RoleInput = z.infer<typeof RoleInput>

/** Helper: does this set of roles allow an action on a module? Returns the widest scope granted. */
export function resolvePermission(roles: Role[], module: Module, action: Action): Scope {
  const order: Scope[] = ['none', 'self', 'own_children', 'own_classes', 'all']
  let best: Scope = 'none'
  for (const role of roles) {
    for (const p of role.permissions) {
      if (p.module === module && p.actions.includes(action)) {
        if (order.indexOf(p.scope) > order.indexOf(best)) best = p.scope
      }
    }
  }
  return best
}

export function can(roles: Role[], module: Module, action: Action): boolean {
  return resolvePermission(roles, module, action) !== 'none'
}
