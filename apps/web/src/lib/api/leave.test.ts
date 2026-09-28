/** The leave client builds the paths and bodies the leave routes expect, and nothing else. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const http = vi.hoisted(() => ({ request: vi.fn(), ApiRequestError: class extends Error {} }))
vi.mock('@/lib/http', () => http)

const { api } = await import('./index')

const SCHOOL = 'school-1'
const PREFIX = '/api/schools/school-1'

function lastCall() {
  const call = http.request.mock.calls.at(-1)
  if (!call) throw new Error('request() was never called')
  return { path: call[0] as string, options: (call[1] ?? {}) as Record<string, unknown> }
}

describe('leave paths', () => {
  beforeEach(() => {
    http.request.mockReset()
    http.request.mockResolvedValue(undefined)
  })

  it('lists, records and cancels pupil leave under attendance', async () => {
    await api.leave.listStudents(SCHOOL, { from: '2026-09-01', includeCancelled: 'true' })
    expect(lastCall().path).toBe(`${PREFIX}/attendance/leave?from=2026-09-01&includeCancelled=true`)
    await api.leave.createStudent(SCHOOL, { studentId: 's1', startsOn: '2026-09-28', endsOn: '2026-09-28' })
    expect(lastCall().path).toBe(`${PREFIX}/attendance/leave`)
    expect(lastCall().options.method).toBe('POST')
    await api.leave.cancelStudent(SCHOOL, 'l 1', { expectedVersion: 2 })
    expect(lastCall().path).toBe(`${PREFIX}/attendance/leave/l%201/cancel`)
    expect(lastCall().options.body).toEqual({ expectedVersion: 2 })
  })

  it('lists, records and cancels staff leave under staff attendance', async () => {
    await api.leave.listStaff(SCHOOL)
    expect(lastCall().path).toBe(`${PREFIX}/staff-attendance/leave`)
    await api.leave.createStaff(SCHOOL, { staffId: 'f1', startsOn: '2026-09-28', endsOn: '2026-09-29', reason: 'Wedding' })
    expect(lastCall().options.body).toEqual({ staffId: 'f1', startsOn: '2026-09-28', endsOn: '2026-09-29', reason: 'Wedding' })
    await api.leave.cancelStaff(SCHOOL, 'l2', { expectedVersion: 1, reason: 'Back early' })
    expect(lastCall().path).toBe(`${PREFIX}/staff-attendance/leave/l2/cancel`)
  })

  it('lists, applies, decides and withdraws pupil leave applications', async () => {
    await api.leave.applications.pupils.list(SCHOOL, { status: 'pending' })
    expect(lastCall().path).toBe(`${PREFIX}/leave-applications/pupils?status=pending`)
    await api.leave.applications.pupils.apply(SCHOOL, { studentId: 's1', startsOn: '2026-09-28', endsOn: '2026-09-29', reason: 'Fever' })
    expect(lastCall().path).toBe(`${PREFIX}/leave-applications/pupils`)
    expect(lastCall().options.method).toBe('POST')
    await api.leave.applications.pupils.decide(SCHOOL, 'a 1', { expectedVersion: 2, decision: 'refuse', note: 'Exams that week' })
    expect(lastCall().path).toBe(`${PREFIX}/leave-applications/pupils/a%201/decide`)
    expect(lastCall().options.body).toEqual({ expectedVersion: 2, decision: 'refuse', note: 'Exams that week' })
    await api.leave.applications.pupils.withdraw(SCHOOL, 'a1', { expectedVersion: 3 })
    expect(lastCall().path).toBe(`${PREFIX}/leave-applications/pupils/a1/withdraw`)
  })

  it('lists, applies, decides and withdraws staff leave applications', async () => {
    await api.leave.applications.staff.list(SCHOOL, { mine: 'true' })
    expect(lastCall().path).toBe(`${PREFIX}/leave-applications/staff?mine=true`)
    await api.leave.applications.staff.apply(SCHOOL, { leaveType: 'sick', startsOn: '2026-09-28', endsOn: '2026-09-28', reason: 'Fever' })
    expect(lastCall().options.body).toEqual({ leaveType: 'sick', startsOn: '2026-09-28', endsOn: '2026-09-28', reason: 'Fever' })
    await api.leave.applications.staff.decide(SCHOOL, 'b1', { expectedVersion: 1, decision: 'approve' })
    expect(lastCall().path).toBe(`${PREFIX}/leave-applications/staff/b1/decide`)
    await api.leave.applications.staff.withdraw(SCHOOL, 'b1', { expectedVersion: 1 })
    expect(lastCall().path).toBe(`${PREFIX}/leave-applications/staff/b1/withdraw`)
  })
})
