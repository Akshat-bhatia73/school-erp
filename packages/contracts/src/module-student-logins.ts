/**
 * Task 23 contracts: a pupil's own login.
 *
 * A pupil in Class 9 to 12 signs in with the school's login code, their
 * admission number and a password. The school creates the login when the
 * pupil is admitted or promoted into one of those classes and texts a
 * generated password to the primary guardian's phone; the pupil chooses their
 * own password the first time they sign in. Only the office switches a login
 * off, and it ends when the pupil leaves.
 */
import { z } from 'zod'
import { AllowedActions } from './responses.ts'
import { Reason, Timestamp, Version } from './common.ts'

/** The classes whose pupils get a login: Class 9 to 12 by the class number set in setup. */
export const STUDENT_LOGIN_LEVELS = { from: 9, to: 12 } as const

/**
 * The generated address a pupil's identity carries. Nothing is ever sent
 * there, and the email sign-in door refuses it: a pupil signs in only through
 * the school code and admission number.
 */
export const STUDENT_PLACEHOLDER_EMAIL_DOMAIN = 'student.invalid'

/** Sign-in by school code and admission number. The answer never says which of the three was wrong. */
export const StudentSignInRequest = z.strictObject({
  schoolCode: z.string().trim().min(1).max(64),
  admissionNumber: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
  sharedDevice: z.boolean().optional(),
})
export type StudentSignInRequest = z.infer<typeof StudentSignInRequest>

export const StudentSignInResponse = z.strictObject({
  signedIn: z.literal(true),
  /** The password came from the school: the pupil must choose their own before anything else. */
  passwordChangeRequired: z.boolean(),
})
export type StudentSignInResponse = z.infer<typeof StudentSignInResponse>

/**
 * none: the pupil has never had a login. active: they can sign in.
 * switched_off: the office turned it off; it can be turned on again.
 * ended: the pupil left, so the login is over; admitting them again starts a
 * new one.
 */
export const StudentLoginState = z.enum(['none', 'active', 'switched_off', 'ended'])
export type StudentLoginState = z.infer<typeof StudentLoginState>

/**
 * Why a pupil without an active login cannot be given one right now.
 * not_on_roll: the pupil has left or is suspended. not_senior: the pupil is not
 * enrolled this year in a class numbered 9 to 12. no_guardian_phone: the
 * primary guardian has no phone number to send the password to.
 */
export const StudentLoginBlocker = z.enum(['not_on_roll', 'not_senior', 'no_guardian_phone'])
export type StudentLoginBlocker = z.infer<typeof StudentLoginBlocker>

/** The office's view of one pupil's login. Never a password, never the generated address. */
export const StudentLoginView = z.strictObject({
  state: StudentLoginState,
  /** The admission number, which is what the pupil types as their username. */
  username: z.string().min(1).max(64),
  /** The school login code the pupil types with it. */
  schoolCode: z.string().min(1).max(64),
  /** Set when the pupil could be given a login (or have it back) and something stands in the way. */
  blocker: StudentLoginBlocker.optional(),
  /** The primary guardian's phone as a person may see it ("+91•••••••1234"), when there is one. */
  guardianPhoneMasked: z.string().max(40).optional(),
  /** True while the pupil still has the password the school sent. */
  passwordChangePending: z.boolean(),
  issuedAt: Timestamp.optional(),
  lastSignInAt: Timestamp.optional(),
  /** The membership's version, sent back as expectedVersion by switch off and switch on. */
  version: Version.optional(),
  /**
   * students.manage_login when the caller may act on this pupil's login. The
   * screen offers Issue, Reset password, Switch off and Switch on from the
   * state and the blocker.
   */
  allowedActions: AllowedActions,
})
export type StudentLoginView = z.infer<typeof StudentLoginView>

export const SwitchOffStudentLoginRequest = z.strictObject({
  expectedVersion: Version,
  reason: Reason.optional(),
})
export type SwitchOffStudentLoginRequest = z.infer<typeof SwitchOffStudentLoginRequest>

export const SwitchOnStudentLoginRequest = z.strictObject({ expectedVersion: Version })
export type SwitchOnStudentLoginRequest = z.infer<typeof SwitchOnStudentLoginRequest>

/**
 * The result of issuing every missing login in the current year at once.
 * Counts only: a text message went to each issued pupil's primary guardian.
 */
export const IssueStudentLoginsResult = z.strictObject({
  issued: z.number().int().nonnegative(),
  /** Pupils in Class 9 to 12 whose primary guardian has no phone number. */
  noGuardianPhone: z.number().int().nonnegative(),
  /** Pupils in Class 9 to 12 who already had a login, on or switched off. */
  alreadyHadLogin: z.number().int().nonnegative(),
  /** Pupils whose password text could not be sent; the office resets the password to try again. */
  textFailed: z.number().int().nonnegative(),
})
export type IssueStudentLoginsResult = z.infer<typeof IssueStudentLoginsResult>
