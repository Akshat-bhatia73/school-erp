import { z } from 'zod'
import type { AuthzConnection } from '@erp/authz'
import { FilesUuid, type PermissionKey } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../../http/errors.ts'
import { decideResource, readPlan } from '../../modules/shared/authorize.ts'
import { enrollmentVisibility, getStudent } from '../../modules/students/reads.ts'
import { loadGuardianRows } from '../../modules/students/routes.ts'
import {
  toGuardianContact,
  toStudentBasic,
  toStudentMedical,
  toStudentSensitive,
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

async function produce(
  conn: AuthzConnection,
  context: RequestContext,
  criteria: unknown,
): Promise<ExportFile> {
  const parsed = Criteria.safeParse(criteria)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  const studentId = parsed.data.studentId

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
  const guardians = (await may('students.read_guardian_contact'))
    ? (await loadGuardianRows(conn, context.schoolId, studentId))
        .map(toGuardianContact)
        .filter((contact): contact is NonNullable<typeof contact> => contact !== undefined)
    : []

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
