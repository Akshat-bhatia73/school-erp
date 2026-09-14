import { sql } from 'drizzle-orm'
import type { RequestContext } from '@erp/contracts/server'
import type {
  StudentsAdmitGuardian,
  StudentsAdmitRequest,
  StudentsUpdateGuardianRequest,
  StudentsUpdateSensitiveRequest,
} from '@erp/contracts'
import { ApiFailure, authorizeResource, bumpVersion, lockSchool, writeAudit } from '../shared/index.ts'
import type { ModuleConnection } from './reads.ts'
import type { GuardianRow } from './project.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Identifiers are opaque in the contract but uuid in storage. Checking the
 * shape here keeps a malformed identifier a plain not-found or bad request
 * instead of a database error the boundary would have to answer with 503.
 */
export function assertUuidParam(value: string): string {
  if (!UUID.test(value)) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return value
}

export function assertUuidReference(value: string): string {
  if (!UUID.test(value)) throw new ApiFailure('INVALID_REQUEST')
  return value
}

/** A text value on its way into a jsonb column, as a JSON string. */
function jsonText(value: string): string {
  return JSON.stringify(value)
}

export interface CurrentEnrollment {
  readonly id: string
  readonly academicYearId: string
  readonly sectionId: string
  /** The day the enrolment began, so a leave date can be checked against it. */
  readonly joinedOn: string
}

export async function currentEnrollment(
  conn: ModuleConnection,
  schoolId: string,
  studentId: string,
): Promise<CurrentEnrollment | null> {
  const rows = await conn.db.execute<{
    id: string
    academic_year_id: string
    section_id: string
    joined_on: string
  }>(
    sql`SELECT id, academic_year_id, section_id, joined_on::text AS joined_on FROM enrollments
         WHERE school_id = ${schoolId}::uuid AND student_id = ${studentId}::uuid AND left_on IS NULL
         ORDER BY joined_on DESC, id LIMIT 1`,
  )
  const row = rows.rows[0]
  if (!row) return null
  return {
    id: row.id,
    academicYearId: row.academic_year_id,
    sectionId: row.section_id,
    joinedOn: row.joined_on,
  }
}

/** A section of this school, or a rejected request. Never a database error. */
async function requireSection(
  conn: ModuleConnection,
  schoolId: string,
  sectionId: string,
): Promise<{ id: string; academicYearId: string }> {
  const rows = await conn.db.execute<{ id: string; academic_year_id: string }>(
    sql`SELECT id, academic_year_id FROM sections
         WHERE school_id = ${schoolId}::uuid AND id = ${assertUuidReference(sectionId)}::uuid`,
  )
  const row = rows.rows[0]
  if (!row) throw new ApiFailure('INVALID_REQUEST')
  return { id: row.id, academicYearId: row.academic_year_id }
}

async function guardianExists(
  conn: ModuleConnection,
  schoolId: string,
  guardianId: string,
): Promise<boolean> {
  const rows = await conn.db.execute<{ id: string }>(
    sql`SELECT id FROM guardians
         WHERE school_id = ${schoolId}::uuid AND id = ${assertUuidReference(guardianId)}::uuid`,
  )
  return rows.rows.length > 0
}

/** Creates the guardian record a link needs, or returns the named one. */
async function resolveGuardian(
  conn: ModuleConnection,
  context: RequestContext,
  link: StudentsAdmitGuardian,
): Promise<string> {
  const schoolId = context.schoolId
  if (link.guardianId !== undefined) {
    if (!(await guardianExists(conn, schoolId, link.guardianId))) throw new ApiFailure('INVALID_REQUEST')
    // Attaching an existing guardian record is a guardian write wherever it
    // happens, so admission is decided exactly like the add-guardian route.
    await authorizeResource(conn, context, 'students.manage_guardians', 'guardian', link.guardianId)
    return link.guardianId
  }
  const details = link.guardian
  if (!details) throw new ApiFailure('INVALID_REQUEST')
  const inserted = await conn.db.execute<{ id: string }>(
    sql`INSERT INTO guardians (school_id, first_name, last_name, phone, occupation, address)
        VALUES (${schoolId}::uuid, ${details.firstName}, ${details.lastName ?? null},
                ${details.phone}, ${details.occupation ?? null},
                ${details.address === undefined ? null : jsonText(details.address)}::jsonb)
        RETURNING id`,
  )
  const id = inserted.rows[0]?.id
  if (!id) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return id
}

/** A student has at most one primary guardian, so the others step down. */
async function clearPrimary(
  conn: ModuleConnection,
  schoolId: string,
  studentId: string,
): Promise<void> {
  await conn.db.execute(
    sql`UPDATE student_guardians SET is_primary = false
         WHERE school_id = ${schoolId}::uuid AND student_id = ${studentId}::uuid
           AND is_primary = true`,
  )
}

async function linkGuardian(
  conn: ModuleConnection,
  schoolId: string,
  studentId: string,
  guardianId: string,
  link: StudentsAdmitGuardian,
): Promise<void> {
  if (link.isPrimary) await clearPrimary(conn, schoolId, studentId)
  await conn.db.execute(
    sql`INSERT INTO student_guardians (school_id, student_id, guardian_id, relation, is_primary, receives_notifications)
        VALUES (${schoolId}::uuid, ${studentId}::uuid, ${guardianId}::uuid, ${link.relation},
                ${link.isPrimary}, ${link.receivesNotifications})
        ON CONFLICT (school_id, student_id, guardian_id) DO UPDATE
           SET relation = EXCLUDED.relation, is_primary = EXCLUDED.is_primary,
               receives_notifications = EXCLUDED.receives_notifications`,
  )
}

/** Admission: the student, the first enrollment and the guardian links. */
export async function admitStudent(
  conn: ModuleConnection,
  context: RequestContext,
  body: StudentsAdmitRequest,
): Promise<string> {
  await lockSchool(conn, context.schoolId)
  const section = await requireSection(conn, context.schoolId, body.sectionId)

  const taken = await conn.db.execute<{ id: string }>(
    sql`SELECT id FROM students WHERE school_id = ${context.schoolId}::uuid
          AND admission_number = ${body.admissionNumber}`,
  )
  if (taken.rows.length > 0) throw new ApiFailure('INVALID_REQUEST')

  const named = body.guardians.filter((link) => link.guardianId !== undefined).map((link) => link.guardianId)
  if (new Set(named).size !== named.length) throw new ApiFailure('INVALID_REQUEST')

  const inserted = await conn.db.execute<{ id: string }>(
    sql`INSERT INTO students (school_id, admission_number, first_name, last_name, status,
                              date_of_birth, gender, category, admission_type, admission_date, address)
        VALUES (${context.schoolId}::uuid, ${body.admissionNumber}, ${body.firstName},
                ${body.lastName ?? null}, 'active', ${body.dateOfBirth}::date, ${body.gender},
                ${body.category ?? null}, ${body.admissionType ?? null}, ${body.admissionDate}::date,
                ${body.address === undefined ? null : jsonText(body.address)}::jsonb)
        RETURNING id`,
  )
  const studentId = inserted.rows[0]?.id
  if (!studentId) throw new ApiFailure('SERVICE_UNAVAILABLE')

  await conn.db.execute(
    sql`INSERT INTO enrollments (school_id, student_id, academic_year_id, section_id, roll_number, joined_on, outcome)
        VALUES (${context.schoolId}::uuid, ${studentId}::uuid, ${section.academicYearId}::uuid,
                ${section.id}::uuid, ${body.rollNumber ?? null}, ${body.admissionDate}::date, 'ongoing')`,
  )
  for (const link of body.guardians) {
    const guardianId = await resolveGuardian(conn, context, link)
    await linkGuardian(conn, context.schoolId, studentId, guardianId, link)
  }

  await writeAudit(conn, context, {
    action: 'students.create',
    targetType: 'student',
    targetId: studentId,
    summary: 'Admitted a student and created the first enrolment and guardian links.',
    safeChanges: { guardianLinks: body.guardians.length, sectionId: section.id },
  })
  return studentId
}

export async function updateBasic(
  conn: ModuleConnection,
  context: RequestContext,
  studentId: string,
  body: { expectedVersion: number; firstName?: string; lastName?: string },
): Promise<void> {
  const set: Record<string, unknown> = {}
  if (body.firstName !== undefined) set.first_name = body.firstName
  if (body.lastName !== undefined) set.last_name = body.lastName
  await bumpVersion(conn, 'students', {
    schoolId: context.schoolId,
    id: studentId,
    expectedVersion: body.expectedVersion,
    set,
  })
  await writeAudit(conn, context, {
    action: 'students.update_basic',
    targetType: 'student',
    targetId: studentId,
    summary: 'Updated the basic name fields of a student record.',
    safeChanges: { fields: Object.keys(set) },
  })
}

/** The sensitive columns, keyed by the contract field that may set them. */
const SENSITIVE_COLUMNS: Record<string, string> = {
  dateOfBirth: 'date_of_birth',
  gender: 'gender',
  category: 'category',
  admissionType: 'admission_type',
  address: 'address',
  aadhaarLast4: 'aadhaar_last4',
  apaarId: 'apaar_id',
  bloodGroup: 'blood_group',
  medicalNotes: 'medical_notes',
}

export function touchesMedical(body: StudentsUpdateSensitiveRequest): boolean {
  return body.bloodGroup !== undefined || body.medicalNotes !== undefined
}

export async function updateSensitive(
  conn: ModuleConnection,
  context: RequestContext,
  studentId: string,
  body: StudentsUpdateSensitiveRequest,
): Promise<void> {
  const set: Record<string, unknown> = {}
  for (const [field, column] of Object.entries(SENSITIVE_COLUMNS)) {
    const value = (body as Record<string, unknown>)[field]
    if (value === undefined) continue
    set[column] = field === 'address' ? jsonText(String(value)) : value
  }
  await bumpVersion(conn, 'students', {
    schoolId: context.schoolId,
    id: studentId,
    expectedVersion: body.expectedVersion,
    set,
  })
  await writeAudit(conn, context, {
    action: 'students.update_sensitive',
    targetType: 'student',
    targetId: studentId,
    summary: 'Updated restricted fields of a student record.',
    safeChanges: { fields: Object.keys(set) },
  })
}

/**
 * A move inside the running year changes the class the enrolment points at.
 * Crossing an academic year is promotion, which is a different permission and
 * a different workflow, so it is refused here rather than half implemented.
 */
export async function moveStudent(
  conn: ModuleConnection,
  context: RequestContext,
  studentId: string,
  enrollment: CurrentEnrollment,
  body: { expectedVersion: number; sectionId: string; rollNumber?: number; reason: string },
): Promise<void> {
  await lockSchool(conn, context.schoolId)
  const section = await requireSection(conn, context.schoolId, body.sectionId)
  if (section.academicYearId !== enrollment.academicYearId) throw new ApiFailure('INVALID_REQUEST')
  // The student row carries the version the caller holds, because an
  // enrolment has none of its own.
  await bumpVersion(conn, 'students', {
    schoolId: context.schoolId,
    id: studentId,
    expectedVersion: body.expectedVersion,
  })
  await conn.db.execute(
    sql`UPDATE enrollments
           SET section_id = ${section.id}::uuid,
               roll_number = COALESCE(${body.rollNumber ?? null}::integer, roll_number),
               updated_at = now()
         WHERE school_id = ${context.schoolId}::uuid AND id = ${enrollment.id}::uuid`,
  )
  await writeAudit(conn, context, {
    action: 'students.manage_enrollment',
    targetType: 'enrollment',
    targetId: enrollment.id,
    summary: 'Moved a student to another class in the same academic year.',
    safeChanges: {
      fromSectionId: enrollment.sectionId,
      toSectionId: section.id,
      reason: body.reason,
    },
  })
}

export async function endEnrollment(
  conn: ModuleConnection,
  context: RequestContext,
  studentId: string,
  enrollment: CurrentEnrollment,
  body: { expectedVersion: number; leftOn: string; reason: string },
): Promise<void> {
  await lockSchool(conn, context.schoolId)
  // The database refuses a leave date before the enrolment started; checking
  // it here makes that the caller's bad request rather than a broken service.
  if (body.leftOn < enrollment.joinedOn) throw new ApiFailure('INVALID_REQUEST')
  await bumpVersion(conn, 'students', {
    schoolId: context.schoolId,
    id: studentId,
    expectedVersion: body.expectedVersion,
    set: { status: 'left', left_on: body.leftOn, left_reason: body.reason },
  })
  await conn.db.execute(
    sql`UPDATE enrollments SET left_on = ${body.leftOn}::date, outcome = 'left', updated_at = now()
         WHERE school_id = ${context.schoolId}::uuid AND id = ${enrollment.id}::uuid`,
  )
  await writeAudit(conn, context, {
    action: 'students.manage_enrollment',
    targetType: 'enrollment',
    targetId: enrollment.id,
    summary: 'Ended a student enrolment and marked the student as left.',
    safeChanges: { sectionId: enrollment.sectionId, reason: body.reason },
  })
}

export async function loadGuardian(
  conn: ModuleConnection,
  schoolId: string,
  studentId: string,
  guardianId: string,
): Promise<GuardianRow | null> {
  const rows = await conn.db.execute<GuardianRow>(
    sql`SELECT guardians.id, guardians.first_name, guardians.last_name, guardians.phone,
               guardians.occupation, guardians.annual_income::text AS annual_income,
               COALESCE(guardians.address #>> '{}', guardians.address::text) AS address,
               sg.relation, guardians.version
          FROM guardians
          JOIN student_guardians sg ON sg.school_id = guardians.school_id
           AND sg.guardian_id = guardians.id
         WHERE guardians.school_id = ${schoolId}::uuid AND guardians.id = ${guardianId}::uuid
           AND sg.student_id = ${studentId}::uuid`,
  )
  return rows.rows[0] ?? null
}

export async function addGuardian(
  conn: ModuleConnection,
  context: RequestContext,
  studentId: string,
  link: StudentsAdmitGuardian,
): Promise<string> {
  await lockSchool(conn, context.schoolId)
  const guardianId = await resolveGuardian(conn, context, link)
  await linkGuardian(conn, context.schoolId, studentId, guardianId, link)
  await writeAudit(conn, context, {
    action: 'students.manage_guardians',
    targetType: 'guardian',
    targetId: guardianId,
    summary: 'Linked a guardian to a student record.',
    safeChanges: { studentId, isPrimary: link.isPrimary },
  })
  return guardianId
}

const GUARDIAN_COLUMNS: Record<string, string> = {
  firstName: 'first_name',
  lastName: 'last_name',
  phone: 'phone',
  occupation: 'occupation',
  address: 'address',
}

export async function updateGuardian(
  conn: ModuleConnection,
  context: RequestContext,
  studentId: string,
  guardianId: string,
  body: StudentsUpdateGuardianRequest,
): Promise<void> {
  const set: Record<string, unknown> = {}
  for (const [field, column] of Object.entries(GUARDIAN_COLUMNS)) {
    const value = (body as Record<string, unknown>)[field]
    if (value === undefined) continue
    set[column] = field === 'address' ? jsonText(String(value)) : value
  }
  await bumpVersion(conn, 'guardians', {
    schoolId: context.schoolId,
    id: guardianId,
    expectedVersion: body.expectedVersion,
    set,
  })
  if (
    body.relation !== undefined ||
    body.isPrimary !== undefined ||
    body.receivesNotifications !== undefined
  ) {
    if (body.isPrimary === true) await clearPrimary(conn, context.schoolId, studentId)
    await conn.db.execute(
      sql`UPDATE student_guardians
             SET relation = COALESCE(${body.relation ?? null}, relation),
                 is_primary = COALESCE(${body.isPrimary ?? null}::boolean, is_primary),
                 receives_notifications = COALESCE(${body.receivesNotifications ?? null}::boolean, receives_notifications)
           WHERE school_id = ${context.schoolId}::uuid AND student_id = ${studentId}::uuid
             AND guardian_id = ${guardianId}::uuid`,
    )
  }
  await writeAudit(conn, context, {
    action: 'students.manage_guardians',
    targetType: 'guardian',
    targetId: guardianId,
    summary: 'Updated a guardian record and the link to a student.',
    safeChanges: { studentId, fields: Object.keys(set) },
  })
}
