import type { PoolClient } from 'pg'
import type { RequestContext } from '@erp/contracts/server'
import type { StudentsBulkImportRow, StudentsImportPreviewRequest } from '@erp/contracts'
import { ApiFailure } from '../shared/errors.ts'
import { sealAadhaar, sealPan, type SealedNumber } from '../shared/crypto.ts'

// Identity numbers are sealed at the moment the server reads the sheet, so no
// copy of a whole Aadhaar or PAN ever sits in `student_import_previews` in
// plain text; the commit writes the same sealed value into the record without
// opening it.

/**
 * A row after the server resolved it. The sheet names a grade and a section as
 * text; only the identifier the server resolved is stored, so a commit can
 * never be pointed at another school's section by the client.
 */
export interface StoredImportRow {
  readonly rowNumber: number
  /** Only when the sheet supplied one; otherwise assigned at commit time. */
  readonly admissionNumber?: string
  readonly firstName: string
  readonly lastName?: string
  readonly dateOfBirth: string
  readonly gender: 'male' | 'female' | 'other'
  readonly sectionId: string
  readonly rollNumber?: number
  readonly fatherName?: string
  readonly motherName?: string
  /** Already normalised to +91, so the database keeps one phone format. */
  readonly guardianPhone: string
  readonly guardianEmail?: string
  readonly city?: string
  readonly state?: string
  readonly pincode?: string
  readonly category?: string
  readonly admissionType?: string
  /** Sealed at preview time; never the whole number in plain text. */
  readonly studentAadhaar?: SealedNumber
  /** The row's one guardian, the primary, carries these three. */
  readonly guardianAadhaar?: SealedNumber
  readonly guardianPan?: SealedNumber
  readonly guardianOfficeAddress?: string
}

export interface RowError {
  readonly row: number
  readonly field: string
  readonly message: string
}

export interface ValidationOutcome {
  readonly validRows: readonly StoredImportRow[]
  readonly errors: readonly RowError[]
}

interface SectionRow {
  id: string
  section_name: string
  grade_name: string
  grade_short: string | null
}

/** The sheet writes a ten digit number; the school record keeps one format. */
export function normalisePhone(tenDigits: string): string {
  return `+91${tenDigits}`
}

function key(grade: string, section: string): string {
  return `${grade.trim().toLowerCase()}|${section.trim().toLowerCase()}`
}

/** Every section of this year, addressable by the names a sheet would use. */
async function sectionsByName(
  client: PoolClient,
  schoolId: string,
  academicYearId: string,
): Promise<Map<string, string>> {
  const result = await client.query<SectionRow>(
    `SELECT s.id, s.name AS section_name, g.name AS grade_name, g.short_name AS grade_short
       FROM sections s
       JOIN grades g ON g.school_id = s.school_id AND g.id = s.grade_id
      WHERE s.school_id = $1 AND s.academic_year_id = $2`,
    [schoolId, academicYearId],
  )
  const map = new Map<string, string>()
  for (const row of result.rows) {
    map.set(key(row.grade_name, row.section_name), row.id)
    if (row.grade_short) map.set(key(row.grade_short, row.section_name), row.id)
  }
  return map
}

/** The academic year must be one of this school's, not merely a valid uuid. */
export async function requireAcademicYear(
  client: PoolClient,
  schoolId: string,
  academicYearId: string,
): Promise<void> {
  const found = await client.query(
    `SELECT 1 FROM academic_years WHERE school_id = $1 AND id = $2`,
    [schoolId, academicYearId],
  )
  if (found.rowCount === 0) throw new ApiFailure('INVALID_REQUEST')
}

/** The admission numbers of this sheet that some student already holds. */
async function takenAdmissionNumbers(
  client: PoolClient,
  schoolId: string,
  numbers: readonly string[],
): Promise<Set<string>> {
  if (numbers.length === 0) return new Set()
  const result = await client.query<{ admission_number: string }>(
    `SELECT admission_number FROM students
      WHERE school_id = $1 AND admission_number = ANY($2::text[])`,
    [schoolId, [...numbers]],
  )
  return new Set(result.rows.map((row) => row.admission_number))
}

function isRealPastDate(value: string): boolean {
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) && parsed <= Date.now()
}

/**
 * The whole validation pass. It answers for every row, so a person fixing a
 * sheet sees each problem at once rather than one per upload, and it keeps
 * only the rows that passed: a later commit re-checks them anyway, but it
 * never has to look at a row the server already rejected.
 */
export async function validateRows(
  client: PoolClient,
  schoolId: string,
  request: StudentsImportPreviewRequest,
  encryptionKey: string,
): Promise<ValidationOutcome> {
  const sections = await sectionsByName(client, schoolId, request.academicYearId)
  const supplied = request.rows
    .map((row) => row.admissionNumber)
    .filter((value): value is string => value !== undefined)
  const taken = await takenAdmissionNumbers(client, schoolId, supplied)

  const errors: RowError[] = []
  const valid: StoredImportRow[] = []
  const seen = new Map<string, number>()

  for (const row of request.rows) {
    const problems: RowError[] = []
    const sectionId = sections.get(key(row.grade, row.section))
    if (!sectionId) {
      problems.push({
        row: row.rowNumber,
        field: 'section',
        message: 'No class and section with these names exists in this academic year.',
      })
    }
    // A blank admission number is not a problem: the server assigns one at
    // commit, in row order. A supplied one is a school's own historical
    // number and is kept exactly, so it still has to be free.
    const admissionNumber = row.admissionNumber?.trim()
    if (admissionNumber && taken.has(admissionNumber)) {
      problems.push({ row: row.rowNumber, field: 'admissionNumber', message: 'This admission number is already used.' })
    } else if (admissionNumber) {
      const earlier = seen.get(admissionNumber)
      if (earlier !== undefined) {
        problems.push({
          row: row.rowNumber,
          field: 'admissionNumber',
          message: `This admission number is repeated in the sheet, first on row ${earlier}.`,
        })
      }
    }
    if (!isRealPastDate(row.dateOfBirth)) {
      problems.push({ row: row.rowNumber, field: 'dateOfBirth', message: 'Date of birth must be a real past date.' })
    }

    if (problems.length > 0) {
      errors.push(...problems)
      continue
    }
    // Only reachable when every check above passed, so the section is set.
    if (!sectionId) continue
    // Compared exactly, because UNIQUE (school_id, admission_number) is exact:
    // 'abc/1' and 'ABC/1' are two admissible students, not a repeat.
    if (admissionNumber) seen.set(admissionNumber, row.rowNumber)
    valid.push(storedRow(row, sectionId, admissionNumber, encryptionKey))
  }
  return { validRows: valid, errors }
}

function storedRow(
  row: StudentsBulkImportRow,
  sectionId: string,
  admissionNumber: string | undefined,
  encryptionKey: string,
): StoredImportRow {
  // Optional fields are left out rather than stored as null, so the stored row
  // reads exactly like the contract it came from.
  return {
    rowNumber: row.rowNumber,
    ...(admissionNumber === undefined ? {} : { admissionNumber }),
    firstName: row.firstName,
    ...(row.lastName === undefined ? {} : { lastName: row.lastName }),
    dateOfBirth: row.dateOfBirth,
    gender: row.gender,
    sectionId,
    ...(row.rollNumber === undefined ? {} : { rollNumber: row.rollNumber }),
    ...(row.fatherName === undefined ? {} : { fatherName: row.fatherName }),
    ...(row.motherName === undefined ? {} : { motherName: row.motherName }),
    guardianPhone: normalisePhone(row.guardianPhone),
    ...(row.guardianEmail === undefined ? {} : { guardianEmail: row.guardianEmail }),
    ...(row.city === undefined ? {} : { city: row.city }),
    ...(row.state === undefined ? {} : { state: row.state }),
    ...(row.pincode === undefined ? {} : { pincode: row.pincode }),
    ...(row.category === undefined ? {} : { category: row.category }),
    ...(row.admissionType === undefined ? {} : { admissionType: row.admissionType }),
    // The contract has already checked and normalised each number; only the
    // sealed form and its last four are kept from here on.
    ...(row.studentAadhaar === undefined
      ? {}
      : { studentAadhaar: sealAadhaar(row.studentAadhaar, encryptionKey) }),
    ...(row.guardianAadhaar === undefined
      ? {}
      : { guardianAadhaar: sealAadhaar(row.guardianAadhaar, encryptionKey) }),
    ...(row.guardianPan === undefined ? {} : { guardianPan: sealPan(row.guardianPan, encryptionKey) }),
    ...(row.guardianOfficeAddress === undefined || row.guardianOfficeAddress === ''
      ? {}
      : { guardianOfficeAddress: row.guardianOfficeAddress }),
  }
}

interface PreviewRecord {
  id: string
  academic_year_id: string
  status: string
  version: number
  rows: StoredImportRow[]
  created_by_membership_id: string
  expired: boolean
}

/**
 * The staged preview, locked for this transaction. Locking here is what makes
 * a double submit safe: the second attempt waits, then sees status committed.
 */
export async function lockPreview(
  client: PoolClient,
  context: RequestContext,
  previewId: string,
): Promise<PreviewRecord> {
  const result = await client.query<PreviewRecord>(
    `SELECT id, academic_year_id, status, version, rows, created_by_membership_id,
            (expires_at <= now()) AS expired
       FROM student_import_previews
      WHERE school_id = $1 AND id = $2
        FOR UPDATE`,
    [context.schoolId, previewId],
  )
  const preview = result.rows[0]
  if (!preview) throw new ApiFailure('RESOURCE_NOT_FOUND')
  // A preview belongs to the person who staged it. Somebody else committing it
  // would put their name on rows they never saw.
  if (preview.created_by_membership_id !== context.membershipId) {
    throw new ApiFailure('RESOURCE_NOT_FOUND')
  }
  if (preview.status !== 'pending' || preview.expired) throw new ApiFailure('INVALID_REQUEST')
  return preview
}

/**
 * The second validation pass, against the data as it is now. A preview is
 * minutes old and the school kept working: an admission number may have been
 * taken and a section may have been deleted since. Anything wrong refuses the
 * whole commit, because half an imported sheet is worse than none.
 */
export async function revalidate(
  client: PoolClient,
  schoolId: string,
  academicYearId: string,
  rows: readonly StoredImportRow[],
): Promise<void> {
  if (rows.length === 0) throw new ApiFailure('INVALID_REQUEST')
  // Only the numbers the sheet supplied: the rest are allocated at insert.
  const numbers = rows
    .map((row) => row.admissionNumber)
    .filter((value): value is string => value !== undefined)
  if (new Set(numbers).size !== numbers.length) throw new ApiFailure('INVALID_REQUEST')
  const taken = await takenAdmissionNumbers(client, schoolId, numbers)
  if (taken.size > 0) throw new ApiFailure('INVALID_REQUEST')

  const sectionIds = [...new Set(rows.map((row) => row.sectionId))]
  const sections = await client.query<{ id: string }>(
    `SELECT id FROM sections
      WHERE school_id = $1 AND academic_year_id = $2 AND id = ANY($3::uuid[])`,
    [schoolId, academicYearId, sectionIds],
  )
  if (sections.rowCount !== sectionIds.length) throw new ApiFailure('INVALID_REQUEST')
}

/** Writes one student, their enrollment and one guardian link. The admission
 * number is the one the sheet kept or the one the caller just allocated. */
export async function insertStudent(
  client: PoolClient,
  schoolId: string,
  academicYearId: string,
  row: StoredImportRow,
  admissionNumber: string,
): Promise<void> {
  const address =
    row.city === undefined && row.state === undefined && row.pincode === undefined
      ? null
      : JSON.stringify({
          ...(row.city === undefined ? {} : { city: row.city }),
          ...(row.state === undefined ? {} : { state: row.state }),
          ...(row.pincode === undefined ? {} : { pincode: row.pincode }),
        })

  const student = await client.query<{ id: string }>(
    `INSERT INTO students
       (school_id, admission_number, first_name, last_name, status, date_of_birth,
        gender, category, admission_type, admission_date, address,
        aadhaar_ciphertext, aadhaar_last4)
     VALUES ($1, $2, $3, $4, 'active', $5::date, $6, $7, $8, current_date, $9::jsonb, $10, $11)
     RETURNING id`,
    [
      schoolId,
      admissionNumber,
      row.firstName,
      row.lastName ?? null,
      row.dateOfBirth,
      row.gender,
      row.category ?? null,
      row.admissionType ?? null,
      address,
      row.studentAadhaar?.ciphertext ?? null,
      row.studentAadhaar?.last4 ?? null,
    ],
  )
  const studentId = student.rows[0]?.id
  if (!studentId) throw new ApiFailure('SERVICE_UNAVAILABLE')

  await client.query(
    `INSERT INTO enrollments
       (school_id, student_id, academic_year_id, section_id, roll_number, joined_on, outcome)
     VALUES ($1, $2, $3, $4, $5, current_date, 'ongoing')`,
    [schoolId, studentId, academicYearId, row.sectionId, row.rollNumber ?? null],
  )

  // One sheet row describes one contact. Whose name it carries decides the
  // relationship; with neither name it is simply a guardian.
  const relation = row.fatherName ? 'father' : row.motherName ? 'mother' : 'guardian'
  const guardianName = row.fatherName ?? row.motherName ?? 'Guardian'
  // Held exactly as admission holds them: the office address as a jsonb
  // string, each number as its sealed form and last four.
  const guardian = await client.query<{ id: string }>(
    `INSERT INTO guardians (school_id, first_name, phone, email, office_address,
                            pan_ciphertext, pan_last4, aadhaar_ciphertext, aadhaar_last4)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
     RETURNING id`,
    [
      schoolId,
      guardianName,
      row.guardianPhone,
      row.guardianEmail ?? null,
      row.guardianOfficeAddress === undefined ? null : JSON.stringify(row.guardianOfficeAddress),
      row.guardianPan?.ciphertext ?? null,
      row.guardianPan?.last4 ?? null,
      row.guardianAadhaar?.ciphertext ?? null,
      row.guardianAadhaar?.last4 ?? null,
    ],
  )
  const guardianId = guardian.rows[0]?.id
  if (!guardianId) throw new ApiFailure('SERVICE_UNAVAILABLE')

  await client.query(
    `INSERT INTO student_guardians (school_id, student_id, guardian_id, relation, is_primary)
     VALUES ($1, $2, $3, $4, true)`,
    [schoolId, studentId, guardianId, relation],
  )
}
