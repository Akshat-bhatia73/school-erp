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
  PASSWORD_CHANGE_REQUIRED: 'Choose your own password to continue.',
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
  exam_dates_outside_year: 'The exam dates have to fall inside the academic year.',
  exam_already_published: 'Results for this exam have already been published, so its dates can no longer change.',
  exam_nothing_to_publish: 'These results are already published and no mark has changed since.',
  exam_not_started: 'This exam has not started yet. Marks can be entered from its first day.',
  exam_recheck_deadline_passed: 'The re-check deadline for this exam has passed. Only the office can change these marks now.',
  exam_change_needs_reason: 'Changing a mark that was already saved needs a reason.',
  exam_mark_above_maximum: 'A mark is higher than that part of the exam is out of.',
  exam_component_not_in_exam: 'That part of the exam does not belong to this exam. Reload and try again.',
  exam_pupil_not_on_roster: 'Somebody in this list does not sit this paper in this section. Reload and try again.',
  exam_publish_before_deadline: 'Results can be published once the re-check deadline has passed.',
  exam_section_incomplete: 'Every pupil needs a mark or a status in every subject before the results can be published.',
  grade_bands_overlap: 'Two grade bands cover the same marks. Each mark can belong to one band only.',
  grade_bands_gap: 'The grade bands leave some marks without a grade. Make each band start one above the next one down.',
  grade_bands_out_of_range: 'The grade bands have to run from 0 to 100.',
  grade_bands_duplicate_label: 'Two grade bands have the same name.',
  report_card_exams_not_published: 'The results of this term\'s exams have to be published for this section before its report cards can be.',
  report_card_exams_changed: 'Marks have changed since this term\'s results were published. Publish the results again first.',
  report_card_nothing_to_publish: 'Every report card here is already published and nothing has changed since.',
  report_card_pupil_not_on_roster: 'Somebody in this list is not in this section for that term. Reload and try again.',
  message_not_editable: 'This message has already gone out, so it can no longer be changed.',
  message_not_sent: 'Only a message that has gone out can be withdrawn.',
  message_schedule_in_past: 'Choose a time at least five minutes from now.',
  message_schedule_too_far: 'A message can be scheduled at most 60 days ahead.',
  message_audience_empty: 'Nobody is in this audience yet. Choose another audience.',
  message_placeholder_unknown: 'The words use a placeholder that this message cannot fill in. Remove it or choose another audience.',
  message_attachment_too_large: 'A file can be at most 2 MB.',
  message_attachment_type: 'Attach a PDF, JPEG or PNG file.',
  message_too_many_attachments: 'A message can carry at most three files.',
  message_template_archived: 'This template has been archived. Choose another one.',
  message_template_kind_mismatch: 'This template is for a different kind of message.',
  student_login_not_eligible: 'Only a pupil on the roll in Class 9 to 12 this year can have a login.',
  student_login_no_guardian_phone: 'Add a phone number for the primary guardian first: the password is sent there.',
  student_login_exists: 'This pupil already has a login.',
  student_login_missing: 'This pupil does not have a login yet.',
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
