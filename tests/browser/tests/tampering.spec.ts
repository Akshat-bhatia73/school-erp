/**
 * Values in the browser that look like an identity. `localStorage`,
 * `sessionStorage` and a readable cookie are all writable by anyone sitting at
 * the machine, so none of them may change a role, a school or a control.
 */
import { expect, test } from '@playwright/test'
import { openRoster, signInToSchool } from '../support/app.ts'
import {
  SCHOOL_A_NAME,
  SCHOOL_B,
  SCHOOL_B_NAME,
  STUDENT_ALPHA,
  STUDENT_BETA,
  teacherAlpha,
} from '../setup/people.ts'

test('storage and cookie values that look like an identity change nothing', async ({ page }) => {
  await signInToSchool(page, teacherAlpha)
  await openRoster(page)
  await expect(page.getByText(STUDENT_ALPHA.name).filter({ visible: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Admit student' })).toHaveCount(0)

  await page.evaluate((schoolB) => {
    localStorage.setItem('erp.userId', '10000000-0000-4000-8000-000000000024')
    localStorage.setItem('erp.schoolId', schoolB)
    localStorage.setItem('erp.roles', JSON.stringify(['owner', 'principal']))
    localStorage.setItem('erp.capabilities', JSON.stringify(['students.create', 'members.suspend']))
    sessionStorage.setItem('erp.activeSchoolId', schoolB)
    document.cookie = 'erp.role=owner; path=/'
    document.cookie = 'erp.schoolId=' + schoolB + '; path=/'
  }, SCHOOL_B)

  await page.reload()
  await openRoster(page)

  // Still the same person, in the same school, with the same roster.
  await expect(page.getByText(STUDENT_ALPHA.name).filter({ visible: true }).first()).toBeVisible()
  await expect(page.getByText(STUDENT_BETA.name)).toHaveCount(0)
  await expect(page.getByText(SCHOOL_A_NAME).filter({ visible: true }).first()).toBeVisible()
  await expect(page.getByText(SCHOOL_B_NAME)).toHaveCount(0)

  // Still no write control, and still nothing that needs a privileged role.
  await expect(page.getByRole('button', { name: 'Admit student' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Import' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Users and logins' })).toHaveCount(0)

  // The identity keys of the old mock session are deleted on boot, not honoured.
  const leftovers = await page.evaluate(() => ({
    userId: localStorage.getItem('erp.userId'),
    schoolId: localStorage.getItem('erp.schoolId'),
  }))
  expect(leftovers).toEqual({ userId: null, schoolId: null })

  // The privileged screen says no, and lists nobody: the tampered "roles" and
  // "capabilities" reached neither the screen nor the server.
  await page.goto('/settings/users')
  await expect(page.getByText('You cannot see the people in this school')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Invite' })).toHaveCount(0)
})
