import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PermissionKey } from '@erp/contracts'
import { renderWithSession } from '@/test/session'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => vi.fn(), Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a> }
})

const restrictions = vi.hoisted(() => vi.fn())
const addRestriction = vi.hoisted(() => vi.fn())
const liftRestriction = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({
  api: {
    members: {
      list: vi.fn(), changeRoles: vi.fn(), suspend: vi.fn(), remove: vi.fn(), restore: vi.fn(),
      startRecovery: vi.fn(), accessExplanation: vi.fn(), restrictions, addRestriction, liftRestriction,
    },
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

const RULE = {
  id: 'restriction-1',
  permission: 'students.read_medical' as const,
  reason: 'Not needed for timetable work',
  startsAt: '2026-09-01T04:30:00.000Z',
  expiresAt: '2027-03-31T18:29:59.999Z',
  createdBy: { membershipId: 'membership-1', displayName: 'Asha Rao' },
  createdAt: '2026-09-01T04:30:00.000Z',
  version: 3,
}

const OWNER: { capabilities: PermissionKey[]; roleKeys: string[] } = { capabilities: ['members.read', 'access.manage'], roleKeys: ['owner'] }

async function openRestrictions(options = OWNER, member = MEMBER) {
  const { MemberSheet } = await import('@/components/settings/member-sheet')
  const rendered = renderWithSession(<MemberSheet member={member} onOpenChange={() => {}} onUpdated={() => {}} />, options)
  const user = userEvent.setup()
  const tab = screen.queryByRole('tab', { name: 'Restrictions' })
  if (tab) await user.click(tab)
  return { ...rendered, user }
}

describe('Member restrictions', () => {
  beforeEach(() => {
    restrictions.mockReset()
    addRestriction.mockReset()
    liftRestriction.mockReset()
  })

  it('is absent without access.manage', async () => {
    restrictions.mockResolvedValue({ items: [RULE], allowedActions: ['access.manage'] })
    await openRestrictions({ capabilities: ['members.read'], roleKeys: ['principal'] })
    expect(screen.queryByRole('tab', { name: 'Restrictions' })).not.toBeInTheDocument()
    expect(restrictions).not.toHaveBeenCalled()
  })

  it('is absent on the signed-in person themselves', async () => {
    await openRestrictions(OWNER, { ...MEMBER, id: 'membership-1' })
    expect(screen.queryByRole('tab', { name: 'Restrictions' })).not.toBeInTheDocument()
  })

  it('lists each restriction with its label, end date, who added it and the reason', async () => {
    restrictions.mockResolvedValue({
      items: [RULE, { ...RULE, id: 'restriction-2', permission: 'students.read_sensitive', expiresAt: null }],
      allowedActions: ['access.manage'],
    })
    await openRestrictions()
    expect(await screen.findByText('Medical information')).toBeInTheDocument()
    expect(restrictions).toHaveBeenCalledWith(SCHOOL_ID, 'membership-2')
    expect(screen.getByText('Sensitive details (Aadhaar, APAAR)')).toBeInTheDocument()
    expect(screen.getByText(/Until 31 Mar 2027/)).toBeInTheDocument()
    expect(screen.getByText(/Until lifted/)).toBeInTheDocument()
    expect(screen.getAllByText(/Added by Asha Rao/)).toHaveLength(2)
    expect(screen.getAllByText('Not needed for timetable work')).toHaveLength(2)
    expect(screen.getByText('Hide these details from this person everywhere in the school, whatever their roles allow.')).toBeInTheDocument()
  })

  it('adds a restriction with the permission, reason, end of day in India and the access version', async () => {
    restrictions.mockResolvedValue({ items: [RULE], allowedActions: ['access.manage'] })
    addRestriction.mockResolvedValue({ ...RULE, id: 'restriction-9', permission: 'students.read_guardians' })
    const { user, queryClient } = await openRestrictions()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    await user.click(await screen.findByRole('button', { name: /Add restriction/ }))
    expect(screen.queryByRole('radio', { name: 'Medical information' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Full guardian records (PAN, Aadhaar, office address)' }))
    await user.type(screen.getByLabelText('Reason'), 'Front desk only')
    await user.type(screen.getByLabelText('End date'), '2099-03-31')
    await user.click(screen.getByRole('button', { name: 'Restrict access' }))

    await waitFor(() => expect(addRestriction).toHaveBeenCalled())
    expect(addRestriction).toHaveBeenCalledWith(SCHOOL_ID, 'membership-2', {
      permission: 'students.read_guardians',
      reason: 'Front desk only',
      expiresAt: '2099-03-31T18:29:59.999Z',
      expectedAccessVersion: 4,
    })
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: [SCHOOL_ID, 'members'] }))
  })

  it('leaves the end date out when none is chosen', async () => {
    restrictions.mockResolvedValue({ items: [], allowedActions: ['access.manage'] })
    addRestriction.mockResolvedValue(RULE)
    const { user } = await openRestrictions()

    await user.click(await screen.findByRole('button', { name: /Add restriction/ }))
    await user.type(screen.getByLabelText('Reason'), 'Admissions only')
    await user.click(screen.getByRole('button', { name: 'Restrict access' }))

    await waitFor(() => expect(addRestriction).toHaveBeenCalled())
    expect(addRestriction.mock.calls[0]?.[2]).toEqual({
      permission: 'students.read_sensitive', reason: 'Admissions only', expectedAccessVersion: 4,
    })
  })

  it('shows the plain sentence when the reason is too short and sends nothing', async () => {
    restrictions.mockResolvedValue({ items: [], allowedActions: ['access.manage'] })
    const { user } = await openRestrictions()

    await user.click(await screen.findByRole('button', { name: /Add restriction/ }))
    await user.type(screen.getByLabelText('Reason'), 'no')
    await user.click(screen.getByRole('button', { name: 'Restrict access' }))

    expect(await screen.findByText('Enter at least 3 characters for the reason')).toBeInTheDocument()
    expect(addRestriction).not.toHaveBeenCalled()
  })

  it('refuses an end date in the past', async () => {
    restrictions.mockResolvedValue({ items: [], allowedActions: ['access.manage'] })
    const { user } = await openRestrictions()

    await user.click(await screen.findByRole('button', { name: /Add restriction/ }))
    await user.type(screen.getByLabelText('Reason'), 'Admissions only')
    await user.type(screen.getByLabelText('End date'), '2020-01-01')
    await user.click(screen.getByRole('button', { name: 'Restrict access' }))

    expect(await screen.findByText('Choose today or a later date')).toBeInTheDocument()
    expect(addRestriction).not.toHaveBeenCalled()
  })

  it('lifts a restriction with its version and a reason', async () => {
    restrictions.mockResolvedValue({ items: [RULE], allowedActions: ['access.manage'] })
    liftRestriction.mockResolvedValue({ status: 'lifted' })
    const { user, queryClient } = await openRestrictions()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    await user.click(await screen.findByRole('button', { name: 'Lift Medical information' }))
    await user.type(screen.getByLabelText('Why are you lifting it?'), 'Now runs the medical room')
    await user.click(screen.getByRole('button', { name: 'Lift restriction' }))

    await waitFor(() => expect(liftRestriction).toHaveBeenCalledWith(SCHOOL_ID, 'membership-2', 'restriction-1', {
      expectedVersion: 3, reason: 'Now runs the medical room',
    }))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: [SCHOOL_ID, 'members'] }))
  })

  it('says the access changed when the server reports a version clash', async () => {
    restrictions.mockResolvedValue({ items: [RULE], allowedActions: ['access.manage'] })
    const { ApiRequestError } = await import('@/lib/http')
    liftRestriction.mockRejectedValue(new ApiRequestError({ code: 'VERSION_CONFLICT', status: 409, message: 'conflict' }))
    const { user } = await openRestrictions()

    await user.click(await screen.findByRole('button', { name: 'Lift Medical information' }))
    await user.type(screen.getByLabelText('Why are you lifting it?'), 'Now runs the medical room')
    await user.click(screen.getByRole('button', { name: 'Lift restriction' }))

    expect(await screen.findByText(/access changed while you were working/, { selector: '[role="alert"]' })).toBeInTheDocument()
  })

  it('is read-only when the list does not allow access.manage', async () => {
    restrictions.mockResolvedValue({ items: [RULE], allowedActions: [] })
    await openRestrictions()
    expect(await screen.findByText('Medical information')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add restriction/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Lift/ })).not.toBeInTheDocument()
  })
})
