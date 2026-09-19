/**
 * An export only counts when a file actually lands. The owner picks rows on
 * the roster and gets a spreadsheet, and one student's record gives a
 * document, both through the real API and the real download the browser makes.
 */
import { expect, test } from '@playwright/test'
import { enrolAuthenticator, openRoster, signInWithSecondStep } from '../support/app.ts'
import { closeDb, forgetSecondFactor } from '../support/db.ts'
import { STUDENT_ALPHA, ownerA } from '../setup/people.ts'

test.afterAll(async () => {
  // The owner is shared with the suspension test, which enrols an
  // authenticator of its own, so this one is handed back.
  await forgetSecondFactor(ownerA.userId)
  await closeDb()
})

test('an owner exports the selected roster rows to a spreadsheet and one record to a document', async ({ page, playwright, baseURL }) => {
  const api = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: baseURL ?? '' },
  })
  const secret = await enrolAuthenticator(api, ownerA)
  await api.dispose()
  await signInWithSecondStep(page, ownerA, secret)

  await openRoster(page)
  await expect(page.getByText(STUDENT_ALPHA.name).filter({ visible: true }).first()).toBeVisible()

  // The bulk bar appears only once rows are picked, which is the control the
  // person really uses.
  await page.getByRole('checkbox', { name: 'Select row' }).first().check()
  const toExcel = page.getByRole('button', { name: 'Export to Excel' })
  await expect(toExcel).toBeVisible()

  const spreadsheet = page.waitForEvent('download', { timeout: 30_000 })
  await toExcel.click()
  const workbook = await spreadsheet
  expect(workbook.suggestedFilename()).toMatch(/\.xlsx$/)
  expect(await workbook.failure()).toBeNull()

  // The same person, one record, the other format.
  await page.goto(`/students/${STUDENT_ALPHA.id}`)
  await expect(page.getByText(STUDENT_ALPHA.name).filter({ visible: true }).first()).toBeVisible()

  const document = page.waitForEvent('download', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Export PDF' }).first().click()
  const profile = await document
  expect(profile.suggestedFilename()).toMatch(/\.pdf$/)
  expect(await profile.failure()).toBeNull()
})
