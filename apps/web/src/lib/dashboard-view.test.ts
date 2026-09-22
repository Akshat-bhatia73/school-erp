/**
 * The dashboard view preference: per user, per browser, seeded by the login tab, and never able
 * to name a view the person's roles do not earn.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { readDashboardView, rememberLoginSeed, resolveDashboardView, writeDashboardView } from '@/lib/dashboard-view'

beforeEach(() => {
  window.localStorage.clear()
})

describe('the stored view', () => {
  it('is remembered per user and read back', () => {
    writeDashboardView('user-1', 'parent')
    expect(readDashboardView('user-1')).toBe('parent')
    expect(readDashboardView('user-2')).toBeNull()
  })

  it('ignores a value that is not a view', () => {
    window.localStorage.setItem('erp.dashboardView.user-1', 'owner')
    expect(readDashboardView('user-1')).toBeNull()
  })
})

describe('the login seed', () => {
  it('lands a parent-tab sign-in on the parent home', () => {
    rememberLoginSeed('parent')
    expect(readDashboardView('user-1')).toBe('parent')
    // Consumed once: the next person on this browser is not seeded by it.
    expect(readDashboardView('user-2')).toBeNull()
  })

  it('clears a stored parent view when the person comes back through a staff tab', () => {
    writeDashboardView('user-1', 'parent')
    rememberLoginSeed('staff')
    expect(readDashboardView('user-1')).toBeNull()
  })
})

describe('resolveDashboardView', () => {
  it('uses the stored view when the roles earn it and sends it to the server', () => {
    expect(resolveDashboardView(['teacher', 'parent'], 'parent')).toEqual({ view: 'parent', preferred: 'parent', options: ['teacher', 'parent'] })
  })

  it('drops a stored view the roles do not earn and sends nothing', () => {
    expect(resolveDashboardView(['teacher'], 'office')).toEqual({ view: 'teacher', preferred: null, options: ['teacher'] })
  })

  it('falls back to the default order when nothing is stored', () => {
    expect(resolveDashboardView(['accountant', 'parent'], null)).toEqual({ view: 'accountant', preferred: null, options: ['accountant', 'parent'] })
    expect(resolveDashboardView(['student'], null)).toEqual({ view: 'none', preferred: null, options: [] })
  })
})
