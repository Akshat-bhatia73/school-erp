/**
 * The columns a person may choose for a student or staff list export, and the
 * permission each one needs on the row as well as the export key itself.
 *
 * The screen offers a column only when the person holds its key at school
 * level (`hasPermission`); the producer decides it again for every row when
 * it makes the file, so a row outside the key's scope gets an empty cell,
 * never the value. A column with no extra key is covered by the export key.
 */
import { z } from 'zod'
import type { PermissionKey } from './permissions.ts'

interface ExportColumnSpec {
  readonly label: string
  /** The key the row must pass on top of the export key; absent when the export key is enough. */
  readonly permission?: PermissionKey
  /** In the file when the request names no columns. */
  readonly byDefault: boolean
}

export const STUDENT_EXPORT_COLUMNS = {
  admissionNumber: { label: 'Admission number', byDefault: true },
  name: { label: 'Name', byDefault: true },
  grade: { label: 'Class', byDefault: true },
  section: { label: 'Section', byDefault: true },
  rollNumber: { label: 'Roll number', byDefault: true },
  status: { label: 'Status', byDefault: true },
  gender: { label: 'Gender', permission: 'students.read_sensitive', byDefault: false },
  dateOfBirth: { label: 'Date of birth', permission: 'students.read_sensitive', byDefault: false },
  category: { label: 'Category', permission: 'students.read_sensitive', byDefault: false },
  admissionDate: { label: 'Admission date', permission: 'students.read_sensitive', byDefault: false },
  address: { label: 'Address', permission: 'students.read_sensitive', byDefault: false },
  fatherName: { label: "Father's name", permission: 'students.read_guardian_contact', byDefault: false },
  fatherPhone: { label: "Father's phone", permission: 'students.read_guardian_contact', byDefault: false },
  motherName: { label: "Mother's name", permission: 'students.read_guardian_contact', byDefault: false },
  motherPhone: { label: "Mother's phone", permission: 'students.read_guardian_contact', byDefault: false },
  guardianName: { label: 'Main contact name', permission: 'students.read_guardian_contact', byDefault: false },
  guardianPhone: { label: 'Main contact phone', permission: 'students.read_guardian_contact', byDefault: false },
  bloodGroup: { label: 'Blood group', permission: 'students.read_medical', byDefault: false },
  pen: { label: 'PEN (UDISE+)', permission: 'students.read_sensitive', byDefault: false },
  srn: { label: 'SRN', permission: 'students.read_sensitive', byDefault: false },
  apaarLast4: { label: 'APAAR id (last 4 digits)', permission: 'students.read_sensitive', byDefault: false },
  aadhaarLast4: { label: 'Aadhaar (last 4 digits)', permission: 'students.read_sensitive', byDefault: false },
  aadhaar: { label: 'Aadhaar (full number)', permission: 'students.export_identity', byDefault: false },
} as const satisfies Record<string, ExportColumnSpec>

export const STAFF_EXPORT_COLUMNS = {
  employeeCode: { label: 'Employee code', byDefault: true },
  name: { label: 'Name', byDefault: true },
  designation: { label: 'Role', byDefault: true },
  department: { label: 'Department', byDefault: true },
  status: { label: 'Status', byDefault: true },
  staffType: { label: 'Staff type', permission: 'staff.read_employment', byDefault: false },
  employmentType: { label: 'Employment type', permission: 'staff.read_employment', byDefault: false },
  joiningDate: { label: 'Joining date', permission: 'staff.read_employment', byDefault: false },
  qualification: { label: 'Qualification', permission: 'staff.read_employment', byDefault: false },
  gender: { label: 'Gender', permission: 'staff.read_employment', byDefault: false },
  dateOfBirth: { label: 'Date of birth', permission: 'staff.read_private', byDefault: false },
  phone: { label: 'Phone', permission: 'staff.read_private', byDefault: false },
  email: { label: 'Email', permission: 'staff.read_private', byDefault: false },
  address: { label: 'Address', permission: 'staff.read_private', byDefault: false },
  aadhaarLast4: { label: 'Aadhaar (last 4 digits)', permission: 'staff.read_private', byDefault: false },
  aadhaar: { label: 'Aadhaar (full number)', permission: 'staff.export_identity', byDefault: false },
} as const satisfies Record<string, ExportColumnSpec>

export type StudentExportColumn = keyof typeof STUDENT_EXPORT_COLUMNS
export type StaffExportColumn = keyof typeof STAFF_EXPORT_COLUMNS

const keysOf = <T extends object>(value: T) => Object.keys(value) as [keyof T & string, ...(keyof T & string)[]]

export const StudentExportColumn = z.enum(keysOf(STUDENT_EXPORT_COLUMNS))
export const StaffExportColumn = z.enum(keysOf(STAFF_EXPORT_COLUMNS))

/** The columns in the file order, which is the order above whatever order the request used. */
const columnList = <T extends string>(column: z.ZodType<T>) =>
  z.array(column).min(1).max(40).refine((list) => new Set(list).size === list.length, 'A column may appear once')

export const StudentExportColumns = columnList(StudentExportColumn)
export const StaffExportColumns = columnList(StaffExportColumn)

export const DEFAULT_STUDENT_EXPORT_COLUMNS = (Object.keys(STUDENT_EXPORT_COLUMNS) as StudentExportColumn[])
  .filter((key) => STUDENT_EXPORT_COLUMNS[key].byDefault)
export const DEFAULT_STAFF_EXPORT_COLUMNS = (Object.keys(STAFF_EXPORT_COLUMNS) as StaffExportColumn[])
  .filter((key) => STAFF_EXPORT_COLUMNS[key].byDefault)
