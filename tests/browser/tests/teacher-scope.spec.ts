/**
 * Signed out means signed out, and a teacher's roster is the sections they
 * teach — including when the address bar names a pupil from another section.
 */
import { expect, test } from '@playwright/test'
import { openRoster, signInToSchool } from '../support/app.ts'
import { STUDENT_ALPHA, STUDENT_BETA, teacherAlpha } from '../setup/people.ts'

test('a signed-out visit to the roster lands on sign-in, and a teacher sees only their sections', async ({ page }) => {
  await page.goto('/students')
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByLabel('Email address')).toBeVisible()
  // The address that was asked for is remembered, but nothing behind it leaked.
  await expect(page.getByText(STUDENT_ALPHA.name)).toHaveCount(0)
  await expect(page.getByText(STUDENT_BETA.name)).toHaveCount(0)

  await signInToSchool(page, teacherAlpha)
  await openRoster(page)

  await expect(page.getByText(STUDENT_ALPHA.name).filter({ visible: true }).first()).toBeVisible()
  await expect(page.getByText(STUDENT_BETA.name)).toHaveCount(0)
  // A teacher holds no write permission, so the control is not rendered at all.
  await expect(page.getByRole('button', { name: 'Admit student' })).toHaveCount(0)
})

test('a teacher who types an unrelated pupil\'s address gets the refusal, not the record', async ({ page }) => {
  await signInToSchool(page, teacherAlpha)

  await page.goto(`/students/${STUDENT_BETA.id}`)
  await expect(page.getByText('This student is not available')).toBeVisible()
  await expect(page.getByText(STUDENT_BETA.name)).toHaveCount(0)

  // The pupil they do teach still opens, so this is a boundary and not a wall.
  await page.goto(`/students/${STUDENT_ALPHA.id}`)
  await expect(page.getByText(STUDENT_ALPHA.name).filter({ visible: true }).first()).toBeVisible()
})
