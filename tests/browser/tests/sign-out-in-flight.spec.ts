/**
 * Signing out while a roster request is still open. The answer belongs to the
 * identity that asked for it and must never reach the next one's screen, and
 * the sign-in page it lands on must carry no school data at all.
 */
import { expect, test } from '@playwright/test'
import {
  STUDENT_LIST_GLOB,
  holdOnce,
  openRoster,
  signIn,
  signInToSchool,
  signOut,
  watchForText,
} from '../support/app.ts'
import { STUDENT_ALPHA, STUDENT_BETA, teacherAlpha, teacherBeta } from '../setup/people.ts'

test('a roster answered after sign-out never paints into the next session', async ({ page }) => {
  await signInToSchool(page, teacherAlpha)
  await openRoster(page)
  await expect(page.getByText(STUDENT_ALPHA.name).filter({ visible: true }).first()).toBeVisible()

  // Ask for the roster again and hold the answer open, then leave.
  const held = holdOnce(page, STUDENT_LIST_GLOB, 6_000)
  const started = page.waitForRequest(STUDENT_LIST_GLOB)
  await page.reload()
  await started

  const watch = await watchForText(page, STUDENT_ALPHA.name)
  await signOut(page)
  await expect(page).toHaveURL(/\/login/, { timeout: 20_000 })

  // Nothing of the school survives on the public page.
  await expect(page.getByText(STUDENT_ALPHA.name)).toHaveCount(0)
  await expect(page.getByText(STUDENT_BETA.name)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Account menu for/ })).toHaveCount(0)

  await signIn(page, teacherBeta)
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 })
  await openRoster(page)
  await expect(page.getByText(STUDENT_BETA.name).filter({ visible: true }).first()).toBeVisible()

  // Let the first teacher's answer land, then look again.
  await held
  await page.waitForTimeout(1_000)
  expect(await watch.stop(), "the first teacher's pupil appeared in the second teacher's session").toBe(false)
  await expect(page.getByText(STUDENT_ALPHA.name)).toHaveCount(0)
})
