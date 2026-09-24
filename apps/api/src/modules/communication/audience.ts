import type { AudiencePreview, MessageAudienceKind, MessageRecipients, RecipientOutcome } from '@erp/contracts'
import type { TenantConnection } from '../shared/index.ts'
import { isDeliverableAddress, maskAddress, type DispatchDependencies } from './common.ts'

/** A message's audience as the database holds it (ids already validated to be in this school). */
export interface AudienceTarget {
  readonly kind: MessageAudienceKind
  readonly gradeId?: string
  /** The last class of a `grade_range`; gradeId is the first. */
  readonly toGradeId?: string
  readonly sectionId?: string
  readonly academicYearId?: string
  readonly studentId?: string
  readonly staffId?: string
  /** Who of a pupil audience it goes to; absent for the staff audiences and read as families. */
  readonly recipients?: MessageRecipients
}

/** One person the message is for, as materialiseMessage records them. */
export interface ResolvedRecipient {
  readonly guardianId?: string
  /** A pupil's own row: studentId is the pupil, no guardian and no staff member. */
  readonly isStudent?: boolean
  readonly staffId?: string
  readonly membershipId: string | null
  readonly studentId: string | null
  readonly outcome: RecipientOutcome
  readonly inApp: boolean
  readonly emailStatus: 'none' | 'pending'
  readonly emailMasked: string | null
}

interface GuardianRow {
  guardian_id: string
  guardian_email: string | null
  any_ok: boolean
  any_off: boolean
  portal: boolean
  student_id: string
  membership_id: string | null
  user_id: string | null
}

interface PupilRow {
  student_id: string
  membership_id: string | null
}

interface StaffRow {
  staff_id: string
  staff_email: string | null
  membership_id: string | null
  user_id: string | null
}

/**
 * Which pupils a family audience covers, as a predicate over `st` (students),
 * `en` (their open enrolment) and `sec` (its section). The pupils are always
 * the active, not anonymised ones with an enrolment nobody has left; a grade,
 * the school and one pupil are read in the current academic year.
 */
function pupilFilter(target: AudienceTarget, params: unknown[]): string {
  switch (target.kind) {
    case 'section':
      params.push(target.sectionId)
      return `en.section_id = $${params.length}::uuid`
    case 'grade':
      params.push(target.gradeId)
      return `sec.grade_id = $${params.length}::uuid AND en.academic_year_id = (SELECT id FROM audience_year)`
    case 'grade_range':
      params.push(target.gradeId, target.toGradeId)
      return `en.academic_year_id = (SELECT id FROM audience_year) AND sec.grade_id IN (
          SELECT gr.id FROM grades gr
           WHERE gr.school_id = st.school_id
             AND gr.sort_order BETWEEN (SELECT sort_order FROM grades WHERE school_id = st.school_id AND id = $${params.length - 1}::uuid)
                                   AND (SELECT sort_order FROM grades WHERE school_id = st.school_id AND id = $${params.length}::uuid))`
    case 'school':
      return `en.academic_year_id = (SELECT id FROM audience_year)`
    case 'pupil':
      params.push(target.studentId)
      return `st.id = $${params.length}::uuid AND en.academic_year_id = (SELECT id FROM audience_year)`
    default:
      throw new Error('Not a family audience.')
  }
}

/**
 * One row per guardian of the pupils in the audience. A (pupil, guardian)
 * pair lets the message through when the newest `communication` consent row
 * for exactly that pair is `given` and the office has not switched the
 * guardian's notifications off for that pupil. No consent row is no consent.
 */
async function familyRows(
  conn: TenantConnection,
  schoolId: string,
  target: AudienceTarget,
): Promise<GuardianRow[]> {
  const params: unknown[] = [schoolId]
  const filter = pupilFilter(target, params)
  const result = await conn.client.query<GuardianRow>(
    `WITH audience_year AS (
        SELECT id FROM academic_years WHERE school_id = $1 AND status = 'current'
         ORDER BY start_date DESC LIMIT 1
      ),
      audience_pupils AS (
        SELECT DISTINCT st.id AS student_id, st.first_name, st.last_name
          FROM students st
          JOIN enrollments en ON en.school_id = st.school_id AND en.student_id = st.id AND en.left_on IS NULL
          JOIN sections sec ON sec.school_id = en.school_id AND sec.id = en.section_id
         WHERE st.school_id = $1 AND st.status = 'active' AND st.anonymised_at IS NULL AND ${filter}
      ),
      audience_pairs AS (
        SELECT p.student_id, p.first_name, p.last_name, g.id AS guardian_id, g.email AS guardian_email,
               sg.receives_notifications,
               COALESCE((
                 SELECT c.status = 'given' FROM guardian_consents c
                  WHERE c.school_id = $1 AND c.student_id = p.student_id AND c.guardian_id = g.id
                    AND c.purpose = 'communication'
                  ORDER BY c.recorded_at DESC, c.id DESC LIMIT 1
               ), false) AS consent
          FROM audience_pupils p
          JOIN student_guardians sg ON sg.school_id = $1 AND sg.student_id = p.student_id
          JOIN guardians g ON g.school_id = sg.school_id AND g.id = sg.guardian_id AND g.anonymised_at IS NULL
      ),
      audience_guardians AS (
        SELECT guardian_id, max(guardian_email) AS guardian_email,
               bool_or(consent AND receives_notifications) AS any_ok,
               bool_or(consent AND NOT receives_notifications) AS any_off,
               bool_or(consent AND receives_notifications AND EXISTS (
                 SELECT 1 FROM guardian_student_access gsa
                  WHERE gsa.school_id = $1 AND gsa.guardian_id = audience_pairs.guardian_id
                    AND gsa.student_id = audience_pairs.student_id
                    AND gsa.status = 'approved' AND gsa.revoked_at IS NULL
               )) AS portal,
               (array_agg(student_id ORDER BY (consent AND receives_notifications) DESC,
                          first_name, last_name, student_id))[1] AS student_id
          FROM audience_pairs
         GROUP BY guardian_id
      )
      SELECT ag.guardian_id, ag.guardian_email, ag.any_ok, ag.any_off, ag.portal, ag.student_id,
             m.id AS membership_id, m.user_id
        FROM audience_guardians ag
        LEFT JOIN LATERAL (
          SELECT sm.id, sm.user_id
            FROM membership_guardian_links mgl
            JOIN school_memberships sm ON sm.school_id = mgl.school_id AND sm.id = mgl.membership_id
             AND sm.status = 'active'
           WHERE mgl.school_id = $1 AND mgl.guardian_id = ag.guardian_id
           ORDER BY sm.created_at, sm.id
           LIMIT 1
        ) m ON true
       ORDER BY ag.guardian_id`,
    params,
  )
  return result.rows
}

/**
 * One row per pupil in the audience, with the pupil's own membership when
 * their login is on (a `student` membership that is `active`).
 */
async function pupilRows(conn: TenantConnection, schoolId: string, target: AudienceTarget): Promise<PupilRow[]> {
  const params: unknown[] = [schoolId]
  const filter = pupilFilter(target, params)
  const result = await conn.client.query<PupilRow>(
    `WITH audience_year AS (
        SELECT id FROM academic_years WHERE school_id = $1 AND status = 'current'
         ORDER BY start_date DESC LIMIT 1
      ),
      audience_pupils AS (
        SELECT DISTINCT st.id AS student_id
          FROM students st
          JOIN enrollments en ON en.school_id = st.school_id AND en.student_id = st.id AND en.left_on IS NULL
          JOIN sections sec ON sec.school_id = en.school_id AND sec.id = en.section_id
         WHERE st.school_id = $1 AND st.status = 'active' AND st.anonymised_at IS NULL AND ${filter}
      )
      SELECT p.student_id, sm.id AS membership_id
        FROM audience_pupils p
        LEFT JOIN membership_student_links msl ON msl.school_id = $1 AND msl.student_id = p.student_id
        LEFT JOIN school_memberships sm ON sm.school_id = msl.school_id AND sm.id = msl.membership_id
         AND sm.kind = 'student' AND sm.status = 'active'
       ORDER BY p.student_id`,
    params,
  )
  return result.rows
}

/** Every working staff member (or the one of a birthday), with their active membership if any. */
async function staffRows(
  conn: TenantConnection,
  schoolId: string,
  target: AudienceTarget,
): Promise<StaffRow[]> {
  const params: unknown[] = [schoolId]
  let filter = ''
  if (target.kind === 'staff_member') {
    params.push(target.staffId)
    filter = `AND s.id = $2::uuid`
  }
  const result = await conn.client.query<StaffRow>(
    `SELECT s.id AS staff_id, s.email AS staff_email, m.id AS membership_id, m.user_id
       FROM staff s
       LEFT JOIN LATERAL (
         SELECT sm.id, sm.user_id
           FROM membership_staff_links msl
           JOIN school_memberships sm ON sm.school_id = msl.school_id AND sm.id = msl.membership_id
            AND sm.status = 'active'
          WHERE msl.school_id = s.school_id AND msl.staff_id = s.id
          ORDER BY sm.created_at, sm.id
          LIMIT 1
       ) m ON true
      WHERE s.school_id = $1 AND s.status IN ('active', 'on_leave') AND s.anonymised_at IS NULL ${filter}
      ORDER BY s.id`,
    params,
  )
  return result.rows
}

/**
 * The sign-in email of each user who needs one. auth_user is readable by the
 * auth credential alone, so this is one query on that pool for all of them.
 */
async function signInEmails(
  deps: DispatchDependencies,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const emails = new Map<string, string>()
  if (userIds.length === 0) return emails
  const result = await deps.pools.auth.query<{ id: string; email: string | null }>(
    'SELECT id, email FROM auth_user WHERE id = ANY($1::uuid[])',
    [[...new Set(userIds)]],
  )
  for (const row of result.rows) if (row.email) emails.set(row.id, row.email)
  return emails
}

/** The person's own address when it can receive mail, else their sign-in address when that can. */
function pickAddress(own: string | null, userId: string | null, emails: ReadonlyMap<string, string>): string | null {
  if (isDeliverableAddress(own)) return own
  const signIn = userId ? emails.get(userId) : undefined
  return isDeliverableAddress(signIn) ? signIn : null
}

function reached(
  base: { guardianId?: string; staffId?: string; studentId: string | null },
  membershipId: string | null,
  inApp: boolean,
  address: string | null,
): ResolvedRecipient {
  if (!inApp && address === null) {
    return { ...base, membershipId, outcome: 'no_contact', inApp: false, emailStatus: 'none', emailMasked: null }
  }
  return {
    ...base,
    membershipId,
    outcome: 'delivered',
    inApp,
    emailStatus: address === null ? 'none' : 'pending',
    emailMasked: address === null ? null : maskAddress(address),
  }
}

/**
 * Everybody a message to this audience goes to, one entry per person, worked
 * out now. Set-based: one query for the people, one on the auth pool for the
 * sign-in addresses, never one query per pupil.
 */
export async function resolveRecipients(
  conn: TenantConnection,
  deps: DispatchDependencies,
  schoolId: string,
  target: AudienceTarget,
): Promise<ResolvedRecipient[]> {
  if (target.kind === 'staff' || target.kind === 'staff_member') {
    const rows = await staffRows(conn, schoolId, target)
    const emails = await signInEmails(
      deps,
      rows.filter((row) => !isDeliverableAddress(row.staff_email) && row.user_id).map((row) => row.user_id as string),
    )
    return rows.map((row) =>
      reached(
        { staffId: row.staff_id, studentId: null },
        row.membership_id,
        row.membership_id !== null,
        pickAddress(row.staff_email, row.user_id, emails),
      ),
    )
  }

  const recipients = target.recipients ?? 'families'
  // The pupils' own rows: in the app only, no consent needed, never an email.
  const pupils: ResolvedRecipient[] =
    recipients === 'families'
      ? []
      : (await pupilRows(conn, schoolId, target)).map((row) => ({
          isStudent: true,
          studentId: row.student_id,
          membershipId: row.membership_id,
          outcome: row.membership_id === null ? 'no_contact' : 'delivered',
          inApp: row.membership_id !== null,
          emailStatus: 'none',
          emailMasked: null,
        }))
  if (recipients === 'students') return pupils

  const rows = await familyRows(conn, schoolId, target)
  const emails = await signInEmails(
    deps,
    rows
      .filter((row) => row.any_ok && !isDeliverableAddress(row.guardian_email) && row.user_id)
      .map((row) => row.user_id as string),
  )
  const families = rows.map((row): ResolvedRecipient => {
    const base = { guardianId: row.guardian_id, studentId: row.student_id }
    if (!row.any_ok) {
      // Held back: nothing goes, by app or by email.
      return {
        ...base,
        membershipId: row.membership_id,
        outcome: row.any_off ? 'not_receiving' : 'no_consent',
        inApp: false,
        emailStatus: 'none',
        emailMasked: null,
      }
    }
    const inApp = row.membership_id !== null && row.portal
    return reached(base, row.membership_id, inApp, pickAddress(row.guardian_email, row.user_id, emails))
  })
  return [...families, ...pupils]
}

/** The counts a send now would record, without recording anything. */
export async function previewAudience(
  conn: TenantConnection,
  deps: DispatchDependencies,
  schoolId: string,
  target: AudienceTarget,
): Promise<Omit<AudiencePreview, 'audience'>> {
  const people = await resolveRecipients(conn, deps, schoolId, target)
  const count = (test: (person: ResolvedRecipient) => boolean) => people.filter(test).length
  return {
    recipients: people.length,
    pupils: count((person) => person.isStudent === true),
    pupilsInApp: count((person) => person.isStudent === true && person.inApp),
    delivered: count((person) => person.outcome === 'delivered'),
    noConsent: count((person) => person.outcome === 'no_consent'),
    notReceiving: count((person) => person.outcome === 'not_receiving'),
    noContact: count((person) => person.outcome === 'no_contact'),
    inApp: count((person) => person.inApp),
    email: count((person) => person.emailStatus === 'pending'),
  }
}
