import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithSession } from '@/test/session'

const navigate = vi.fn()
const search = vi.hoisted(() => ({ current: {} as Record<string, string> }))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
    Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
    createFileRoute: () => (options: Record<string, unknown>) => ({ ...options, useSearch: () => search.current }),
  }
})

const membersList = vi.hoisted(() => vi.fn())
const listInvitations = vi.hoisted(() => vi.fn())
const changeRoles = vi.hoisted(() => vi.fn())
const auditList = vi.hoisted(() => vi.fn())
const redactNote = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({
  api: {
    members: { list: membersList, listInvitations, changeRoles, suspend: vi.fn(), remove: vi.fn(), restore: vi.fn(), startRecovery: vi.fn(), accessExplanation: vi.fn(), invite: vi.fn(), resendInvitation: vi.fn(), revokeInvitation: vi.fn() },
    audit: { list: auditList, export: vi.fn(), redactNote },
    staff: { search: vi.fn() },
    files: { exportJob: vi.fn() },
  },
}))

const SCHOOL_ID = '10000000-0000-4000-8000-000000000001'

const MEMBER = {
  id: 'membership-2',
  schoolId: SCHOOL_ID,
  displayName: 'Priya Nair',
  status: 'active' as const,
  roleKeys: ['teacher' as const],
  staffId: 'staff-1',
  accessVersion: 4,
}

const INVITATION = {
  id: 'invitation-1',
  schoolId: SCHOOL_ID,
  displayName: 'Asha Rao',
  maskedDestination: 'a***@example.test',
  roleKeys: ['teacher' as const],
  status: 'pending' as const,
  deliveryStatus: 'sent' as const,
  expiresAt: '2026-03-03T10:00:00.000Z',
  version: 1,
}

function page(invitations: (typeof INVITATION)[] = []) {
  membersList.mockResolvedValue({ items: [MEMBER], total: 1, page: 1, pageSize: 25 })
  listInvitations.mockResolvedValue({ items: invitations, total: invitations.length, page: 1, pageSize: 25 })
}

describe('Users & logins', () => {
  it('shows the members the server sent', async () => {
    page()
    const { Route } = await import('@/routes/_app/settings/users')
    const Page = (Route as unknown as { component: () => ReactNode }).component
    renderWithSession(<Page />, { capabilities: ['members.read'], roleKeys: ['principal'] })
    await waitFor(() => expect(screen.getByText('Priya Nair')).toBeInTheDocument())
    expect(screen.getByText('1 members on this page')).toBeInTheDocument()
  })

  it('does not offer an invite to somebody who cannot invite', async () => {
    page()
    const { Route } = await import('@/routes/_app/settings/users')
    const Page = (Route as unknown as { component: () => ReactNode }).component
    renderWithSession(<Page />, { capabilities: ['members.read'], roleKeys: ['principal'] })
    await waitFor(() => expect(screen.getByText('Priya Nair')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /invite/i })).not.toBeInTheDocument()
  })

  it('shows the school\'s pending invitations to somebody who may invite', async () => {
    page([INVITATION])
    const { Route } = await import('@/routes/_app/settings/users')
    const Page = (Route as unknown as { component: () => ReactNode }).component
    renderWithSession(<Page />, { capabilities: ['members.read', 'members.invite', 'roles.assign'], roleKeys: ['principal'] })
    await waitFor(() => expect(screen.getByText(/Pending invitations/)).toBeInTheDocument())
    expect(screen.getByText('Asha Rao')).toBeInTheDocument()
    expect(screen.getByText('Sent to a***@example.test')).toBeInTheDocument()
    expect(listInvitations).toHaveBeenCalledWith(SCHOOL_ID, { status: 'pending', pageSize: 100 })
  })

  it('does not ask for invitations when the person cannot invite', async () => {
    page([INVITATION])
    const { Route } = await import('@/routes/_app/settings/users')
    const Page = (Route as unknown as { component: () => ReactNode }).component
    renderWithSession(<Page />, { capabilities: ['members.read'], roleKeys: ['principal'] })
    await waitFor(() => expect(screen.getByText('Priya Nair')).toBeInTheDocument())
    expect(listInvitations).not.toHaveBeenCalled()
    expect(screen.queryByText(/Pending invitations/)).not.toBeInTheDocument()
  })

  it('says one sentence when the person cannot read the directory', async () => {
    page()
    const { Route } = await import('@/routes/_app/settings/users')
    const Page = (Route as unknown as { component: () => ReactNode }).component
    renderWithSession(<Page />, { capabilities: [], roleKeys: ['teacher'] })
    expect(screen.getByText('You cannot see the people in this school')).toBeInTheDocument()
    expect(membersList).not.toHaveBeenCalled()
  })
})

describe('Member sheet', () => {
  it('sends the version the person was looking at and clears the members cache', async () => {
    changeRoles.mockResolvedValue({ ...MEMBER, roleKeys: ['admin'], accessVersion: 5 })
    const { MemberSheet } = await import('@/components/settings/member-sheet')
    const { queryClient } = renderWithSession(<MemberSheet member={MEMBER} onOpenChange={() => {}} onUpdated={() => {}} />, {
      capabilities: ['members.read', 'roles.assign'],
      roleKeys: ['owner'],
    })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const user = userEvent.setup()

    await user.click(screen.getByLabelText('Administrator'))
    await user.type(screen.getByLabelText('Why are you changing this?'), 'task 7 check')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(changeRoles).toHaveBeenCalled())
    expect(changeRoles.mock.calls[0]?.[2]).toMatchObject({ expectedVersion: 4, reason: 'task 7 check' })
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: [SCHOOL_ID, 'members'] }))
  })

  it('refuses to show the roles form for the signed-in person', async () => {
    const { MemberSheet } = await import('@/components/settings/member-sheet')
    renderWithSession(<MemberSheet member={{ ...MEMBER, id: 'membership-1' }} onOpenChange={() => {}} onUpdated={() => {}} />, {
      capabilities: ['roles.assign'],
      roleKeys: ['principal'],
      membershipId: 'membership-1',
    })
    expect(screen.getByText('You cannot change your own access.')).toBeInTheDocument()
  })
})

describe('Audit log', () => {
  it('shows entries and hides the export from somebody who cannot export', async () => {
    auditList.mockResolvedValue({
      items: [{ id: 'a1', at: '2026-03-01T10:00:00.000Z', actorDisplayName: 'Asha Rao', action: 'members.suspend', summary: 'Suspended Priya Nair', outcome: 'allowed' }],
      total: 1, page: 1, pageSize: 50,
    })
    const { Route } = await import('@/routes/_app/settings/audit-log')
    const Page = (Route as unknown as { component: () => ReactNode }).component
    renderWithSession(<Page />, { capabilities: ['audit.read'], roleKeys: ['principal'] })
    await waitFor(() => expect(screen.getByText('Suspended Priya Nair')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument()
  })

  it('shows the note under the summary and offers Redact only to somebody who may redact', async () => {
    const entry = {
      id: 'a1', at: '2026-03-01T10:00:00.000Z', actorDisplayName: 'Asha Rao',
      action: 'staff.update_pay', summary: 'Changed the pay of Priya Nair', outcome: 'allowed',
      note: 'Annual increment agreed in the March meeting',
    }
    const { AuditDetailSheet } = await import('@/components/settings/audit-detail-sheet')

    const reader = renderWithSession(
      <AuditDetailSheet entry={entry as never} onOpenChange={() => {}} />,
      { capabilities: ['audit.read'], roleKeys: ['principal'] },
    )
    expect(await screen.findByText('Annual increment agreed in the March meeting')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Redact' })).not.toBeInTheDocument()
    reader.unmount()

    const user = userEvent.setup()
    redactNote.mockResolvedValue(undefined)
    renderWithSession(
      <AuditDetailSheet entry={entry as never} onOpenChange={() => {}} />,
      { capabilities: ['audit.read', 'audit.redact_notes'], roleKeys: ['owner'] },
    )
    await user.click(await screen.findByRole('button', { name: 'Redact' }))
    await user.type(await screen.findByPlaceholderText(/names somebody/i), 'Names an unrelated person')
    await user.click(screen.getByRole('button', { name: 'Redact note' }))

    await waitFor(() => expect(redactNote).toHaveBeenCalledWith(SCHOOL_ID, 'a1', { reason: 'Names an unrelated person' }))
  })
})

describe('Staff login tab', () => {
  it('renders nothing for somebody who cannot read the directory', async () => {
    const { LoginTab } = await import('@/components/staff/login-tab')
    const { container } = renderWithSession(<LoginTab staffId="staff-1" displayName="Priya Nair" />, { capabilities: [], roleKeys: ['teacher'] })
    expect(container).toBeEmptyDOMElement()
    expect(membersList).not.toHaveBeenCalled()
  })

  it('shows the linked login when the directory has one', async () => {
    membersList.mockResolvedValue({ items: [MEMBER], total: 1, page: 1, pageSize: 100 })
    const { LoginTab } = await import('@/components/staff/login-tab')
    renderWithSession(<LoginTab staffId="staff-1" displayName="Priya Nair" />, { capabilities: ['members.read'], roleKeys: ['principal'] })
    await waitFor(() => expect(screen.getByText('Teacher')).toBeInTheDocument())
  })
})
