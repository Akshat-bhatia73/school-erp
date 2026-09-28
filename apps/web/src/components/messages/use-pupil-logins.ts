/**
 * Whether any pupil in an audience has their own login, so the "Send to" choice is worth showing.
 * It asks the audience preview about the pupils alone. While that is being counted the answer is
 * 'unknown'; when it cannot be counted the choice is offered as before ('some').
 */
import { useQuery } from '@tanstack/react-query'
import type { MessageAudienceInput } from '@erp/contracts'
import { api } from '@/lib/api'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { pupilLoginProbe } from './labels'

export type PupilLogins = 'some' | 'none' | 'unknown'

export function usePupilLogins(audience: MessageAudienceInput | null): PupilLogins {
  const { schoolId } = useSchoolContext()
  const probe = pupilLoginProbe(audience)
  const query = useQuery({
    queryKey: qk.messages.audiencePreview(schoolId, probe ?? undefined),
    queryFn: () => api.messages.audiencePreview(schoolId, probe!),
    enabled: probe !== null,
  })
  if (query.data) return query.data.pupilsInApp > 0 ? 'some' : 'none'
  return query.isError ? 'some' : 'unknown'
}
