/**
 * The handful of things every test does: sign in, open the roster, hold a
 * request open, and ask what is on the screen.
 *
 * Locators are the accessible ones the screens already expose (labels, roles
 * and the text a person reads). Nothing here adds a test hook to the app.
 */
import { expect, type APIRequestContext, type Page, type Route } from '@playwright/test'
import { resetRateLimits } from './db.ts'
import { secretFromTotpUri, totpCode } from './totp.ts'
import type { Person } from '../setup/people.ts'

/** Every protected list this suite watches for a stale repaint. */
export const STUDENT_LIST_GLOB = '**/api/schools/*/students?**'

export async function signIn(page: Page, person: Person): Promise<void> {
  await resetRateLimits()
  await page.goto('/login')
  await page.getByLabel('Email address').fill(person.email)
  await page.getByLabel('Password', { exact: true }).fill(person.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

/** Sign in as somebody whose only membership opens straight onto the shell. */
export async function signInToSchool(page: Page, person: Person): Promise<void> {
  await signIn(page, person)
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 })
}

export async function openRoster(page: Page): Promise<void> {
  await page.goto('/students')
  await expect(page).toHaveURL(/\/students/)
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account menu for/ }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
}

export async function switchSchool(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account menu for/ }).click()
  await page.getByRole('menuitem', { name: 'Switch school' }).click()
  await expect(page).toHaveURL(/\/select-school/)
}

export async function chooseSchool(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(name) }).click()
}

/**
 * Holds the next matching request open for `ms`, then lets it through. The
 * point is that its answer belongs to the identity and school that asked for
 * it, and must never reach a screen that has moved on.
 */
export function holdOnce(page: Page, glob: string, ms: number): Promise<void> {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let used = false
  void page.route(glob, async (route: Route) => {
    if (used) return route.continue()
    used = true
    // Fetch first, while the old session is still the one the server sees, so
    // the captured body really is the old identity's answer. Only the delivery
    // to the page is deferred past the transition.
    try {
      const response = await route.fetch()
      await new Promise((resolve) => setTimeout(resolve, ms))
      await route.fulfill({ response })
    } catch {
      // The context can go away mid-hold; that is not a failure of the test.
    }
    release()
  })
  return held
}

/**
 * Watches one name for the whole of a transition. `toHaveCount(0)` at the end
 * would miss a stale row that appeared and was swept away again, so a
 * MutationObserver records every DOM state instead of sampling: if the old
 * identity's pupil is ever in the document, the flag is set and stays set.
 */
export async function watchForText(
  page: Page,
  text: string,
): Promise<{ stop(): Promise<boolean> }> {
  const flag = '__erpSeenStaleText'
  const install = (args: { text: string; flag: string }) => {
    const w = window as unknown as Record<string, unknown>
    const look = () => {
      if (document.body?.innerText?.includes(args.text)) w[args.flag] = true
    }
    w[args.flag] = false
    look()
    const observer = new MutationObserver(look)
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    })
  }
  // On every document this page loads during the transition, and on the one
  // that is already open.
  await page.addInitScript(install, { text, flag })
  await page.evaluate(install, { text, flag }).catch(() => undefined)

  let seen = false
  const read = async () => {
    const value = await page
      .evaluate((name: string) => Boolean((window as unknown as Record<string, unknown>)[name]), flag)
      .catch(() => false)
    if (value) seen = true
  }
  // A document that is replaced takes its flag with it, so read each one as it
  // is retired.
  const onNavigated = () => {
    void read()
  }
  page.on('framenavigated', onNavigated)

  return {
    async stop() {
      page.off('framenavigated', onNavigated)
      await read()
      return seen
    },
  }
}

/**
 * Enrols an authenticator for a privileged role, the way account security
 * would, so the browser can be driven through the real second step. The seed
 * clears every enrolment, so this always starts from nothing.
 */
export async function enrolAuthenticator(
  request: APIRequestContext,
  person: Person,
): Promise<string> {
  await resetRateLimits()
  const signedIn = await request.post('/api/auth/sign-in/email', {
    data: { email: person.email, password: person.password },
  })
  expect(signedIn.ok(), 'the enrolment sign-in was refused').toBeTruthy()

  await resetRateLimits()
  const enabled = await request.post('/api/auth/two-factor/enable', {
    data: { password: person.password },
  })
  expect(enabled.ok(), 'two-factor enrolment was refused').toBeTruthy()
  const secret = secretFromTotpUri(((await enabled.json()) as { totpURI: string }).totpURI)

  await resetRateLimits()
  const verified = await request.post('/api/auth/two-factor/verify-totp', {
    data: { code: totpCode(secret) },
  })
  expect(verified.ok(), 'the first authenticator code was refused').toBeTruthy()
  return secret
}

/** Password, then the code from the authenticator, then the shell. */
export async function signInWithSecondStep(
  page: Page,
  person: Person,
  secret: string,
): Promise<void> {
  await signIn(page, person)
  await expect(page).toHaveURL(/\/mfa\/verify/, { timeout: 20_000 })
  await resetRateLimits()
  await page.getByLabel('Code from your authenticator app').fill(totpCode(secret))
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 })
}
