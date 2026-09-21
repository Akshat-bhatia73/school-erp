import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { planPredicate, scopedTableFor, type AuthzConnection } from '@erp/authz'
import { FilesUuid, type PermissionKey } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../../http/errors.ts'
import { decideResource, decideSchoolAction, readPlan } from '../../modules/shared/authorize.ts'
import { enrollmentVisibility, getStudent, guardianColumns } from '../../modules/students/reads.ts'
import { loadGuardianRows } from '../../modules/students/routes.ts'
import {
  toGuardianContact,
  toGuardianPrivate,
  toStudentBasic,
  toStudentMedical,
  toStudentSensitive,
  type GuardianRow,
} from '../../modules/students/project.ts'
import { exportFileName, fileNameDate } from '../naming.ts'
import { openDocument } from '../pdf/document.ts'
import { PDF_CONTENT_TYPE, formatPdfDate, type Fact } from '../pdf/kit.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile } from '../types.ts'

/** The job row says which record; everything else is decided here, now. */
const Criteria = z.object({ studentId: FilesUuid })

/** "on_leave" is a stored value, "On leave" is what a person reads. */
function label(value: string): string {
  const words = value.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Facts drop the fields the record does not carry, rather than showing gaps. */
function fact(name: string, value: string | number | undefined): Fact[] {
  if (value === undefined || value === '') return []
  return [{ label: name, value: String(value) }]
}

/**
 * The guardian rows of this student the caller's own guardian read plan lets
 * through. `students.read_guardians` is about a guardian, not a student, so it
 * is decided against the school and then narrowed row by row here, exactly as
 * the subject access export does it.
 */
async function loadPrivateGuardianRows(
  conn: AuthzConnection,
  context: RequestContext,
  studentId: string,
): Promise<GuardianRow[]> {
  const table = scopedTableFor('guardian')
  if (!table) throw new Error('the authorizer has no scoped table for guardian')
  const plan = await readPlan(conn, context, 'students.read_guardians', 'guardian')
  const rows = await conn.db.execute<GuardianRow>(
    sql`SELECT ${guardianColumns}
          FROM guardians
          JOIN student_guardians sg ON sg.school_id = guardians.school_id
           AND sg.guardian_id = guardians.id
         WHERE ${planPredicate(plan, table)}
           AND sg.student_id = ${studentId}::uuid
         ORDER BY sg.is_primary DESC, guardians.id
         LIMIT 20`,
  )
  return rows.rows
}

/** Everything the printed record is allowed to say about one student. */
export interface StudentProfileModel {
  readonly student: ReturnType<typeof toStudentBasic>
  readonly sensitive: ReturnType<typeof toStudentSensitive> | undefined
  readonly medical: ReturnType<typeof toStudentMedical> | undefined
  readonly guardians: NonNullable<ReturnType<typeof toGuardianContact>>[]
  readonly guardianPrivate: NonNullable<ReturnType<typeof toGuardianPrivate>>[]
}

/**
 * The record this reader may print, block by block. It is separate from the
 * drawing below so a test can assert on what a reader is given rather than on
 * the glyphs a PDF ends up holding.
 */
export async function buildStudentProfileModel(
  conn: AuthzConnection,
  context: RequestContext,
  studentId: string,
): Promise<StudentProfileModel> {
  // The permission that justified the job is decided again on this record, so
  // a producer that runs a day later under the daily route is no more
  // permitted than the request that asked for it.
  const may = async (permission: PermissionKey) =>
    (await decideResource(conn, context, permission, 'student', studentId)).allowed
  if (!(await may('students.export'))) throw new ApiFailure('RESOURCE_NOT_FOUND')

  // Exactly the blocks the detail screen would show this reader, decided one
  // at a time and before the statement is built, so a block the reader may not
  // have is never named in SQL at all.
  const options = {
    sensitive: await may('students.read_sensitive'),
    medical: await may('students.read_medical'),
  }
  const plan = await readPlan(conn, context, 'students.read_basic', 'student')
  const visible = await enrollmentVisibility(conn, context)
  const row = await getStudent(conn, plan, visible, studentId, options)
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')

  const student = toStudentBasic(row)
  const sensitive = options.sensitive ? toStudentSensitive(row) : undefined
  const medical = options.medical ? toStudentMedical(row) : undefined
  // The guardian block is the contact card, plus the private fields when the
  // reader holds the guardian detail permission. Sealed numbers are printed as
  // the last digits only, exactly as the screen shows them.
  const guardianDetail = (await decideSchoolAction(conn, context, 'students.read_guardians'))
    .allowed
  // The contact card is decided on the student, exactly as the student detail
  // route decides it.
  const contactRows = (await may('students.read_guardian_contact'))
    ? await loadGuardianRows(conn, context.schoolId, studentId)
    : []
  const guardians = contactRows
    .map(toGuardianContact)
    .filter((contact): contact is NonNullable<typeof contact> => contact !== undefined)
  const guardianPrivate = guardianDetail
    ? (await loadPrivateGuardianRows(conn, context, studentId))
        .map(toGuardianPrivate)
        .filter((guardian): guardian is NonNullable<typeof guardian> => guardian !== undefined)
    : []

  return { student, sensitive, medical, guardians, guardianPrivate }
}

async function produce(
  conn: AuthzConnection,
  context: RequestContext,
  criteria: unknown,
): Promise<ExportFile> {
  const parsed = Criteria.safeParse(criteria)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  const { student, sensitive, medical, guardians, guardianPrivate } =
    await buildStudentProfileModel(conn, context, parsed.data.studentId)

  const fullName = [student.firstName, student.lastName].filter(Boolean).join(' ')
  const enrollment = student.enrollment
  const className = enrollment ? `${enrollment.grade.name} ${enrollment.section.name}`.trim() : undefined

  const document = await openDocument(conn, context, { title: 'Student record' })
  document.personHeader({
    name: fullName,
    subtitle: `Admission number ${student.admissionNumber}`,
    tags: [
      label(student.status),
      ...(className === undefined ? [] : [className]),
      ...(enrollment?.rollNumber === undefined ? [] : [`Roll ${enrollment.rollNumber}`]),
    ],
  })

  document.panel('Basic details', {
    kind: 'facts',
    facts: [
      ...fact('Full name', fullName),
      ...fact('Admission number', student.admissionNumber),
      ...fact('Class', className),
      ...fact('Roll number', enrollment?.rollNumber),
      ...fact('Academic year', enrollment?.academicYear.name),
      ...fact('Status', label(student.status)),
    ],
  })

  if (sensitive) {
    document.panel('Personal details', {
      kind: 'facts',
      facts: [
        ...fact('Date of birth', formatPdfDate(sensitive.dateOfBirth)),
        ...fact('Gender', label(sensitive.gender)),
        ...fact('Category', sensitive.category),
        ...fact('Admission type', sensitive.admissionType),
        ...fact('Admission date', formatPdfDate(sensitive.admissionDate)),
        ...fact('APAAR id', sensitive.apaarMasked),
        // The same four digits the screen shows, and never more than that.
        ...fact(
          'Aadhaar',
          sensitive.aadhaarLast4 === undefined ? undefined : `ending ${sensitive.aadhaarLast4}`,
        ),
        ...fact('Address', sensitive.address),
      ],
    })
  }

  if (medical && (medical.bloodGroup !== undefined || medical.medicalNotes !== undefined)) {
    document.panel('Health', {
      kind: 'facts',
      facts: [
        ...fact('Blood group', medical.bloodGroup),
        ...fact('Medical notes', medical.medicalNotes),
      ],
    })
  }

  if (guardians.length > 0) {
    document.panel('Guardians', {
      kind: 'table',
      columns: [
        { header: 'Name', width: 0.4 },
        { header: 'Relation', width: 0.25 },
        { header: 'Phone', width: 0.35 },
      ],
      rows: guardians.map((guardian) => [
        guardian.displayName,
        label(guardian.relation),
        guardian.phone,
      ]),
    })
  }

  if (guardianPrivate.length > 0) {
    for (const guardian of guardianPrivate) {
      const facts = [
        ...fact('Occupation', guardian.occupation),
        ...fact('Home address', guardian.address),
        ...fact('Office address', guardian.officeAddress),
        ...fact('PAN', guardian.panLast4 === undefined ? undefined : `ending ${guardian.panLast4}`),
        ...fact(
          'Aadhaar',
          guardian.aadhaarLast4 === undefined ? undefined : `ending ${guardian.aadhaarLast4}`,
        ),
      ]
      if (facts.length > 0) document.panel(guardian.displayName, { kind: 'facts', facts })
    }
  }

  return {
    bytes: await document.finish(),
    contentType: PDF_CONTENT_TYPE,
    fileName: exportFileName(
      ['student', student.admissionNumber, fileNameDate(context.now)],
      'pdf',
    ),
    rowCount: 1,
  }
}

registerProducer({ kind: 'student_profile', produce })
