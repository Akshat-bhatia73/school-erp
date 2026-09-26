/**
 * The words the scripted assistant model (support/assistant-server.ts) and the
 * assistant spec agree on. Kept apart from the server so the spec never loads
 * the API into the Playwright runner.
 */

/** A read question: the model lists the caller's sections, then answers. */
export const SECTIONS_QUESTION = 'Which sections do I look after?'
export const SECTIONS_ANSWER = 'You look after these two sections.'

/** Any question holding these words fails the first time it is asked. */
export const FAIL_ONCE = 'fail the first time'
export const RETRIED_ANSWER = 'Answered on the second try.'

/** A marking question the model turns into a register card for one section. */
export function markQuestion(section: 'R' | 'S', absentFirstName: string): string {
  return `Mark Eight ${section} for today: everyone present, ${absentFirstName} absent.`
}
