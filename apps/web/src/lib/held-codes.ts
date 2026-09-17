import { z } from 'zod'

const HeldCodesResponse = z.object({
  messages: z.array(z.object({
    to: z.string(),
    purpose: z.enum(['otp', 'password_reset', 'verification', 'invitation']),
    secret: z.string(),
    createdAt: z.string(),
  })),
})
export type HeldCode = z.infer<typeof HeldCodesResponse>['messages'][number]

export class HeldCodesRefused extends Error {}

/**
 * Test builds only: the text messages the server held instead of sending. It is not a session
 * call, so it does not go through `request`: the access code travels in a header, no cookie is
 * involved and a refusal here must never look like a lost session.
 */
export async function heldCodes(accessCode: string, signal?: AbortSignal): Promise<HeldCode[]> {
  const response = await fetch('/api/held-codes', {
    headers: { authorization: `Bearer ${accessCode}` },
    credentials: 'omit',
    cache: 'no-store',
    signal,
  })
  if (!response.ok) throw new HeldCodesRefused()
  return HeldCodesResponse.parse(await response.json()).messages
}
