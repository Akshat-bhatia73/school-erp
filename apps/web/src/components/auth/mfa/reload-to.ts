/**
 * Leave the second-step screens with a real page load instead of a client-side navigation.
 *
 * Finishing a second factor changes the session on the server: the school context now answers
 * `ready` where it answered `mfa_required`. Nothing in the app is told that, so a client-side
 * navigation lands on the gate while it still holds the old answer and gets bounced straight back
 * here. A page load rebuilds the session from the server once, and the person arrives where they
 * were going.
 */
export function reloadTo(href: string) {
  window.location.assign(href)
}
