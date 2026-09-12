import { z } from 'zod'
import { Address, BloodGroup, Gender, ISODate, Id, IndianPhone, SocialCategory, TenantRecord } from './common'

export const StudentStatus = z.enum(['active', 'left', 'alumni', 'suspended'])
export type StudentStatus = z.infer<typeof StudentStatus>

export const AdmissionType = z.enum(['regular', 'rte', 'staff_ward', 'scholarship'])
export type AdmissionType = z.infer<typeof AdmissionType>

export const Student = TenantRecord.extend({
  admissionNumber: z.string(),
  /** Government issued national student id, optional */
  apaarId: z.string().optional(),
  firstName: z.string().min(1),
  lastName: z.string().optional(),
  dateOfBirth: ISODate,
  gender: Gender,
  bloodGroup: BloodGroup.default('unknown'),
  category: SocialCategory.default('general'),
  religion: z.string().optional(),
  motherTongue: z.string().optional(),
  nationality: z.string().default('Indian'),
  aadhaarLast4: z.string().length(4).optional(),
  photoUrl: z.string().optional(),
  address: Address,
  admissionDate: ISODate,
  admissionType: AdmissionType.default('regular'),
  previousSchool: z.string().optional(),
  status: StudentStatus,
  leftOn: ISODate.optional(),
  leftReason: z.string().optional(),
  /** House / colour group, optional */
  house: z.string().optional(),
  /** Free-form medical notes, allergies etc. */
  medicalNotes: z.string().optional(),
  /** Transport: does the student use school transport */
  usesTransport: z.boolean().default(false),
})
export type Student = z.infer<typeof Student>

/** Which section a student sits in, per academic year. Promotion creates a new row. */
export const Enrollment = TenantRecord.extend({
  studentId: Id,
  academicYearId: Id,
  sectionId: Id,
  rollNumber: z.number().int().optional(),
  joinedOn: ISODate,
  leftOn: ISODate.optional(),
  /** promoted | detained | new | transferred_out */
  outcome: z.enum(['ongoing', 'promoted', 'detained', 'left']).default('ongoing'),
})
export type Enrollment = z.infer<typeof Enrollment>

export const GuardianRelation = z.enum(['father', 'mother', 'guardian', 'grandparent', 'sibling', 'other'])
export type GuardianRelation = z.infer<typeof GuardianRelation>

/** A parent or guardian. Shared across siblings. Phone is the login. */
export const Guardian = TenantRecord.extend({
  firstName: z.string().min(1),
  lastName: z.string().optional(),
  phone: IndianPhone,
  altPhone: z.string().optional(),
  email: z.string().email().optional(),
  occupation: z.string().optional(),
  qualification: z.string().optional(),
  annualIncome: z.number().optional(),
  address: Address.optional(),
  photoUrl: z.string().optional(),
})
export type Guardian = z.infer<typeof Guardian>

export const StudentGuardian = TenantRecord.extend({
  studentId: Id,
  guardianId: Id,
  relation: GuardianRelation,
  isPrimary: z.boolean().default(false),
  /** Whether this guardian receives fee and attendance messages */
  receivesNotifications: z.boolean().default(true),
})
export type StudentGuardian = z.infer<typeof StudentGuardian>

export const DocumentType = z.enum([
  'birth_certificate',
  'previous_marksheet',
  'transfer_certificate',
  'aadhaar',
  'photo',
  'caste_certificate',
  'income_certificate',
  'medical_certificate',
  'other',
])
export type DocumentType = z.infer<typeof DocumentType>

export const StudentDocument = TenantRecord.extend({
  studentId: Id,
  type: DocumentType,
  fileName: z.string(),
  fileUrl: z.string(),
  sizeBytes: z.number().int(),
  uploadedBy: Id,
  verified: z.boolean().default(false),
})
export type StudentDocument = z.infer<typeof StudentDocument>

// ---- Inputs ----
export const GuardianInput = Guardian.omit({ id: true, createdAt: true, updatedAt: true, schoolId: true })
export type GuardianInput = z.infer<typeof GuardianInput>

export const StudentInput = Student.omit({ id: true, createdAt: true, updatedAt: true, schoolId: true }).extend({
  /** On create: which section to enrol into */
  sectionId: Id,
  rollNumber: z.number().int().optional(),
  guardians: z
    .array(
      z.object({
        guardianId: Id.optional(),
        guardian: GuardianInput.optional(),
        relation: GuardianRelation,
        isPrimary: z.boolean().default(false),
      }),
    )
    .min(1, 'Add at least one parent or guardian'),
})
export type StudentInput = z.infer<typeof StudentInput>

/** A row from the Excel import, after validation */
export const StudentImportRow = z.object({
  rowNumber: z.number().int(),
  admissionNumber: z.string().optional(),
  firstName: z.string(),
  lastName: z.string().optional(),
  dateOfBirth: ISODate,
  gender: Gender,
  grade: z.string(), // "Class 6"
  section: z.string(), // "A"
  rollNumber: z.number().int().optional(),
  fatherName: z.string().optional(),
  motherName: z.string().optional(),
  guardianPhone: IndianPhone,
  guardianEmail: z.string().email().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  pincode: z.string().optional(),
  category: SocialCategory.optional(),
  admissionType: AdmissionType.optional(),
})
export type StudentImportRow = z.infer<typeof StudentImportRow>

export interface ImportRowError {
  rowNumber: number
  field?: string
  message: string
}

export interface ImportPreview {
  validRows: StudentImportRow[]
  errors: ImportRowError[]
  totalRows: number
}

/** Year-end promotion request */
export const PromotionInput = z.object({
  fromAcademicYearId: Id,
  toAcademicYearId: Id,
  fromSectionId: Id,
  toSectionId: Id,
  /** student ids to move; others in the section are left where they are */
  studentIds: z.array(Id),
  /** student ids to detain (stay in same grade, new year) */
  detainStudentIds: z.array(Id).default([]),
})
export type PromotionInput = z.infer<typeof PromotionInput>
