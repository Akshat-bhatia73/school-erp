import { and, eq, sql } from 'drizzle-orm'
import type { StaffCreateRequest, StaffUpdateEmploymentRequest, TeachingAssignmentRequest } from '@erp/contracts'
import { UpdateStaffPayRequest, UpdateStaffPrivateRequest } from '@erp/contracts'
import type { AuthzConnection } from '@erp/authz'
import type { z } from 'zod'
import type { RequestContext } from '@erp/contracts/server'
import { academicYears, exportJobs, sections, staff, subjects, teachingAssignments } from '@erp/db/schema'
import { ApiFailure } from '../../http/errors.ts'
import { lockSchool, writeAudit } from '../shared/audit.ts'
import { bumpVersion } from '../shared/version.ts'
import type { StaffRow } from './projection.ts'

/** Every reference in a body must already exist in this school, checked here
 * rather than left to a foreign key, so a bad reference is a plain 400. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function existsInSchool(
  conn: AuthzConnection,
  schoolId: string,
  table: typeof sections | typeof subjects | typeof academicYears | typeof staff,
  id: string,
): Promise<boolean> {
  // A reference of the wrong shape matches nothing, so it is answered as a bad
  // reference instead of being sent to Postgres as a broken uuid literal.
  if (!UUID.test(id)) return false
  const rows = await conn.db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.schoolId, schoolId), eq(table.id, id)))
    .limit(1)
  return rows.length > 0
}

function invalid(): never {
  throw new ApiFailure('INVALID_REQUEST')
}

/** A new employment record. No login, no pay, no bank or identity numbers. */
export async function createStaff(
  conn: AuthzConnection,
  context: RequestContext,
  body: StaffCreateRequest,
): Promise<StaffRow> {
  // The employee code is unique per school. Taking the school lock first makes
  // this read and the insert one decision, so a concurrent create loses on the
  // lock and is answered as a duplicate rather than as a failed constraint.
  await lockSchool(conn, context.schoolId)
  const taken = await conn.db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.schoolId, context.schoolId), eq(staff.employeeCode, body.employeeCode)))
    .limit(1)
  if (taken.length > 0) invalid()

  const inserted = await conn.db
    .insert(staff)
    .values({
      schoolId: context.schoolId,
      employeeCode: body.employeeCode,
      firstName: body.firstName,
      lastName: body.lastName ?? null,
      staffType: body.staffType,
      designation: body.designation,
      department: body.department ?? null,
      employmentType: body.employmentType,
      joiningDate: body.joiningDate,
      phone: body.phone,
      email: body.email ?? null,
      gender: body.gender ?? null,
      dateOfBirth: body.dateOfBirth ?? null,
      qualification: body.qualification ?? null,
      // A new employee starts employed; the status is never taken from input.
      status: 'active',
    })
    .returning()
  const row = inserted[0] as StaffRow | undefined
  if (!row) throw new ApiFailure('SERVICE_UNAVAILABLE')

  await writeAudit(conn, context, {
    action: 'staff.create',
    targetType: 'staff',
    targetId: row.id,
    summary: 'Added a staff employment record.',
    safeChanges: { staffType: row.staffType, employmentType: body.employmentType },
  })
  return row
}

/** Reads a row back after a write, by id, without any access predicate. The
 * caller has already been authorized on exactly this record. */
export async function reloadStaff(
  conn: AuthzConnection,
  schoolId: string,
  staffId: string,
): Promise<StaffRow> {
  const rows = await conn.db
    .select()
    .from(staff)
    .where(and(eq(staff.schoolId, schoolId), eq(staff.id, staffId)))
    .limit(1)
  const row = rows[0] as StaffRow | undefined
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return row
}

export async function updateEmployment(
  conn: AuthzConnection,
  context: RequestContext,
  staffId: string,
  body: StaffUpdateEmploymentRequest,
): Promise<void> {
  const current = await reloadStaff(conn, context.schoolId, staffId)
  const set: Record<string, unknown> = {}
  if (body.designation !== undefined) set.designation = body.designation
  if (body.department !== undefined) set.department = body.department
  if (body.employmentType !== undefined) set.employment_type = body.employmentType
  if (body.status !== undefined) set.status = body.status
  if (body.staffType !== undefined) set.staff_type = body.staffType
  if (body.joiningDate !== undefined) set.joining_date = body.joiningDate
  if (body.leavingDate !== undefined) set.leaving_date = body.leavingDate
  if (body.qualification !== undefined) set.qualification = body.qualification
  // A leaving date is compared against the joining date that will be stored,
  // which is the one in the body when it changes and the stored one otherwise.
  const joiningDate = body.joiningDate ?? current.joiningDate
  if (
    body.leavingDate !== undefined &&
    body.leavingDate !== null &&
    typeof joiningDate === 'string' &&
    body.leavingDate < joiningDate
  ) {
    invalid()
  }
  await bumpVersion(conn, 'staff', {
    schoolId: context.schoolId,
    id: staffId,
    expectedVersion: body.expectedVersion,
    set,
  })
  await writeAudit(conn, context, {
    action: 'staff.update_employment',
    targetType: 'staff',
    targetId: staffId,
    summary: 'Changed employment details on a staff record.',
    safeChanges: { fields: Object.keys(set) },
  })
}

export async function updatePrivate(
  conn: AuthzConnection,
  context: RequestContext,
  staffId: string,
  body: z.infer<typeof UpdateStaffPrivateRequest>,
): Promise<void> {
  const set: Record<string, unknown> = {}
  if (body.phone !== undefined) set.phone = body.phone
  // The column is JSON, so the address is stored as a JSON string value.
  if (body.address !== undefined) set.address = JSON.stringify(body.address)
  await bumpVersion(conn, 'staff', {
    schoolId: context.schoolId,
    id: staffId,
    expectedVersion: body.expectedVersion,
    set,
  })
  await writeAudit(conn, context, {
    action: 'staff.update_private',
    targetType: 'staff',
    targetId: staffId,
    // Never the number or the address itself, only which field moved.
    summary: 'Changed private contact details on a staff record.',
    safeChanges: { fields: Object.keys(set) },
  })
}

export async function updatePay(
  conn: AuthzConnection,
  context: RequestContext,
  staffId: string,
  body: z.infer<typeof UpdateStaffPayRequest>,
): Promise<void> {
  await bumpVersion(conn, 'staff', {
    schoolId: context.schoolId,
    id: staffId,
    expectedVersion: body.expectedVersion,
    set: { monthly_salary: body.monthlySalary },
  })
  await writeAudit(conn, context, {
    action: 'staff.update_pay',
    targetType: 'staff',
    targetId: staffId,
    // The amount is exactly what an audit reader must not learn.
    summary: 'Changed monthly pay on a staff record.',
    safeChanges: { payChanged: true, reason: body.reason },
  })
}

/**
 * One (staff, year, section, subject) assignment. The staff version is the
 * concurrency check, so two people editing the same teacher's timetable
 * assignments cannot both commit against the same starting state.
 */
export async function upsertAssignment(
  conn: AuthzConnection,
  context: RequestContext,
  staffId: string,
  body: TeachingAssignmentRequest,
): Promise<void> {
  if (body.staffId !== staffId) invalid()
  await lockSchool(conn, context.schoolId)
  if (!(await existsInSchool(conn, context.schoolId, staff, staffId))) invalid()
  if (!(await existsInSchool(conn, context.schoolId, academicYears, body.academicYearId))) invalid()
  if (!(await existsInSchool(conn, context.schoolId, subjects, body.subjectId))) invalid()
  // The section must belong to the named year as well as to this school.
  if (!UUID.test(body.sectionId)) invalid()
  const section = await conn.db
    .select({ id: sections.id })
    .from(sections)
    .where(
      and(
        eq(sections.schoolId, context.schoolId),
        eq(sections.id, body.sectionId),
        eq(sections.academicYearId, body.academicYearId),
      ),
    )
    .limit(1)
  if (section.length === 0) invalid()

  await bumpVersion(conn, 'staff', {
    schoolId: context.schoolId,
    id: staffId,
    expectedVersion: body.expectedVersion,
  })

  const key = and(
    eq(teachingAssignments.schoolId, context.schoolId),
    eq(teachingAssignments.staffId, staffId),
    eq(teachingAssignments.academicYearId, body.academicYearId),
    eq(teachingAssignments.sectionId, body.sectionId),
    eq(teachingAssignments.subjectId, body.subjectId),
  )
  const existing = await conn.db.select({ id: teachingAssignments.id }).from(teachingAssignments).where(key).limit(1)
  if (existing[0]) {
    await conn.db
      .update(teachingAssignments)
      .set({ effectiveFrom: body.validFrom, effectiveTo: body.validUntil, updatedAt: sql`now()` })
      .where(eq(teachingAssignments.id, existing[0].id))
  } else {
    await conn.db.insert(teachingAssignments).values({
      schoolId: context.schoolId,
      staffId,
      academicYearId: body.academicYearId,
      sectionId: body.sectionId,
      subjectId: body.subjectId,
      effectiveFrom: body.validFrom,
      effectiveTo: body.validUntil,
    })
  }

  await writeAudit(conn, context, {
    action: 'staff.manage_assignments',
    targetType: 'staff',
    targetId: staffId,
    summary: existing[0]
      ? 'Updated a teaching assignment for a staff member.'
      : 'Added a teaching assignment for a staff member.',
    safeChanges: { reason: body.reason, academicYearId: body.academicYearId },
  })
}

export async function deleteAssignment(
  conn: AuthzConnection,
  context: RequestContext,
  staffId: string,
  assignmentId: string,
): Promise<void> {
  await lockSchool(conn, context.schoolId)
  const removed = await conn.db
    .delete(teachingAssignments)
    .where(
      and(
        eq(teachingAssignments.schoolId, context.schoolId),
        eq(teachingAssignments.staffId, staffId),
        eq(teachingAssignments.id, assignmentId),
      ),
    )
    .returning({ id: teachingAssignments.id })
  if (removed.length === 0) throw new ApiFailure('RESOURCE_NOT_FOUND')
  await writeAudit(conn, context, {
    action: 'staff.manage_assignments',
    targetType: 'staff',
    targetId: staffId,
    summary: 'Removed a teaching assignment from a staff member.',
  })
}

/**
 * The export job. The rows are not read here: the job records who asked, under
 * which permission and at which access version, so the worker and the later
 * download both recheck access rather than trusting this moment.
 */
export async function createExportJob(
  conn: AuthzConnection,
  context: RequestContext,
  staffIds: readonly string[],
): Promise<{ id: string; status: 'queued' }> {
  const inserted = await conn.db
    .insert(exportJobs)
    .values({
      schoolId: context.schoolId,
      requestedByMembershipId: context.membershipId,
      kind: 'staff',
      status: 'queued',
      accessVersion: context.accessVersion,
      permission: 'staff.export',
      criteria: { staffIds: [...staffIds] },
      expiresAt: sql`now() + interval '24 hours'`,
    })
    .returning({ id: exportJobs.id })
  const row = inserted[0]
  if (!row) throw new ApiFailure('SERVICE_UNAVAILABLE')
  await writeAudit(conn, context, {
    action: 'staff.export',
    targetType: 'export_job',
    targetId: row.id,
    summary: 'Requested an export of selected staff records.',
    safeChanges: { staffCount: staffIds.length },
  })
  return { id: row.id, status: 'queued' }
}

