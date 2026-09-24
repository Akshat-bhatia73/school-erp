import {
  AUTOMATIC_MESSAGE_KINDS,
  DEFAULT_COMMUNICATION_SETTINGS,
  DEFAULT_MESSAGE_WORDING,
  type AutomaticMessageKind,
  type CommunicationSettingsValues,
} from '@erp/contracts'
import type { ModuleDependencies, TenantConnection } from '../shared/index.ts'

/**
 * What the dispatch side of the module needs: the pools (the runtime pool for
 * tenant work, the auth pool for a member's sign-in email address), the
 * delivery adapter for email, the document store for attachments and the
 * configuration for the site address.
 */
export type DispatchDependencies = Pick<ModuleDependencies, 'pools' | 'delivery' | 'documents' | 'config'>

/** The school's automatic message settings, plus what the list and the pump need beside them. */
export interface StoredCommunicationSettings extends CommunicationSettingsValues {
  /** 1 while the school has never saved them (there is no row yet). */
  readonly version: number
  /** When automatic messages started for this school; null while there is no row. */
  readonly automaticSince: string | null
  readonly exists: boolean
}

interface SettingsRow {
  absence_enabled: boolean
  absence_delay_minutes: number
  results_enabled: boolean
  report_cards_enabled: boolean
  fee_reminders_enabled: boolean
  fee_reminder_days_before: number
  fee_overdue_every_days: number
  birthdays_pupils_enabled: boolean
  birthdays_staff_enabled: boolean
  daily_send_hour: number
  automatic_since: Date
  version: number
}

/**
 * The settings row, or the defaults when the school has none. Reading never
 * writes: the row is created by the first save, or by the pump the first
 * time it runs for the school (which is when automatic messages start).
 */
export async function loadCommunicationSettings(
  conn: Pick<TenantConnection, 'client'>,
  schoolId: string,
): Promise<StoredCommunicationSettings> {
  const result = await conn.client.query<SettingsRow>(
    `SELECT absence_enabled, absence_delay_minutes, results_enabled, report_cards_enabled,
            fee_reminders_enabled, fee_reminder_days_before, fee_overdue_every_days,
            birthdays_pupils_enabled, birthdays_staff_enabled, daily_send_hour, automatic_since, version
       FROM communication_settings WHERE school_id = $1`,
    [schoolId],
  )
  const row = result.rows[0]
  if (!row) return { ...DEFAULT_COMMUNICATION_SETTINGS, version: 1, automaticSince: null, exists: false }
  return {
    absenceEnabled: row.absence_enabled,
    absenceDelayMinutes: row.absence_delay_minutes,
    resultsEnabled: row.results_enabled,
    reportCardsEnabled: row.report_cards_enabled,
    feeRemindersEnabled: row.fee_reminders_enabled,
    feeReminderDaysBefore: row.fee_reminder_days_before,
    feeOverdueEveryDays: row.fee_overdue_every_days,
    birthdaysPupilsEnabled: row.birthdays_pupils_enabled,
    birthdaysStaffEnabled: row.birthdays_staff_enabled,
    dailySendHour: row.daily_send_hour,
    automaticSince: row.automatic_since.toISOString(),
    version: row.version,
    exists: true,
  }
}

/** The wording an automatic kind uses: the school's live template, or the built-in words. */
export interface AutomaticWording {
  readonly kind: AutomaticMessageKind
  readonly title: string
  readonly body: string
  readonly templateId?: string
}

export async function loadAutomaticWording(
  conn: Pick<TenantConnection, 'client'>,
  schoolId: string,
): Promise<Record<AutomaticMessageKind, AutomaticWording>> {
  const result = await conn.client.query<{ id: string; kind: AutomaticMessageKind; title: string; body: string }>(
    `SELECT id, kind, title, body FROM message_templates
      WHERE school_id = $1 AND kind <> 'notice' AND archived_at IS NULL`,
    [schoolId],
  )
  const wording = {} as Record<AutomaticMessageKind, AutomaticWording>
  for (const kind of AUTOMATIC_MESSAGE_KINDS) {
    const own = result.rows.find((row) => row.kind === kind)
    wording[kind] = own
      ? { kind, title: own.title, body: own.body, templateId: own.id }
      : { kind, ...DEFAULT_MESSAGE_WORDING[kind] }
  }
  return wording
}

/**
 * An email address a message may be sent to. The reserved names (RFC 2606 and
 * 6761) never receive mail, and the seeded schools use them, so a message to
 * one is recorded as having no email instead of being handed to the provider.
 */
export function isDeliverableAddress(address: string | null | undefined): address is string {
  if (!address) return false
  const at = address.lastIndexOf('@')
  if (at < 1 || at === address.length - 1) return false
  const domain = address.slice(at + 1).toLowerCase()
  if (/\.(invalid|test|example|localhost|local)$/.test(domain)) return false
  if (['example.com', 'example.net', 'example.org', 'localhost'].includes(domain)) return false
  return true
}

/** "r•••@gmail.com": enough for the office to recognise an address, not enough to use it. */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf('@')
  if (at < 1) return '•••'
  return `${address.slice(0, 1)}•••${address.slice(at)}`
}
