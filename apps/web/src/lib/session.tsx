/**
 * Session = which school we are looking at + which user we are "viewing as".
 * Auth is skipped for now. The header has a switcher for both so RBAC can be checked per role.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { can, resolvePermission, type Action, type Module, type Role, type Scope, type School, type User } from '@erp/shared'
import { api, setApiContext } from '@/api/client'
import { getStore } from '@/api/store'

interface Session {
  school: School
  schools: School[]
  user: User
  users: User[]
  roles: Role[]
  setSchoolId: (id: string) => void
  setUserId: (id: string) => void
  can: (module: Module, action?: Action) => boolean
  scope: (module: Module, action?: Action) => Scope
  isReady: boolean
}

const SessionContext = createContext<Session | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const store = getStore()
  const [schoolId, setSchoolIdState] = useState(() => localStorage.getItem('erp.schoolId') || store.schools[0]!.id)
  const [userId, setUserIdState] = useState(() => {
    const saved = localStorage.getItem('erp.userId')
    const schoolUsers = store.users.filter((u) => u.schoolId === (localStorage.getItem('erp.schoolId') || store.schools[0]!.id))
    return saved && schoolUsers.some((u) => u.id === saved) ? saved : schoolUsers[0]!.id
  })
  const qc = useQueryClient()

  // Keep the API context in sync before any query runs
  setApiContext({ schoolId, userId })
  useEffect(() => {
    setApiContext({ schoolId, userId })
    localStorage.setItem('erp.schoolId', schoolId)
    localStorage.setItem('erp.userId', userId)
    qc.invalidateQueries()
  }, [schoolId, userId, qc])

  const { data: schools = store.schools } = useQuery({ queryKey: ['schools'], queryFn: () => api.schools.list() })

  const value = useMemo<Session>(() => {
    const school = store.schools.find((s) => s.id === schoolId) ?? store.schools[0]!
    const users = store.users.filter((u) => u.schoolId === school.id)
    const user = users.find((u) => u.id === userId) ?? users[0]!
    const roles = store.roles.filter((r) => user.roleIds.includes(r.id))
    return {
      school, schools, user, users, roles, isReady: true,
      setSchoolId: (id) => {
        setSchoolIdState(id)
        const first = store.users.find((u) => u.schoolId === id)
        if (first) setUserIdState(first.id)
      },
      setUserId: setUserIdState,
      can: (module, action = 'view') => can(roles, module, action),
      scope: (module, action = 'view') => resolvePermission(roles, module, action),
    }
  }, [schoolId, userId, schools, store])

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside SessionProvider')
  return ctx
}
