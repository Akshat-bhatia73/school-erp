import type { PoolClient } from 'pg'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

import { AccessScope, PermissionKey, ResourceAccessRule, RoleKey } from '@erp/contracts'
import type { ResourceAccessRule as ResourceAccessRuleType, RoleKey as RoleKeyType } from '@erp/contracts'
import type { PolicyGrant, PolicySnapshot, RequestContext, ResourceReference } from '@erp/contracts/server'

import type { RelationshipFacts, ResourceFacts } from './policy.ts'

/**
 * The connection handed to a loader is always the one opened by
 * withTenantTransaction, so every statement below also runs under the tenant
 * row level security policies. The explicit school_id predicates are a second
 * barrier, not the only one.
 */
export interface AuthzConnection {
  readonly client: PoolClient
  readonly db: NodePgDatabase
}

export interface MembershipState {
  readonly id: string
  readonly status: 'active' | 'suspended' | 'removed'
  readonly kind: 'adult' | 'student'
  readonly accessVersion: number
  readonly version: number
  readonly userId: string
}

interface MembershipRow {
  id: string
  user_id: string
  status: 'active' | 'suspended' | 'removed'
  kind: 'adult' | 'student'
  access_version: number
  version: number
}

export async function loadMembershipState(
  conn: AuthzConnection,
  context: RequestContext,
): Promise<MembershipState | null> {
  return loadMembershipStateById(conn, context.schoolId, context.membershipId)
}

export async function loadMembershipStateById(
  conn: AuthzConnection,
  schoolId: string,
  membershipId: string,
): Promise<MembershipState | null> {
  const result = await conn.client.query<MembershipRow>(
    `SELECT id, user_id, status, kind, access_version, version
       FROM school_memberships
      WHERE school_id = $1 AND id = $2`,
    [schoolId, membershipId],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    kind: row.kind,
    accessVersion: Number(row.access_version),
    version: Number(row.version),
  }
}

export async function loadRoleKeys(
  conn: AuthzConnection,
  schoolId: string,
  membershipId: string,
): Promise<readonly RoleKeyType[]> {
  const result = await conn.client.query<{ key: string }>(
    `SELECT r.key
       FROM membership_roles mr
       JOIN roles r ON r.school_id = mr.school_id AND r.id = mr.role_id
      WHERE mr.school_id = $1 AND mr.membership_id = $2`,
    [schoolId, membershipId],
  )
  const keys: RoleKeyType[] = []
  for (const row of result.rows) {
    const parsed = RoleKey.safeParse(row.key)
    // A role key the code does not know about cannot grant anything.
    if (parsed.success && !keys.includes(parsed.data)) keys.push(parsed.data)
  }
  return keys
}

export async function loadPolicySnapshot(
  conn: AuthzConnection,
  context: RequestContext,
): Promise<PolicySnapshot> {
  return loadPolicySnapshotFor(conn, context.schoolId, context.membershipId)
}

export async function loadPolicySnapshotFor(
  conn: AuthzConnection,
  schoolId: string,
  membershipId: string,
): Promise<PolicySnapshot> {
  const state = await loadMembershipStateById(conn, schoolId, membershipId)
  const grants = await loadGrants(conn, schoolId, membershipId)
  const exceptions = await loadExceptions(conn, schoolId, membershipId)
  return { accessVersion: state?.accessVersion ?? 0, grants, exceptions }
}

async function loadGrants(
  conn: AuthzConnection,
  schoolId: string,
  membershipId: string,
): Promise<readonly PolicyGrant[]> {
  const result = await conn.client.query<{ permission: string; scope: string }>(
    `SELECT DISTINCT rp.permission, rp.scope
       FROM membership_roles mr
       JOIN role_permissions rp ON rp.school_id = mr.school_id AND rp.role_id = mr.role_id
      WHERE mr.school_id = $1 AND mr.membership_id = $2`,
    [schoolId, membershipId],
  )
  const grants: PolicyGrant[] = []
  for (const row of result.rows) {
    const permission = PermissionKey.safeParse(row.permission)
    const scope = AccessScope.safeParse(row.scope)
    // Rows written by an older or newer deployment must not widen access.
    if (!permission.success || !scope.success) continue
    if (grants.some((g) => g.permission === permission.data && g.scope === scope.data)) continue
    grants.push({ permission: permission.data, scope: scope.data })
  }
  return grants
}

interface RuleRow {
  id: string
  school_id: string
  membership_id: string
  permission: string
  effect: 'allow' | 'deny'
  target_type: string
  academic_year_id: string | null
  section_id: string | null
  student_id: string | null
  staff_id: string | null
  document_id: string | null
  effective_from: Date
  expires_at: Date | null
  revoked_at: Date | null
  reason: string
  author_membership_id: string
  version: number
}

function candidateFromRow(row: RuleRow): unknown {
  return {
    id: row.id,
    schoolId: row.school_id,
    membershipId: row.membership_id,
    permission: row.permission,
    effect: row.effect,
    target: targetFromRow(row),
    validFrom: row.effective_from.toISOString(),
    expiresAt: row.expires_at === null ? null : row.expires_at.toISOString(),
    revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
    reason: row.reason,
    createdByMembershipId: row.author_membership_id,
    version: Number(row.version),
  }
}

function targetFromRow(row: RuleRow): unknown {
  switch (row.target_type) {
    case 'school':
      return { kind: 'school' }
    case 'section':
      return { kind: 'section', sectionId: row.section_id, academicYearId: row.academic_year_id }
    case 'student':
      return { kind: 'student', studentId: row.student_id }
    case 'staff':
      return { kind: 'staff', staffId: row.staff_id }
    case 'document':
      return { kind: 'document', documentId: row.document_id }
    default:
      return { kind: row.target_type }
  }
}

async function loadExceptions(
  conn: AuthzConnection,
  schoolId: string,
  membershipId: string,
): Promise<readonly ResourceAccessRuleType[]> {
  const result = await conn.client.query<RuleRow>(
    `SELECT id, school_id, membership_id, permission, effect, target_type, academic_year_id,
            section_id, student_id, staff_id, document_id, effective_from, expires_at,
            revoked_at, reason, author_membership_id, version
       FROM resource_access_rules
      WHERE school_id = $1 AND membership_id = $2`,
    [schoolId, membershipId],
  )
  const rules: ResourceAccessRuleType[] = []
  for (const row of result.rows) {
    const candidate = candidateFromRow(row)
    const parsed = ResourceAccessRule.safeParse(candidate)
    if (parsed.success) {
      rules.push(parsed.data)
      continue
    }
    // A malformed allow is dropped, but a malformed deny is still honoured:
    // failing open on a deny would widen access, failing closed never does.
    if (row.effect === 'deny' && PermissionKey.safeParse(row.permission).success) {
      rules.push(candidate as ResourceAccessRuleType)
    }
  }
  return rules
}

export async function loadRelationshipFacts(
  conn: AuthzConnection,
  context: RequestContext,
): Promise<RelationshipFacts> {
  return loadRelationshipFactsFor(conn, context.schoolId, context.membershipId, context.now)
}

export async function loadRelationshipFactsFor(
  conn: AuthzConnection,
  schoolId: string,
  membershipId: string,
  now: string,
): Promise<RelationshipFacts> {
  const staffLink = await conn.client.query<{ staff_id: string }>(
    `SELECT staff_id FROM membership_staff_links WHERE school_id = $1 AND membership_id = $2`,
    [schoolId, membershipId],
  )
  const selfStaffId = staffLink.rows[0]?.staff_id ?? null

  const assignments: { sectionId: string; subjectId: string; academicYearId: string }[] = []
  if (selfStaffId !== null) {
    const rows = await conn.client.query<{
      section_id: string
      subject_id: string
      academic_year_id: string
    }>(
      `SELECT section_id, subject_id, academic_year_id
         FROM teaching_assignments
        WHERE school_id = $1 AND staff_id = $2
          AND effective_from <= ($3::timestamptz)::date
          AND (effective_to IS NULL OR effective_to >= ($3::timestamptz)::date)`,
      [schoolId, selfStaffId, now],
    )
    for (const row of rows.rows) {
      assignments.push({
        sectionId: row.section_id,
        subjectId: row.subject_id,
        academicYearId: row.academic_year_id,
      })
    }
  }

  // Being the class teacher of a section is a relationship of its own: the
  // person looks after that class whether or not they teach a subject in it.
  // A closed year is history, so it no longer counts.
  const classTeacherSections: { sectionId: string; academicYearId: string }[] = []
  if (selfStaffId !== null) {
    const rows = await conn.client.query<{ id: string; academic_year_id: string }>(
      `SELECT s.id, s.academic_year_id
         FROM sections s
         JOIN academic_years y ON y.school_id = s.school_id AND y.id = s.academic_year_id
        WHERE s.school_id = $1 AND s.class_teacher_staff_id = $2 AND y.status <> 'closed'`,
      [schoolId, selfStaffId],
    )
    for (const row of rows.rows) {
      classTeacherSections.push({ sectionId: row.id, academicYearId: row.academic_year_id })
    }
  }

  const children = await conn.client.query<{ student_id: string }>(
    `SELECT gsa.student_id
       FROM membership_guardian_links mgl
       JOIN guardian_student_access gsa
         ON gsa.school_id = mgl.school_id AND gsa.guardian_id = mgl.guardian_id
      WHERE mgl.school_id = $1 AND mgl.membership_id = $2
        AND gsa.status = 'approved' AND gsa.revoked_at IS NULL`,
    [schoolId, membershipId],
  )

  return {
    selfStaffId,
    assignments,
    classTeacherSections,
    ownChildStudentIds: [...new Set(children.rows.map((row) => row.student_id))],
    membershipId,
  }
}

/**
 * The tables an existence check may read. The name is never a free string, so
 * nothing a caller supplies can reach the query text.
 */
type ExistenceTable =
  | 'academic_years'
  | 'bell_schedules'
  | 'grades'
  | 'guardians'
  | 'holidays'
  | 'resource_access_rules'
  | 'roles'
  | 'school_invitations'
  | 'school_memberships'
  | 'staff'
  | 'students'
  | 'subjects'

const EXISTENCE_QUERIES: Record<ExistenceTable, string> = {
  academic_years: `SELECT id FROM academic_years WHERE school_id = $1 AND id = $2`,
  bell_schedules: `SELECT id FROM bell_schedules WHERE school_id = $1 AND id = $2`,
  grades: `SELECT id FROM grades WHERE school_id = $1 AND id = $2`,
  guardians: `SELECT id FROM guardians WHERE school_id = $1 AND id = $2`,
  holidays: `SELECT id FROM holidays WHERE school_id = $1 AND id = $2`,
  resource_access_rules: `SELECT id FROM resource_access_rules WHERE school_id = $1 AND id = $2`,
  roles: `SELECT id FROM roles WHERE school_id = $1 AND id = $2`,
  school_invitations: `SELECT id FROM school_invitations WHERE school_id = $1 AND id = $2`,
  school_memberships: `SELECT id FROM school_memberships WHERE school_id = $1 AND id = $2`,
  staff: `SELECT id FROM staff WHERE school_id = $1 AND id = $2`,
  students: `SELECT id FROM students WHERE school_id = $1 AND id = $2`,
  subjects: `SELECT id FROM subjects WHERE school_id = $1 AND id = $2`,
}

/** Returns true when a single row matches, so callers can prove existence. */
async function exists(
  conn: AuthzConnection,
  table: ExistenceTable,
  schoolId: string,
  id: string,
): Promise<boolean> {
  const result = await conn.client.query<{ id: string }>(EXISTENCE_QUERIES[table], [schoolId, id])
  return result.rows.length > 0
}

async function currentSectionsOfStudent(
  conn: AuthzConnection,
  schoolId: string,
  studentId: string,
): Promise<{ sectionIds: string[]; academicYearId?: string }> {
  const result = await conn.client.query<{ section_id: string; academic_year_id: string }>(
    `SELECT section_id, academic_year_id
       FROM enrollments
      WHERE school_id = $1 AND student_id = $2 AND left_on IS NULL`,
    [schoolId, studentId],
  )
  const sectionIds = result.rows.map((row) => row.section_id)
  const years = new Set(result.rows.map((row) => row.academic_year_id))
  // A section belongs to exactly one year, so the year is only an extra guard.
  // It is set when it is unambiguous and left out when the student has current
  // enrollments in more than one year.
  const academicYearId = years.size === 1 ? [...years][0] : undefined
  return academicYearId === undefined ? { sectionIds } : { sectionIds, academicYearId }
}

type ChildScope =
  | { readonly by: 'section'; readonly sectionId: string }
  | { readonly by: 'grade'; readonly gradeId: string }
  | { readonly by: 'subject'; readonly subjectId: string }

/**
 * The id of one of the caller's own children currently enrolled behind this
 * resource. It lets the own_children scope answer for class, section and
 * subject records, which are shared rows rather than a single child's row.
 */
async function ownChildBehind(
  conn: AuthzConnection,
  schoolId: string,
  membershipId: string,
  scope: ChildScope,
): Promise<string | undefined> {
  const base = `
    SELECT e.student_id
      FROM enrollments e
      JOIN sections sec ON sec.school_id = e.school_id AND sec.id = e.section_id
      JOIN membership_guardian_links mgl ON mgl.school_id = e.school_id AND mgl.membership_id = $2
      JOIN guardian_student_access gsa
        ON gsa.school_id = e.school_id AND gsa.guardian_id = mgl.guardian_id
       AND gsa.student_id = e.student_id AND gsa.status = 'approved' AND gsa.revoked_at IS NULL
     WHERE e.school_id = $1 AND e.left_on IS NULL`
  const filter =
    scope.by === 'section'
      ? ` AND e.section_id = $3`
      : scope.by === 'grade'
        ? ` AND sec.grade_id = $3`
        : ` AND EXISTS (SELECT 1 FROM grade_subjects gs
                          WHERE gs.school_id = e.school_id AND gs.grade_id = sec.grade_id
                            AND gs.academic_year_id = e.academic_year_id AND gs.subject_id = $3)`
  const id = scope.by === 'section' ? scope.sectionId : scope.by === 'grade' ? scope.gradeId : scope.subjectId
  const result = await conn.client.query<{ student_id: string }>(`${base}${filter} LIMIT 1`, [
    schoolId,
    membershipId,
    id,
  ])
  return result.rows[0]?.student_id
}

function facts(resource: ResourceReference, extra: Omit<ResourceFacts, 'resourceType' | 'id'>): ResourceFacts {
  return { resourceType: resource.resourceType, id: resource.id, ...extra }
}

export async function loadResourceFacts(
  conn: AuthzConnection,
  context: RequestContext,
  resource: ResourceReference,
): Promise<ResourceFacts | null> {
  const schoolId = context.schoolId
  const id = resource.id
  // A resource in another school is never loaded, so it can never be revealed.
  if (resource.schoolId !== schoolId) return null

  switch (resource.resourceType) {
    case 'school':
    case 'school_ownership': {
      if (id !== schoolId) return null
      const row = await conn.client.query(`SELECT id FROM schools WHERE id = $1`, [schoolId])
      return row.rows.length === 0 ? null : facts(resource, {})
    }
    case 'student': {
      if (!(await exists(conn, 'students', schoolId, id))) return null
      const sections = await currentSectionsOfStudent(conn, schoolId, id)
      return facts(resource, { studentId: id, ...sections })
    }
    case 'guardian': {
      if (!(await exists(conn, 'guardians', schoolId, id))) return null
      return facts(resource, {})
    }
    case 'student_document': {
      const row = await conn.client.query<{ student_id: string }>(
        `SELECT student_id FROM student_documents WHERE school_id = $1 AND id = $2`,
        [schoolId, id],
      )
      const studentId = row.rows[0]?.student_id
      if (studentId === undefined) return null
      const sections = await currentSectionsOfStudent(conn, schoolId, studentId)
      return facts(resource, { studentId, ...sections })
    }
    case 'enrollment': {
      const row = await conn.client.query<{
        student_id: string
        section_id: string
        academic_year_id: string
      }>(
        `SELECT student_id, section_id, academic_year_id FROM enrollments WHERE school_id = $1 AND id = $2`,
        [schoolId, id],
      )
      const found = row.rows[0]
      if (!found) return null
      return facts(resource, {
        studentId: found.student_id,
        sectionIds: [found.section_id],
        academicYearId: found.academic_year_id,
      })
    }
    case 'section': {
      const row = await conn.client.query<{ academic_year_id: string }>(
        `SELECT academic_year_id FROM sections WHERE school_id = $1 AND id = $2`,
        [schoolId, id],
      )
      const found = row.rows[0]
      if (!found) return null
      const child = await ownChildBehind(conn, schoolId, context.membershipId, { by: 'section', sectionId: id })
      return facts(resource, {
        sectionIds: [id],
        academicYearId: found.academic_year_id,
        ...(child === undefined ? {} : { studentId: child }),
      })
    }
    case 'grade': {
      if (!(await exists(conn, 'grades', schoolId, id))) return null
      const sections = await conn.client.query<{ id: string }>(
        `SELECT id FROM sections WHERE school_id = $1 AND grade_id = $2`,
        [schoolId, id],
      )
      const child = await ownChildBehind(conn, schoolId, context.membershipId, { by: 'grade', gradeId: id })
      return facts(resource, {
        sectionIds: sections.rows.map((row) => row.id),
        ...(child === undefined ? {} : { studentId: child }),
      })
    }
    case 'subject': {
      if (!(await exists(conn, 'subjects', schoolId, id))) return null
      const child = await ownChildBehind(conn, schoolId, context.membershipId, { by: 'subject', subjectId: id })
      const assigned = await conn.client.query<{ section_id: string; academic_year_id: string }>(
        `SELECT DISTINCT section_id, academic_year_id FROM teaching_assignments
          WHERE school_id = $1 AND subject_id = $2`,
        [schoolId, id],
      )
      return facts(resource, {
        subjectIds: [id],
        sectionIds: assigned.rows.map((row) => row.section_id),
        ...(child === undefined ? {} : { studentId: child }),
      })
    }
    case 'staff': {
      if (!(await exists(conn, 'staff', schoolId, id))) return null
      return facts(resource, { staffId: id })
    }
    case 'teaching_assignment': {
      const row = await conn.client.query<{
        staff_id: string
        section_id: string
        subject_id: string
        academic_year_id: string
      }>(
        `SELECT staff_id, section_id, subject_id, academic_year_id
           FROM teaching_assignments WHERE school_id = $1 AND id = $2`,
        [schoolId, id],
      )
      const found = row.rows[0]
      if (!found) return null
      return facts(resource, {
        staffId: found.staff_id,
        sectionIds: [found.section_id],
        subjectIds: [found.subject_id],
        academicYearId: found.academic_year_id,
      })
    }
    case 'timetable': {
      const row = await conn.client.query<{
        section_id: string
        subject_id: string
        academic_year_id: string
        staff_id: string | null
      }>(
        `SELECT section_id, subject_id, academic_year_id, staff_id
           FROM timetable_entries WHERE school_id = $1 AND id = $2`,
        [schoolId, id],
      )
      const found = row.rows[0]
      if (!found) return null
      const child = await ownChildBehind(conn, schoolId, context.membershipId, {
        by: 'section',
        sectionId: found.section_id,
      })
      return facts(resource, {
        sectionIds: [found.section_id],
        subjectIds: [found.subject_id],
        academicYearId: found.academic_year_id,
        ...(found.staff_id === null ? {} : { staffId: found.staff_id }),
        ...(child === undefined ? {} : { studentId: child }),
      })
    }
    case 'bell_schedule': {
      if (!(await exists(conn, 'bell_schedules', schoolId, id))) return null
      return facts(resource, {})
    }
    case 'substitution': {
      const row = await conn.client.query<{
        section_id: string
        subject_id: string
        absent_staff_id: string
      }>(
        `SELECT section_id, subject_id, absent_staff_id FROM substitutions WHERE school_id = $1 AND id = $2`,
        [schoolId, id],
      )
      const found = row.rows[0]
      if (!found) return null
      // The row is shared by the class, so a parent reaches it through the
      // section a child currently sits in, exactly as the list predicate does.
      const child = await ownChildBehind(conn, schoolId, context.membershipId, {
        by: 'section',
        sectionId: found.section_id,
      })
      return facts(resource, {
        sectionIds: [found.section_id],
        subjectIds: [found.subject_id],
        staffId: found.absent_staff_id,
        ...(child === undefined ? {} : { studentId: child }),
      })
    }
    case 'academic_year': {
      if (!(await exists(conn, 'academic_years', schoolId, id))) return null
      return facts(resource, { academicYearId: id })
    }
    case 'holiday': {
      if (!(await exists(conn, 'holidays', schoolId, id))) return null
      return facts(resource, {})
    }
    case 'membership':
    case 'role_assignment':
    case 'access_decision': {
      if (!(await exists(conn, 'school_memberships', schoolId, id))) return null
      return facts(resource, {})
    }
    case 'invitation': {
      if (!(await exists(conn, 'school_invitations', schoolId, id))) return null
      return facts(resource, {})
    }
    case 'role': {
      if (!(await exists(conn, 'roles', schoolId, id))) return null
      return facts(resource, {})
    }
    case 'access_exception': {
      if (!(await exists(conn, 'resource_access_rules', schoolId, id))) return null
      return facts(resource, {})
    }
    case 'audit_event': {
      const event = await conn.client.query<{ action: string }>(
        `SELECT action FROM audit_events WHERE school_id = $1 AND id = $2`,
        [schoolId, id],
      )
      const action = event.rows[0]?.action
      if (action === undefined) return null
      return facts(resource, { action })
    }
    case 'fee': {
      // One resource type, several tables. The id is looked for in each: a
      // pupil's own id stands for their fee account, a ledger row, an optional
      // fee and a concession belong to a pupil, and a head or a structure
      // belongs to the school. Ids are random uuids, so at most one matches.
      const row = await conn.client.query<{ student_id: string | null; academic_year_id: string | null }>(
        `SELECT id AS student_id, NULL::uuid AS academic_year_id FROM students WHERE school_id = $1 AND id = $2
         UNION ALL
         SELECT student_id, academic_year_id FROM fee_receipts WHERE school_id = $1 AND id = $2
         UNION ALL
         SELECT student_id, academic_year_id FROM fee_student_heads WHERE school_id = $1 AND id = $2
         UNION ALL
         SELECT student_id, academic_year_id FROM fee_concessions WHERE school_id = $1 AND id = $2
         UNION ALL
         SELECT NULL::uuid, NULL::uuid FROM fee_heads WHERE school_id = $1 AND id = $2
         UNION ALL
         SELECT NULL::uuid, academic_year_id FROM fee_structures WHERE school_id = $1 AND id = $2
         LIMIT 1`,
        [schoolId, id],
      )
      const found = row.rows[0]
      if (!found) return null
      return facts(resource, {
        ...(found.student_id === null ? {} : { studentId: found.student_id }),
        ...(found.academic_year_id === null ? {} : { academicYearId: found.academic_year_id }),
      })
    }
    case 'attendance': {
      // One resource type, three faces. The id is looked for as a mark, as a
      // section (the roster being read or marked) and as a pupil (the month
      // being read). Ids are random uuids, so at most one matches. A mark
      // names its pupil, its section and its year; a section names itself and
      // its year, plus a child of the caller currently sitting in it; a pupil
      // names themselves and their current sections, exactly as a student.
      const row = await conn.client.query<{
        face: string
        student_id: string | null
        section_id: string | null
        academic_year_id: string | null
      }>(
        `SELECT 'entry' AS face, student_id, section_id, academic_year_id
           FROM attendance_entries WHERE school_id = $1 AND id = $2
         UNION ALL
         SELECT 'roster', NULL::uuid, id, academic_year_id FROM sections WHERE school_id = $1 AND id = $2
         UNION ALL
         SELECT 'pupil', id, NULL::uuid, NULL::uuid FROM students WHERE school_id = $1 AND id = $2
         LIMIT 1`,
        [schoolId, id],
      )
      const found = row.rows[0]
      if (!found) return null
      if (found.face === 'pupil' && found.student_id !== null) {
        const sections = await currentSectionsOfStudent(conn, schoolId, found.student_id)
        return facts(resource, { studentId: found.student_id, ...sections })
      }
      if (found.face === 'roster' && found.section_id !== null && found.academic_year_id !== null) {
        const child = await ownChildBehind(conn, schoolId, context.membershipId, {
          by: 'section',
          sectionId: found.section_id,
        })
        return facts(resource, {
          sectionIds: [found.section_id],
          academicYearId: found.academic_year_id,
          ...(child === undefined ? {} : { studentId: child }),
        })
      }
      return facts(resource, {
        ...(found.student_id === null ? {} : { studentId: found.student_id }),
        ...(found.section_id === null ? {} : { sectionIds: [found.section_id] }),
        ...(found.academic_year_id === null ? {} : { academicYearId: found.academic_year_id }),
      })
    }
    case 'staff_attendance': {
      // Two faces: a mark, which names its staff member, and the staff member
      // themselves, whose row or month is being read.
      const row = await conn.client.query<{ staff_id: string }>(
        `SELECT staff_id FROM staff_attendance_entries WHERE school_id = $1 AND id = $2
         UNION ALL
         SELECT id FROM staff WHERE school_id = $1 AND id = $2
         LIMIT 1`,
        [schoolId, id],
      )
      const found = row.rows[0]
      if (!found) return null
      return facts(resource, { staffId: found.staff_id })
    }
    case 'exam': {
      // One resource type, four faces: the exam's own row, a paper, a mark
      // and a pupil. Ids are random uuids, so at most one matches. A mark
      // says whether it is published exactly as the list predicate works it
      // out: a publication of its exam for its section at least as new as
      // the mark. A pupil carries no marks of its own, so it is "published".
      const row = await conn.client.query<{
        face: string
        student_id: string | null
        section_id: string | null
        academic_year_id: string | null
        subject_id: string | null
        published: boolean | null
      }>(
        `SELECT 'exam' AS face, NULL::uuid AS student_id, NULL::uuid AS section_id, academic_year_id,
                NULL::uuid AS subject_id, NULL::boolean AS published
           FROM exams WHERE school_id = $1 AND id = $2
         UNION ALL
         SELECT 'paper', NULL::uuid, section_id, academic_year_id, subject_id, NULL::boolean
           FROM exam_papers WHERE school_id = $1 AND id = $2
         UNION ALL
         SELECT 'mark', m.student_id, m.section_id, m.academic_year_id, m.subject_id,
                EXISTS (SELECT 1 FROM exam_publications pub
                         WHERE pub.school_id = m.school_id AND pub.exam_id = m.exam_id
                           AND pub.section_id = m.section_id AND pub.published_at >= m.recorded_at)
           FROM exam_marks m WHERE m.school_id = $1 AND m.id = $2
         UNION ALL
         SELECT 'pupil', id, NULL::uuid, NULL::uuid, NULL::uuid, NULL::boolean
           FROM students WHERE school_id = $1 AND id = $2
         LIMIT 1`,
        [schoolId, id],
      )
      const found = row.rows[0]
      if (!found) return null
      if (found.face === 'pupil' && found.student_id !== null) {
        const sections = await currentSectionsOfStudent(conn, schoolId, found.student_id)
        return facts(resource, { studentId: found.student_id, ...sections, published: true })
      }
      if (found.face === 'exam') {
        return facts(resource, found.academic_year_id === null ? {} : { academicYearId: found.academic_year_id })
      }
      return facts(resource, {
        ...(found.student_id === null ? {} : { studentId: found.student_id }),
        ...(found.section_id === null ? {} : { sectionIds: [found.section_id] }),
        ...(found.subject_id === null ? {} : { subjectIds: [found.subject_id] }),
        ...(found.academic_year_id === null ? {} : { academicYearId: found.academic_year_id }),
        published: found.published === true,
      })
    }
    case 'report_card': {
      // Four faces: a published version (published by being one), the class
      // teacher's working entry (never published), the section whose cards
      // are prepared, and the pupil whose cards are listed.
      const row = await conn.client.query<{
        face: string
        student_id: string | null
        section_id: string | null
        academic_year_id: string | null
      }>(
        `SELECT 'card' AS face, student_id, section_id, academic_year_id
           FROM report_card_versions WHERE school_id = $1 AND id = $2
         UNION ALL
         SELECT 'entry', student_id, section_id, academic_year_id
           FROM report_card_entries WHERE school_id = $1 AND id = $2
         UNION ALL
         SELECT 'roster', NULL::uuid, id, academic_year_id FROM sections WHERE school_id = $1 AND id = $2
         UNION ALL
         SELECT 'pupil', id, NULL::uuid, NULL::uuid FROM students WHERE school_id = $1 AND id = $2
         LIMIT 1`,
        [schoolId, id],
      )
      const found = row.rows[0]
      if (!found) return null
      if (found.face === 'pupil' && found.student_id !== null) {
        const sections = await currentSectionsOfStudent(conn, schoolId, found.student_id)
        return facts(resource, { studentId: found.student_id, ...sections, published: true })
      }
      return facts(resource, {
        ...(found.student_id === null ? {} : { studentId: found.student_id }),
        ...(found.section_id === null ? {} : { sectionIds: [found.section_id] }),
        ...(found.academic_year_id === null ? {} : { academicYearId: found.academic_year_id }),
        published: found.face === 'card',
      })
    }
    case 'communication': {
      // Messages are one resource type with several faces, looked for by id:
      // a message, a recipient row (one person's copy and its delivery
      // record), and the targets a message is proposed for: a section (the
      // roster), a pupil (their family), and the school, a grade, a staff
      // member or a template, which name no section and so are reached only
      // at school scope. Ids are random uuids, so at most one face matches.
      const row = await conn.client.query<{
        face: string
        student_id: string | null
        section_id: string | null
        academic_year_id: string | null
        members: string[] | null
      }>(
        `SELECT 'message' AS face, m.student_id, m.section_id, m.academic_year_id,
                array_remove(
                  ARRAY[m.created_by_membership_id]
                  || CASE WHEN m.status = 'sent' THEN ARRAY(
                       SELECT r.membership_id FROM message_recipients r
                        WHERE r.school_id = m.school_id AND r.message_id = m.id AND r.in_app)
                     ELSE ARRAY[]::uuid[] END,
                  NULL) AS members
           FROM messages m WHERE m.school_id = $1 AND m.id = $2
         UNION ALL
         SELECT 'recipient', r.student_id, r.section_id, r.academic_year_id,
                array_remove(ARRAY[r.sender_membership_id,
                  CASE WHEN r.in_app AND m.status = 'sent' THEN r.membership_id END], NULL)
           FROM message_recipients r
           JOIN messages m ON m.school_id = r.school_id AND m.id = r.message_id
          WHERE r.school_id = $1 AND r.id = $2
         UNION ALL
         SELECT 'roster', NULL::uuid, id, academic_year_id, NULL::uuid[] FROM sections WHERE school_id = $1 AND id = $2
         UNION ALL
         SELECT 'pupil', id, NULL::uuid, NULL::uuid, NULL::uuid[] FROM students WHERE school_id = $1 AND id = $2
         UNION ALL
         SELECT 'school', NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid[] FROM schools WHERE id = $1 AND id = $2
         UNION ALL
         SELECT 'grade', NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid[] FROM grades WHERE school_id = $1 AND id = $2
         UNION ALL
         SELECT 'staff', NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid[] FROM staff WHERE school_id = $1 AND id = $2
         UNION ALL
         SELECT 'template', NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid[]
           FROM message_templates WHERE school_id = $1 AND id = $2
         LIMIT 1`,
        [schoolId, id],
      )
      const found = row.rows[0]
      if (!found) return null
      if (found.face === 'pupil' && found.student_id !== null) {
        const sections = await currentSectionsOfStudent(conn, schoolId, found.student_id)
        return facts(resource, { studentId: found.student_id, ...sections })
      }
      if (found.face === 'school' || found.face === 'grade' || found.face === 'staff' || found.face === 'template') {
        return facts(resource, {})
      }
      return facts(resource, {
        ...(found.student_id === null ? {} : { studentId: found.student_id }),
        ...(found.section_id === null ? {} : { sectionIds: [found.section_id] }),
        ...(found.academic_year_id === null ? {} : { academicYearId: found.academic_year_id }),
        ...(found.members === null ? {} : { membershipIds: found.members }),
      })
    }
    case 'dashboard':
      // The dashboard is computed from the whole authorized dataset, so it has
      // no row of its own and relationship scopes answer for any relationship.
      return { resourceType: 'dashboard', id, aggregate: true }
    default:
      // Reserved resource types have no table yet.
      return null
  }
}
