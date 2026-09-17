/**
 * Switching school while a roster request is still open. Same rule as signing
 * out: the answer belongs to the school that asked for it.
 */
import { expect, test } from '@playwright/test'
import {
  STUDENT_LIST_GLOB,
  chooseSchool,
  holdOnce,
  openRoster,
  signIn,
  switchSchool,
  watchForText,
} from '../support/app.ts'
import {
  SCHOOL_A_NAME,
  SCHOOL_B_NAME,
  STUDENT_ALPHA,
  STUDENT_BRAVO,
  teacherDual,
} from '../setup/people.ts'

test('a roster answered after a school switch never paints into the new school', async ({ page }) => {
  await signIn(page, teacherDual)
  // Two memberships, so the server-derived list is offered rather than guessed.
  await expect(page).toHaveURL(/\/select-school/, { timeout: 20_000 })
  await chooseSchool(page, SCHOOL_A_NAME)
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 })

  await openRoster(page)
  await expect(page.getByText(STUDENT_ALPHA.name).filter({ visible: true }).first()).toBeVisible()

  const held = holdOnce(page, STUDENT_LIST_GLOB, 6_000)
  const started = page.waitForRequest(STUDENT_LIST_GLOB)
  await page.reload()
  await started

  const watch = await watchForText(page, STUDENT_ALPHA.name)
  await switchSchool(page)
  await chooseSchool(page, SCHOOL_B_NAME)
  await openRoster(page)
  await expect(page.getByText(STUDENT_BRAVO.name).filter({ visible: true }).first()).toBeVisible()

  await held
  await page.waitForTimeout(1_000)
  expect(await watch.stop(), "school A's pupil appeared in school B's roster").toBe(false)
  await expect(page.getByText(STUDENT_ALPHA.name)).toHaveCount(0)
})
