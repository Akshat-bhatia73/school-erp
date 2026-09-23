import type { AudiencePreview, MessageAudienceKind, RecipientOutcome } from '@erp/contracts'
import type { TenantConnection } from '../shared/index.ts'
import type { DispatchDependencies } from './common.ts'

/** A message's audience as the database holds it (ids already validated to be in this school). */
export interface AudienceTarget {
  readonly kind: MessageAudienceKind
  readonly gradeId?: string
  readonly sectionId?: string
  readonly academicYearId?: string
  readonly studentId?: string
  readonly staffId?: string
}

/** One person the message is for, as materialiseMessage records them. */
export interface ResolvedRecipient {
  readonly guardianId?: string
  readonly staffId?: string
  readonly membershipId: string | null
  readonly studentId: string | null
  readonly outcome: RecipientOutcome
  readonly inApp: boolean
  readonly emailStatus: 'none' | 'pending'
  readonly emailMasked: string | null
}

/** Stub: built by the dispatch agent. */
export async function resolveRecipients(
  _conn: TenantConnection,
  _deps: DispatchDependencies,
  _schoolId: string,
  _target: AudienceTarget,
): Promise<ResolvedRecipient[]> {
  throw new Error('resolveRecipients is not built yet')
}

/** Stub: built by the dispatch agent. */
export async function previewAudience(
  _conn: TenantConnection,
  _deps: DispatchDependencies,
  _schoolId: string,
  _target: AudienceTarget,
): Promise<Omit<AudiencePreview, 'audience'>> {
  throw new Error('previewAudience is not built yet')
}
