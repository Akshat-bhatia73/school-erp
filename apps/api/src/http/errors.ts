import { ERROR_STATUS, type ErrorCode, type ErrorReason } from '@erp/contracts'
import type { ApiError } from '@erp/contracts'

/** Safe, non-specific text. Never mention identifiers, tokens or database state. */
const MESSAGES: Record<ErrorCode, string> = {
  AUTHENTICATION_REQUIRED: 'Please sign in to continue.',
  SESSION_EXPIRED: 'Your session has ended. Please sign in again.',
  MFA_REQUIRED: 'Complete two-step verification to continue.',
  FRESH_AUTHENTICATION_REQUIRED: 'Please confirm your identity again.',
  SCHOOL_ACCESS_UNAVAILABLE: 'This school is not available for your account.',
  ACCESS_DENIED: 'You do not have access to this.',
  FEATURE_DISABLED: 'This feature is not available.',
  RESOURCE_NOT_FOUND: 'That record was not found.',
  INVALID_REQUEST: 'Some details are missing or invalid.',
  INVITATION_UNAVAILABLE: 'This invitation cannot be used.',
  VERSION_CONFLICT: 'Someone else changed this first. Reload and try again.',
  LAST_OWNER_PROTECTED: 'A school must always keep one owner.',
  IDENTITY_LINK_CONFLICT: 'This login is already linked to someone else.',
  NOT_ALLOWED_YET: 'This cannot be done yet.',
  RATE_LIMITED: 'Too many attempts. Please wait and try again.',
  SERVICE_UNAVAILABLE: 'The service is busy. Please try again shortly.',
}

/**
 * What a person can do about a refusal, for the few refusals that have an
 * answer. Each sentence names a kind of blocker and the way past it, never a
 * record, a count or a name, so it says nothing the caller could not already
 * see on the screen they came from.
 */
const REASON_MESSAGES: Record<ErrorReason, string> = {
  grade_has_sections: 'This class still has sections. Remove its sections first.',
  grade_has_subjects: 'This class still has subjects. Take its subjects off first.',
  grade_has_bell_schedule: 'This class is still on a bell schedule. Take it off the bell schedule first.',
  section_has_students: 'This section still has students, now or in its history. Move them to another section first.',
  section_has_teachers: 'This section still has teachers assigned. End their assignments first.',
  section_has_timetable: 'This section still has a timetable. Clear its timetable first.',
  section_has_substitutions: 'This section has substitutions on record, so it cannot be removed.',
  section_has_access_rules: 'Someone has been given special access to this section. Remove that access first.',
  subject_has_classes: 'This subject is still taught in a class. Take it off every class first.',
  subject_has_teachers: 'This subject still has teachers assigned. End their assignments first.',
  subject_has_timetable: 'This subject is still on a timetable. Clear it from the timetable first.',
  subject_has_substitutions: 'This subject has substitutions on record, so it cannot be removed.',
  fee_head_in_use:
    'This fee is still part of a fee structure, a pupil\'s fees or a receipt, so it cannot be removed. Mark it as not in use instead.',
  fee_structure_has_payments:
    'Payments have already been taken against this fee for this year, so it cannot be removed. Change the amount instead.',
  fee_opt_in_has_payments:
    'Payments have already been taken against this optional fee, so it cannot be removed. Give it an end date instead.',
  fee_amount_exceeds_balance:
    'That is more than is left to pay for this fee. Check the amounts and try again.',
  fee_receipt_already_reversed:
    'This receipt has already been cancelled or refunded in full, so there is nothing left to reverse.',
  fee_nothing_charged: 'This pupil is not charged that fee in this year, so nothing can be recorded against it.',
  attendance_date_outside_year: 'That date is outside the academic year, so there is no attendance to record for it.',
  attendance_not_a_school_day: 'That day is a Sunday or a holiday, so there is no attendance to record.',
  attendance_date_in_future: 'That day has not come yet. Attendance is recorded on the day.',
  attendance_marking_window_closed:
    'The day for marking this register has passed. Ask the school office to correct it.',
  attendance_pupil_not_on_roster: 'Somebody in this list was not in this section on that day. Reload and try again.',
  attendance_roster_incomplete: 'Every pupil in the section needs a mark. Reload and try again.',
  attendance_month_outside_year: 'That month is outside every academic year of this school.',
  staff_attendance_own_record: 'You cannot mark your own attendance. Leave your own row for a colleague.',
  staff_attendance_not_on_register: 'Somebody in this list is not on the staff register for that day. Reload and try again.',
  staff_attendance_register_incomplete: 'Every staff member on the register needs a mark. Reload and try again.',
}

export class ApiFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly retryAfterSeconds?: number,
    /** Only for a caller who was allowed to ask; never on an access refusal. */
    readonly reason?: ErrorReason,
  ) {
    super(code)
  }
}

export function apiError(
  code: ErrorCode,
  requestId: string,
  retryAfterSeconds?: number,
  reason?: ErrorReason,
): { status: number; body: ApiError } {
  return {
    status: ERROR_STATUS[code],
    body: {
      error: {
        code,
        ...(reason ? { reason } : {}),
        message: reason ? REASON_MESSAGES[reason] : MESSAGES[code],
        requestId,
        ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
      },
    },
  }
}
