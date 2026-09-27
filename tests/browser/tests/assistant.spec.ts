/**
 * The assistant, driven the way a teacher uses it: a read question answered
 * from a real read tool, a register marked from a card, a card that went
 * stale because the register was saved elsewhere, a failed answer asked
 * again with Try again, a notice to a section edited and scheduled from its
 * card, and a withdraw card that needs its reason.
 *
 * The model is scripted (support/assistant-server.ts) and picks its reply from
 * the newest question; everything else — sessions, tools, the proposal store,
 * the attendance routes — is the real API. Section R belongs to the marking
 * test and section S to the stale test, so each starts from an unmarked
 * register the seed left.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { signInToSchool } from '../support/app.ts'
import {
  FAIL_ONCE,
  RETRIED_ANSWER,
  SECTIONS_ANSWER,
  SECTIONS_QUESTION,
  markQuestion,
} from '../support/assistant-script.ts'
import { APP_ORIGIN } from '../env.ts'
import {
  ASSIST_PUPILS_R,
  ASSIST_PUPILS_S,
  ASSIST_SECTION_R,
  ASSIST_SECTION_S,
  SCHOOL_A,
  teacherDelta,
} from '../setup/people.ts'

/** The school's day (Asia/Kolkata), which is the day a register can be marked. */
function schoolToday(): { iso: string; sunday: boolean } {
  const now = new Date()
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now)
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'long' }).format(now)
  return { iso, sunday: weekday === 'Sunday' }
}

async function ask(page: Page, question: string): Promise<void> {
  const box = page.getByLabel('Your question')
  await box.fill(question)
  await box.press('Enter')
}

/** The mark a register row shows as chosen, by its full label ("Absent"). */
async function expectMark(scope: Page | Locator, name: string, label: string): Promise<void> {
  await expect(
    scope.getByRole('group', { name: `Mark for ${name}` }).getByRole('button', { pressed: true }),
  ).toHaveAttribute('title', label)
}

async function openAssistant(page: Page): Promise<void> {
  await signInToSchool(page, teacherDelta)
  await page.goto('/assistant')
  await expect(page.getByText('Ask anything about your school')).toBeVisible()
}

test('a teacher asks a read question and gets the answer, its card and a conversation in the history', async ({ page }) => {
  await openAssistant(page)
  await ask(page, SECTIONS_QUESTION)

  await expect(page.getByText(SECTIONS_ANSWER)).toBeVisible()
  // The card is the real find_sections answer, scoped to what Delta may see.
  await expect(page.getByText(ASSIST_SECTION_R.label, { exact: true })).toBeVisible()
  await expect(page.getByText(ASSIST_SECTION_S.label, { exact: true })).toBeVisible()
  await expect(page.getByText('Teacher Delta', { exact: true }).first()).toBeVisible()

  await page.getByRole('button', { name: /Which sections do I look after/ }).click()
  await expect(page.getByText('Chat history')).toBeVisible()
  await expect(page.locator('[aria-current="true"]')).toContainText('Which sections do I look after')
})

test('a teacher marks a register from the card, changes one mark, and the register shows it', async ({ page }) => {
  const today = schoolToday()
  test.skip(today.sunday, 'A register cannot be marked on a Sunday.')
  const [ria, ravi, rekha] = ASSIST_PUPILS_R

  await openAssistant(page)
  await ask(page, markQuestion('R', 'Ravi'))

  const card = page.getByRole('region', { name: new RegExp(`^Mark ${ASSIST_SECTION_R.label} for`) })
  await expect(card).toBeVisible()
  await expectMark(card, ravi.name, 'Absent')
  await expectMark(card, ria.name, 'Present')

  // The person changes one pupil's mark in the card before saving.
  await card.getByRole('group', { name: `Mark for ${ria.name}` }).getByTitle('Late', { exact: true }).click()
  await expectMark(card, ria.name, 'Late')
  await card.getByRole('button', { name: 'Confirm' }).click()

  await expect(card).toHaveAttribute('data-status', 'done')
  await expect(card.getByText(/^Saved/).first()).toBeVisible()

  await page.goto(`/attendance/sections/${ASSIST_SECTION_R.id}?date=${today.iso}`)
  await expectMark(page, ria.name, 'Late')
  await expectMark(page, ravi.name, 'Absent')
  await expectMark(page, rekha.name, 'Present')
})

test('a card whose register was saved elsewhere says it changed, and the other save stands', async ({ page }) => {
  const today = schoolToday()
  test.skip(today.sunday, 'A register cannot be marked on a Sunday.')
  const [sam, sita, suraj] = ASSIST_PUPILS_S

  await openAssistant(page)
  await ask(page, markQuestion('S', 'Sita'))

  const card = page.getByRole('region', { name: new RegExp(`^Mark ${ASSIST_SECTION_S.label} for`) })
  await expect(card).toBeVisible()
  await expectMark(card, sita.name, 'Absent')

  // The same teacher saves the register another way first: Sam absent, the rest present.
  const saved = await page.request.put(
    `/api/schools/${SCHOOL_A}/attendance/sections/${ASSIST_SECTION_S.id}/days/${today.iso}`,
    {
      headers: { origin: APP_ORIGIN },
      data: {
        marks: ASSIST_PUPILS_S.map((pupil) => ({
          studentId: pupil.id,
          mark: pupil.id === sam.id ? 'absent' : 'present',
          expectedRevision: 0,
        })),
      },
    },
  )
  expect(saved.ok(), `the register save was refused: ${saved.status()}`).toBeTruthy()

  await card.getByRole('button', { name: 'Confirm' }).click()
  await expect(card).toHaveAttribute('data-status', 'stale')
  await expect(card.getByText('Changed since')).toBeVisible()

  await page.goto(`/attendance/sections/${ASSIST_SECTION_S.id}?date=${today.iso}`)
  await expectMark(page, sam.name, 'Absent')
  await expectMark(page, sita.name, 'Present')
  await expectMark(page, suraj.name, 'Present')
})

test('an answer that failed can be asked again with Try again', async ({ page }) => {
  await openAssistant(page)
  await ask(page, `Please ${FAIL_ONCE}, then say something.`)

  const failure = page.getByRole('alert').filter({ hasText: 'Try again' })
  await expect(failure).toBeVisible()
  await expect(failure).toContainText('Something went wrong while answering')

  await failure.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByText(RETRIED_ANSWER)).toBeVisible()
  await expect(failure).toHaveCount(0)
})

/** Tomorrow on the school's clock (Asia/Kolkata), as a date box takes it. */
function schoolTomorrow(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + 86_400_000))
}

test('a teacher asks for a notice to their section, edits the title, schedules it, and the Messages screen shows it scheduled', async ({ page }) => {
  const run = Date.now().toString(36)
  const asked = `Picnic notice ${run}`
  const title = `Picnic moved to Saturday ${run}`

  await openAssistant(page)
  await ask(page, `Send a notice to Eight R: ${asked}`)

  const card = page.getByRole('region', { name: `Send a notice to ${ASSIST_SECTION_R.label}` })
  await expect(card).toBeVisible()
  await expect(card.getByText(ASSIST_SECTION_R.label, { exact: true })).toBeVisible()
  await expect(card.getByLabel('Title')).toHaveValue(asked)
  await expect(card.getByRole('button', { name: 'Send notice' })).toBeVisible()

  // The person rewrites the title and picks a time instead of sending now.
  await card.getByLabel('Title').fill(title)
  await card.getByRole('radio', { name: 'Schedule' }).click()
  await card.getByLabel('Date').fill(schoolTomorrow())
  await card.getByLabel('Time').fill('10:00')
  await card.getByRole('button', { name: 'Schedule notice' }).click()

  await expect(card).toHaveAttribute('data-status', 'done')
  await expect(card.getByText(/^Scheduled the notice for/).first()).toBeVisible()

  await page.goto('/messages?tab=sent')
  const row = page.getByRole('row').filter({ hasText: title })
  await expect(row).toBeVisible()
  await expect(row).toContainText('Scheduled')
  await expect(page.getByRole('row').filter({ hasText: asked })).toHaveCount(0)
})

test('a withdraw card asks for the reason before it takes a sent notice back', async ({ page }) => {
  const title = `Sports day moved ${Date.now().toString(36)}`
  await openAssistant(page)

  // The teacher sent this notice from the Messages screen earlier.
  const sent = await page.request.post(`/api/schools/${SCHOOL_A}/messages`, {
    headers: { origin: APP_ORIGIN },
    data: {
      // The seed's pupils have no guardians, so the pupils themselves are the audience.
      audience: { kind: 'section', sectionId: ASSIST_SECTION_S.id, recipients: 'students' },
      title,
      body: 'Sports day is on Saturday.',
      send: { when: 'now' },
    },
  })
  expect(sent.status(), `the notice was not sent: ${await sent.text()}`).toBe(201)
  const messageId = ((await sent.json()) as { id: string }).id

  await ask(page, `Withdraw the notice ${title}`)
  const card = page.getByRole('region', { name: `Withdraw "${title}"` })
  await expect(card).toBeVisible()
  await expect(card.getByText(ASSIST_SECTION_S.label, { exact: true })).toBeVisible()

  // Without a reason the card says so and nothing is sent.
  await card.getByRole('button', { name: 'Withdraw message' }).click()
  await expect(card.getByRole('alert').filter({ hasText: 'Give a reason.' })).toBeVisible()
  await expect(card).toHaveAttribute('data-status', 'open')

  await card.getByLabel('Reason').fill('The date changed.')
  await card.getByRole('button', { name: 'Withdraw message' }).click()
  await expect(card).toHaveAttribute('data-status', 'done')
  await expect(card.getByText('Withdrew the message.').first()).toBeVisible()

  const after = await page.request.get(`/api/schools/${SCHOOL_A}/messages/${messageId}`)
  expect(((await after.json()) as { status: string }).status).toBe('withdrawn')
})
