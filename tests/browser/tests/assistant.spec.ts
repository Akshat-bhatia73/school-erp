/**
 * The assistant, driven the way a teacher uses it: a read question answered
 * from a real read tool, a register marked from a card, a card that went
 * stale because the register was saved elsewhere, a failed answer asked
 * again with Try again, a notice to a section edited and scheduled from its
 * card, a withdraw card that needs its reason, and a fee payment an
 * accountant changes and records from its card.
 *
 * The model is scripted (support/assistant-server.ts) and picks its reply from
 * the newest question; everything else — sessions, tools, the proposal store,
 * the attendance routes — is the real API. Section R belongs to the marking
 * test and section S to the stale test, so each starts from an unmarked
 * register the seed left.
 */
import { randomUUID } from 'node:crypto'
import { expect, test, type Locator, type Page } from '@playwright/test'
import pg from 'pg'
import { enrolAuthenticator, signInToSchool, signInWithSecondStep } from '../support/app.ts'
import {
  FAIL_ONCE,
  RETRIED_ANSWER,
  SECTIONS_ANSWER,
  SECTIONS_QUESTION,
  markQuestion,
} from '../support/assistant-script.ts'
import { APP_ORIGIN, MIGRATOR_URL } from '../env.ts'
import {
  ASSIST_PUPILS_R,
  ASSIST_PUPILS_S,
  ASSIST_SECTION_R,
  ASSIST_SECTION_S,
  PASSWORD,
  SCHOOL_A,
  YEAR_A,
  ownerA,
  teacherDelta,
  type Person,
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

// ---------------------------------------------------------------------------
// Fees (24d): an accountant records a payment from its card.

/**
 * The accountant and the fee class are laid down here rather than in the
 * seed, so the fee rows never reach a class another test reads. Their ids sit
 * in the suite's `b0000000-…` block, past everything setup/people.ts names.
 * The accountant's password is the suite's own, hashed by the seed for the
 * owner (the same PASSWORD): the row is copied, never invented.
 */
const feeIds = {
  section: 'b0000000-0000-4000-8000-000000000071',
  tuition: 'b0000000-0000-4000-8000-000000000072',
  lab: 'b0000000-0000-4000-8000-000000000073',
}
const accountant: Person = {
  key: 'accountant',
  userId: 'b0000000-0000-4000-8000-000000000170',
  membershipId: 'b0000000-0000-4000-8000-000000000270',
  staffId: 'b0000000-0000-4000-8000-000000000370',
  displayName: 'Browser Accountant',
  email: 'browser-accountant@example.test',
  password: PASSWORD,
}

/** A new pupil each run, in the fee class, so their fees start unpaid; the name is in letters only. */
async function feeFixtures(db: pg.Pool): Promise<{ id: string; name: string }> {
  await db.query(
    `INSERT INTO auth_user (id, name, email, email_verified) VALUES ($1, $2, $3, true)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, two_factor_enabled = false`,
    [accountant.userId, accountant.displayName, accountant.email],
  )
  await db.query(`DELETE FROM auth_account WHERE user_id = $1`, [accountant.userId])
  await db.query(
    `INSERT INTO auth_account (account_id, provider_id, user_id, password)
     SELECT $1::text, provider_id, $1::uuid, password FROM auth_account WHERE user_id = $2 AND provider_id = 'credential'`,
    [accountant.userId, ownerA.userId],
  )
  await db.query('DELETE FROM auth_two_factor WHERE user_id = $1', [accountant.userId])
  await db.query(
    `INSERT INTO school_memberships (id, school_id, user_id, kind, status) VALUES ($1, $2, $3, 'adult', 'active')
     ON CONFLICT (school_id, user_id) DO UPDATE SET status = 'active'`,
    [accountant.membershipId, SCHOOL_A, accountant.userId],
  )
  await db.query(
    `INSERT INTO membership_roles (school_id, membership_id, role_id)
     SELECT $1, $2, id FROM roles WHERE school_id = $1 AND key = 'accountant' ON CONFLICT DO NOTHING`,
    [SCHOOL_A, accountant.membershipId],
  )
  await db.query('DELETE FROM assistant_threads WHERE school_id = $1 AND membership_id = $2', [SCHOOL_A, accountant.membershipId])
  await db.query('DELETE FROM assistant_usage WHERE school_id = $1 AND membership_id = $2', [SCHOOL_A, accountant.membershipId])

  await db.query(`INSERT INTO grades (id, school_id, name, short_name, sort_order) VALUES (gen_random_uuid(), $1, 'Nine', '9', 9) ON CONFLICT DO NOTHING`, [SCHOOL_A])
  const grade = (await db.query<{ id: string }>(`SELECT id FROM grades WHERE school_id = $1 AND name = 'Nine'`, [SCHOOL_A])).rows[0]!.id
  await db.query(`INSERT INTO sections (id, school_id, academic_year_id, grade_id, name) VALUES ($1, $2, $3, $4, 'F') ON CONFLICT DO NOTHING`, [
    feeIds.section,
    SCHOOL_A,
    YEAR_A,
    grade,
  ])
  // Tuition by the month and the lab by the quarter, both charged to Nine from the first day of the year.
  for (const [id, name, category, frequency, amount] of [
    [feeIds.tuition, 'Browser Tuition', 'tuition', 'monthly', 100_000],
    [feeIds.lab, 'Browser Lab', 'lab', 'quarterly', 90_000],
  ] as const) {
    await db.query(`INSERT INTO fee_heads (id, school_id, name, category, applies_to, frequency) VALUES ($1, $2, $3, $4, 'class', $5) ON CONFLICT DO NOTHING`, [
      id,
      SCHOOL_A,
      name,
      category,
      frequency,
    ])
    await db.query(
      `INSERT INTO fee_structures (school_id, academic_year_id, fee_head_id, grade_id, amount_paise) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [SCHOOL_A, YEAR_A, id, grade, amount],
    )
  }

  const run = Date.now().toString(36).replace(/[0-9]/g, (digit) => 'abcdefghij'[Number(digit)]!)
  const pupil = { id: randomUUID(), name: `Farah Feerun${run}` }
  await db.query(`INSERT INTO students (id, school_id, admission_number, first_name, last_name, status) VALUES ($1, $2, $3, 'Farah', $4, 'active')`, [
    pupil.id,
    SCHOOL_A,
    `BR/FEE/${run}`,
    `Feerun${run}`,
  ])
  await db.query(
    `INSERT INTO enrollments (id, school_id, student_id, academic_year_id, section_id, roll_number, joined_on)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 1, '2026-04-01')`,
    [SCHOOL_A, pupil.id, YEAR_A, feeIds.section],
  )
  return pupil
}

/** "₹1,800", as the web shows whole rupees. */
function rupees(paise: number): string {
  return `₹${new Intl.NumberFormat('en-IN').format(paise / 100)}`
}

test('an accountant records a payment from its card: the split follows the amount, and the receipt is on the statement', async ({ page, playwright, baseURL }) => {
  const db = new pg.Pool({ connectionString: MIGRATOR_URL })
  try {
    const pupil = await feeFixtures(db)
    const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL ?? '' } })
    const secret = await enrolAuthenticator(api, accountant)
    await api.dispose()
    await signInWithSecondStep(page, accountant, secret)

    // What is due, read the way the Fees screen reads it: both fees fell due on the first day, so the lab goes first by name.
    const read = await page.request.get(`/api/schools/${SCHOOL_A}/fees/students/${pupil.id}/statement?academicYearId=${YEAR_A}`)
    expect(read.ok(), `the statement was refused: ${read.status()}`).toBeTruthy()
    const statement = (await read.json()) as { lines: { head: { id: string }; balancePaise: number }[] }
    const labDue = statement.lines.find((line) => line.head.id === feeIds.lab)?.balancePaise ?? 0
    const tuitionDue = statement.lines.find((line) => line.head.id === feeIds.tuition)?.balancePaise ?? 0
    expect(labDue).toBeGreaterThanOrEqual(90_000)
    expect(tuitionDue).toBeGreaterThanOrEqual(100_000)

    await page.goto('/assistant')
    await expect(page.getByText('Ask anything about your school')).toBeVisible()
    await ask(page, `Record a payment of 500 rupees for ${pupil.name}`)

    const card = page.getByRole('region', { name: `Record a payment for ${pupil.name}` })
    await expect(card).toBeVisible()
    const split = card.getByRole('table', { name: 'How the payment is split' })
    const labRow = split.getByRole('row').filter({ hasText: 'Browser Lab' })
    const tuitionRow = split.getByRole('row').filter({ hasText: 'Browser Tuition' })
    await expect(split.getByRole('row').nth(1)).toContainText('Browser Lab')
    await expect(labRow.getByRole('cell').nth(2)).toHaveText('₹500')
    await expect(tuitionRow.getByRole('cell').nth(2)).toHaveText('—')

    // The person changes the amount: the lab is cleared and the rest goes to tuition.
    const amount = labDue + 70_000
    await card.getByLabel('Amount').fill(String(amount / 100))
    await expect(labRow.getByRole('cell').nth(2)).toHaveText(rupees(labDue))
    await expect(tuitionRow.getByRole('cell').nth(2)).toHaveText('₹700')
    await expect(card.getByText('Balance after this payment').locator('xpath=following-sibling::dd[1]')).toHaveText(
      rupees(labDue + tuitionDue - amount),
    )

    // Paid by UPI, with its reference.
    await card.getByLabel('Method').click()
    await page.getByRole('option', { name: 'UPI' }).click()
    const reference = `UPI${Date.now()}`
    await card.getByLabel('Reference', { exact: true }).fill(reference)
    await card.getByRole('button', { name: 'Record payment' }).click()

    await expect(card).toHaveAttribute('data-status', 'done')
    await expect(card.getByText(`Recorded ${rupees(amount)} by UPI.`)).toBeVisible()
    const open = card.getByRole('link', { name: 'Open receipt' })
    await expect(open).toHaveAttribute('href', /\/fees\/receipts\/[0-9a-f-]{36}$/)
    const receiptId = ((await open.getAttribute('href')) ?? '').split('/').at(-1) ?? ''

    const receipt = await page.request.get(`/api/schools/${SCHOOL_A}/fees/receipts/${receiptId}`)
    expect(receipt.ok(), `the receipt was refused: ${receipt.status()}`).toBeTruthy()
    const written = (await receipt.json()) as { receiptNumber: string; amountPaise: number; mode: string; reference?: string; student: { id: string } }
    expect(written).toMatchObject({ amountPaise: amount, mode: 'upi', reference, student: { id: pupil.id } })

    await open.click()
    await expect(page).toHaveURL(new RegExp(`/fees/receipts/${receiptId}`))
    await expect(page.getByText(written.receiptNumber).filter({ visible: true }).first()).toBeVisible()

    await page.goto(`/fees/students/${pupil.id}?academicYearId=${YEAR_A}`)
    const entry = page.getByRole('button').filter({ hasText: written.receiptNumber })
    await expect(entry).toBeVisible()
    await expect(entry).toContainText(rupees(amount))
  } finally {
    await db.query('DELETE FROM auth_two_factor WHERE user_id = $1', [accountant.userId]).catch(() => undefined)
    await db.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [accountant.userId]).catch(() => undefined)
    await db.end()
  }
})
