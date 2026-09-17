/**
 * An owner suspends a teacher who is signed in at that moment, in another
 * browser context. The teacher's next navigation must land on the refusal,
 * not on the roster they were looking at a second earlier.
 */
import { expect, test } from '@playwright/test'
import {
  enrolAuthenticator,
  openRoster,
  signInToSchool,
  signInWithSecondStep,
} from '../support/app.ts'
import { closeDb, membershipStatus, restoreMembership } from '../support/db.ts'
import { STUDENT_ALPHA, ownerA, teacherGamma } from '../setup/people.ts'

test.afterAll(async () => {
  await restoreMembership(teacherGamma.membershipId)
  await closeDb()
})

test('a suspension commits into a live session on its next navigation', async ({ browser, playwright, baseURL }) => {
  const api = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: baseURL ?? '' },
  })
  const secret = await enrolAuthenticator(api, ownerA)
  await api.dispose()

  const teacherContext = await browser.newContext()
  const teacher = await teacherContext.newPage()
  await signInToSchool(teacher, teacherGamma)
  await openRoster(teacher)
  await expect(teacher.getByText(STUDENT_ALPHA.name).filter({ visible: true }).first()).toBeVisible()

  const ownerContext = await browser.newContext()
  const owner = await ownerContext.newPage()
  await signInWithSecondStep(owner, ownerA, secret)

  await owner.goto('/settings/users')
  await owner.getByRole('button', { name: `Actions for ${teacherGamma.displayName}` }).click()
  await owner.getByRole('menuitem', { name: 'Manage access' }).click()
  await owner.getByRole('tab', { name: 'Access', exact: true }).click()
  await owner.getByRole('button', { name: 'Suspend', exact: true }).click()
  await owner.getByLabel('Why?').fill('Browser suite: suspension while signed in')
  await owner.getByRole('button', { name: 'Suspend', exact: true }).last().click()
  await expect(owner.getByText('Suspended this person')).toBeVisible()
  expect(await membershipStatus(teacherGamma.membershipId)).toBe('suspended')

  // The teacher's own tab still holds the screen it rendered before the
  // change. Its next navigation is the moment the server decides again.
  await teacher.goto('/students')
  await expect(teacher.getByText(STUDENT_ALPHA.name)).toHaveCount(0)
  // The refusal this path really renders. /api/me lists active memberships
  // only, so a teacher whose sole membership is suspended has none and the
  // shell shows the "no_membership" copy, whose body names suspension. The
  // "Access suspended" title is reachable only when the person still has
  // another school. Asserting the exact title is deliberate: a regression that
  // swapped one refusal for another would fail.
  await expect(teacher.getByRole('heading', { name: 'No school yet' })).toBeVisible({
    timeout: 20_000,
  })
  await expect(
    teacher.getByText('your access may have been suspended or removed'),
  ).toBeVisible()

  await teacherContext.close()
  await ownerContext.close()
})
