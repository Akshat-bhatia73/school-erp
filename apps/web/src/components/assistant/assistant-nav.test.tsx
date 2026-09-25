import type { ReactNode } from 'react'
import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithSession } from '@/test/session'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, to, 'aria-label': label }: { children: ReactNode; to: string; 'aria-label'?: string }) => <a href={to} aria-label={label}>{children}</a>,
    useNavigate: () => vi.fn(),
    useRouterState: () => '/dashboard',
  }
})

vi.mock('@/lib/api', () => ({
  api: {
    dashboard: { get: async () => ({ audience: 'office' }) },
    students: { count: async () => ({ count: 0 }) },
    staff: { count: async () => ({ count: 0 }) },
    search: { run: async () => ({ students: [], staff: [] }) },
    messages: { unread: async () => ({ unread: 0 }) },
    setup: { academicYears: async () => [], sections: async () => [] },
  },
}))

// cmdk scrolls the active item into view; jsdom has no such method.
Element.prototype.scrollIntoView = vi.fn()

beforeEach(() => window.localStorage.clear())

describe('the Assistant entry', () => {
  it('is in the sidebar for somebody who may use the assistant, pupils included', async () => {
    const { Sidebar } = await import('@/components/layout/sidebar')
    const { unmount } = renderWithSession(<Sidebar onOpenQuickActions={() => {}} />, { roleKeys: ['teacher'], capabilities: ['ai_assistant.use'] })
    expect(screen.getByText('Assistant').closest('a')).toHaveAttribute('href', '/assistant')
    unmount()

    renderWithSession(<Sidebar onOpenQuickActions={() => {}} />, { roleKeys: ['student'], capabilities: ['dashboard.read', 'ai_assistant.use'] })
    expect(screen.getByText('Assistant')).toBeInTheDocument()
  })

  it('is hidden everywhere without ai_assistant.use', async () => {
    const { Sidebar } = await import('@/components/layout/sidebar')
    const { CommandMenu } = await import('@/components/layout/command-menu')
    const { MobileTopBar } = await import('@/components/layout/mobile-nav')
    const access = { roleKeys: ['owner'], capabilities: ['students.read_basic', 'communication.read'] as const }

    const sidebar = renderWithSession(<Sidebar onOpenQuickActions={() => {}} />, { ...access, capabilities: [...access.capabilities] })
    expect(screen.getByText('Messages')).toBeInTheDocument()
    expect(screen.queryByText('Assistant')).not.toBeInTheDocument()
    expect(screen.queryByText('Coming next')).not.toBeInTheDocument()
    sidebar.unmount()

    const top = renderWithSession(<MobileTopBar onOpenNav={() => {}} onOpenQuickActions={() => {}} />, { ...access, capabilities: [...access.capabilities] })
    expect(screen.queryByRole('link', { name: 'Assistant' })).not.toBeInTheDocument()
    top.unmount()

    renderWithSession(<CommandMenu open onOpenChange={() => {}} />, { ...access, capabilities: [...access.capabilities] })
    expect(screen.getByRole('option', { name: 'Messages' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Assistant' })).not.toBeInTheDocument()
  })

  it('is in the quick menu and the mobile top bar when allowed', async () => {
    const { CommandMenu } = await import('@/components/layout/command-menu')
    const { MobileTopBar } = await import('@/components/layout/mobile-nav')
    const top = renderWithSession(<MobileTopBar onOpenNav={() => {}} onOpenQuickActions={() => {}} />, { roleKeys: ['parent'], capabilities: ['ai_assistant.use'] })
    expect(screen.getByRole('link', { name: 'Assistant' })).toHaveAttribute('href', '/assistant')
    top.unmount()

    renderWithSession(<CommandMenu open onOpenChange={() => {}} />, { roleKeys: ['parent'], capabilities: ['ai_assistant.use'] })
    expect(screen.getByRole('option', { name: 'Assistant' })).toBeInTheDocument()
  })
})
