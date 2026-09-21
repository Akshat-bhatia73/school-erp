/**
 * Every identity, school and record the browser suite drives, named once.
 *
 * The ids are fixed so the seed and the tests agree without passing state
 * through a file. They sit in a `b0000000-…` block that nothing else in the
 * repository uses, so a browser run can never collide with the shared
 * fixtures (`1…`/`2…`) or with a record made by the API tests.
 */

export const PASSWORD = 'Browser-Pass!42'

export const SCHOOL_A = '10000000-0000-4000-8000-000000000001'
export const SCHOOL_B = '20000000-0000-4000-8000-000000000001'
export const SCHOOL_A_NAME = 'Fixture A'
export const SCHOOL_B_NAME = 'Fixture B'

/** School A's fixture year, grade and first section, which the seed reuses. */
export const YEAR_A = '10000000-0000-4000-8000-000000000060'
export const GRADE_A = '10000000-0000-4000-8000-000000000061'
export const SECTION_A1 = '10000000-0000-4000-8000-000000000062'

const b = (tail: string) => `b0000000-0000-4000-8000-${tail.padStart(12, '0')}`

export const ids = {
  subjectA: b('1'),
  sectionA2: b('2'),
  studentAlpha: b('3'),
  studentBeta: b('4'),

  // The promotion screen needs a second year and a pair of sections nobody
  // teaches, so moving those students never changes what another test sees.
  yearANext: b('20'),
  sectionPromoteFrom: b('21'),
  sectionPromoteTo: b('22'),
  studentPromoteOne: b('23'),
  studentPromoteTwo: b('24'),

  yearB: b('10'),
  gradeB: b('11'),
  sectionB1: b('12'),
  subjectB: b('13'),
  studentBravo: b('14'),
} as const

/** A person the suite signs in as, with everything a test needs to find them. */
export interface Person {
  /** Stable label, used in the seed and in failure messages. */
  key: string
  userId: string
  membershipId: string
  /** Every teaching person has a staff record; the owner's is unused. */
  staffId: string
  displayName: string
  email: string
  password: string
}

function person(key: string, tail: string, displayName: string): Person {
  return {
    key,
    userId: b(`1${tail}`),
    membershipId: b(`2${tail}`),
    staffId: b(`3${tail}`),
    displayName,
    email: `browser-${key}@example.test`,
    password: PASSWORD,
  }
}

/** Teaches section A only, so Alpha Learner is the whole of their roster. */
export const teacherAlpha = person('teacher-alpha', '00', 'Teacher Alpha')
/** Teaches section B only. Used as the "next identity" after a sign-out. */
export const teacherBeta = person('teacher-beta', '01', 'Teacher Beta')
/** Teaches section A. Suspended by the owner in the suspension test. */
export const teacherGamma = person('teacher-gamma', '02', 'Teacher Gamma')
/** Teaches in school A and in school B, so the tab can switch school. */
export const teacherDual = person('teacher-dual', '03', 'Teacher Dual')
/** Owner of school A. A privileged role, so a second factor is required. */
export const ownerA = person('owner', '04', 'Browser Owner')

/** The school B half of the two-school teacher. */
export const teacherDualSchoolB = {
  membershipId: b('290'),
  staffId: b('390'),
}

export const STUDENT_ALPHA = { id: ids.studentAlpha, name: 'Alpha Learner' }
export const STUDENT_BETA = { id: ids.studentBeta, name: 'Beta Learner' }
export const STUDENT_BRAVO = { id: ids.studentBravo, name: 'Bravo Learner' }
/** The two students the promotion screen decides about. */
export const STUDENT_PROMOTE_ONE = { id: ids.studentPromoteOne, name: 'Promote Learner' }
export const STUDENT_PROMOTE_TWO = { id: ids.studentPromoteTwo, name: 'Stayput Learner' }
/** The labels the section chips show for the promotion pair: class and section. */
export const PROMOTE_FROM_LABEL = 'Six - P'
export const PROMOTE_TO_LABEL = 'Six - Q'
export const NEXT_YEAR_NAME = '2027-28'

export const people = [
  teacherAlpha,
  teacherBeta,
  teacherGamma,
  teacherDual,
  ownerA,
] as const
