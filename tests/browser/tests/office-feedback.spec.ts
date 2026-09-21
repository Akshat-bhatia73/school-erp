/**
 * The office feedback work, seen the way the office sees it.
 *
 * Three things a screen either does or does not do: an empty form says what is
 * wrong in plain English and never in the words a schema uses; a student
 * admitted with an Aadhaar number and a guardian's PAN and office address
 * comes back showing only the last digits; and the promotion screen can leave
 * a student out of the whole exercise.
 */
import { expect, test } from '@playwright/test'
import { enrolAuthenticator, signInWithSecondStep } from '../support/app.ts'
import { closeDb, forgetSecondFactor } from '../support/db.ts'
import {
  NEXT_YEAR_NAME,
  PROMOTE_FROM_LABEL,
  PROMOTE_TO_LABEL,
  STUDENT_PROMOTE_TWO,
  ownerA,
} from '../setup/people.ts'

/** A twelve digit number that passes the checksum the form applies. */
const AADHAAR = '999888777669'
const GUARDIAN_AADHAAR = '222222222227'
const PAN = 'ABCDE1234F'
const OFFICE_ADDRESS = 'Unit 4, Market Road, Pune 411001'

/** The wording a rejected form must never show a person. */
const SCHEMA_WORDS = /Invalid input|expected string|Too small|Too big|Unrecognized key/

test.afterAll(async () => {
  await forgetSecondFactor(ownerA.userId)
  await closeDb()
})

test('the office admits a student with an Aadhaar number, a PAN and an office address, and sees only the last digits', async ({ page, playwright, baseURL }) => {
  const api = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: baseURL ?? '' },
  })
  const secret = await enrolAuthenticator(api, ownerA)
  await api.dispose()
  await signInWithSecondStep(page, ownerA, secret)

  await page.goto('/students/new')
  await expect(page.getByLabel('First name')).toBeVisible()

  // An empty form is refused in words a person understands.
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('Enter the first name')).toBeVisible()
  await expect(page.getByText('Choose a gender')).toBeVisible()
  await expect(page.locator('body')).not.toContainText(SCHEMA_WORDS)

  const stamp = String(Date.now()).slice(-6)
  await page.getByLabel('First name').fill('Aadhaar')
  await page.getByLabel('Last name').fill(`Pupil ${stamp}`)
  await page.getByLabel('Date of birth').fill('2016-05-04')
  await page.getByRole('radio', { name: 'Female' }).click()
  await page.getByLabel('Aadhaar number').fill(AADHAAR)
  await page.getByRole('button', { name: 'Next' }).click()

  // Parents and guardians, with the three optional fields this work added.
  await expect(page.getByLabel('PAN')).toBeVisible()
  await page.getByLabel('First name').fill('Parent')
  await page.getByLabel('Phone').fill('9876500011')
  await page.getByLabel('Office address').fill(OFFICE_ADDRESS)
  await page.getByLabel('PAN').fill(PAN)
  await page.getByLabel('Aadhaar number').fill(GUARDIAN_AADHAAR)
  await page.getByRole('button', { name: 'Next' }).click()

  // Consent, then the class.
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByLabel('Class and section').click()
  await page.getByRole('option').first().click()
  await page.getByRole('button', { name: 'Next' }).click()

  await page.getByRole('button', { name: 'Admit student' }).click()
  await expect(page).toHaveURL(/\/students\/[0-9a-f-]{36}/, { timeout: 30_000 })

  // The record shows the last digits and nothing else, for both people.
  await expect(page.getByText(`ending ${AADHAAR.slice(-4)}`)).toBeVisible()
  await page.getByRole('tab', { name: 'Guardians' }).click()
  await expect(page.getByText(`PAN ending ${PAN.slice(-4)}`)).toBeVisible()
  await expect(page.getByText(`Aadhaar ending ${GUARDIAN_AADHAAR.slice(-4)}`)).toBeVisible()
  await expect(page.getByText(`Office: ${OFFICE_ADDRESS}`)).toBeVisible()
  await expect(page.locator('body')).not.toContainText(AADHAAR)
  await expect(page.locator('body')).not.toContainText(GUARDIAN_AADHAAR)
  await expect(page.locator('body')).not.toContainText(PAN)

  // Promotion: one student moves up, the other is left out altogether.
  await page.goto('/students/promote')
  await page.getByRole('button', { name: /To year/ }).click()
  await page.getByRole('menuitem', { name: NEXT_YEAR_NAME }).click()
  await page.getByRole('button', { name: /From section/ }).click()
  await page.getByRole('menuitem', { name: PROMOTE_FROM_LABEL }).click()
  await page.getByRole('button', { name: /To section/ }).click()
  await page.getByRole('menuitem', { name: PROMOTE_TO_LABEL }).click()

  const row = page.getByRole('row').filter({ hasText: STUDENT_PROMOTE_TWO.name })
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.getByRole('button', { name: 'Leave out' }).click()

  await expect(page.getByText('2 students in view · 1 to promote, 0 to detain, 1 left out')).toBeVisible()

  await page.getByRole('button', { name: 'Promote students', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('1 to promote, 0 to detain, 1 left out')
  await expect(dialog).toContainText('The 1 left out are not touched at all.')
  await dialog.getByRole('button', { name: 'Promote students' }).click()

  // Only the one student named in the request moved.
  await expect(page.getByText('Students promoted')).toBeVisible({ timeout: 20_000 })
  const done = page.locator('section, aside').filter({ hasText: 'Last promotion' }).last()
  await expect(done).toContainText('Promoted')
  await expect(done).toContainText('1')
})
