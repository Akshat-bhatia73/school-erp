import type { Staff, UserInput } from '@erp/shared'
import { api } from '@/api/client'

/** Build and create a login for a staff member: teachers get the teacher role, everyone else admin. */
export async function createStaffLogin(staff: Staff) {
  const roles = await api.roles.list()
  const wantedKey = staff.staffType === 'teaching' ? 'teacher' : 'admin'
  const role = roles.find((r) => r.key === wantedKey) ?? roles[0]
  if (!role) throw new Error('No roles are set up yet')
  const input: UserInput = {
    name: [staff.firstName, staff.lastName].filter(Boolean).join(' '),
    phone: staff.phone,
    email: staff.email,
    roleIds: [role.id],
    staffId: staff.id,
    status: 'invited',
  }
  return api.users.create(input)
}
