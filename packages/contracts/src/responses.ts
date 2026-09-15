import { z } from 'zod'
import { CalendarDate, DisplayName, Id, Phone, Timestamp, Version, pageOf } from './common.ts'
import { PERMISSION_CATALOGUE, PermissionKey } from './permissions.ts'

export const AllowedActions = z.array(PermissionKey).refine(
  (keys) => keys.every((key) => PERMISSION_CATALOGUE[key].availability === 'active') && new Set(keys).size === keys.length,
  'Only unique active permissions may be advertised',
)
export const NamedReference = z.strictObject({ id: Id, name: DisplayName })
export const EnrollmentSummary = z.strictObject({
  id: Id, academicYear: NamedReference, section: NamedReference, grade: NamedReference,
  rollNumber: z.number().int().positive().optional(),
  outcome: z.enum(['ongoing', 'promoted', 'detained', 'left']),
})

export const StudentBasic = z.strictObject({
  id: Id, schoolId: Id, version: Version, firstName: DisplayName, lastName: DisplayName.optional(),
  admissionNumber: z.string().min(1).max(100),
  status: z.enum(['active', 'left', 'alumni', 'suspended']),
  enrollment: EnrollmentSummary.optional(),
})
export const StudentSensitive = z.strictObject({
  dateOfBirth: CalendarDate,
  gender: z.enum(['male', 'female', 'other']),
  category: z.string().max(50).optional(),
  admissionType: z.string().max(50).optional(),
  admissionDate: CalendarDate,
  apaarId: z.string().max(100).optional(),
  aadhaarLast4: z.string().regex(/^\d{4}$/).optional(),
  address: z.string().max(1000).optional(),
})
export const StudentMedical = z.strictObject({
  bloodGroup: z.string().max(20).optional(),
  medicalNotes: z.string().max(4000).optional(),
})
export const GuardianContact = z.strictObject({
  id: Id, displayName: DisplayName,
  relation: z.enum(['father', 'mother', 'guardian', 'grandparent', 'sibling', 'other']),
  phone: Phone,
})
export const GuardianPrivate = z.strictObject({
  id: Id, displayName: DisplayName, phone: Phone,
  occupation: z.string().max(200).optional(),
  annualIncome: z.number().nonnegative().optional(),
  address: z.string().max(1000).optional(),
})
/** Use each field group only after its own authorization; never spread a storage model. */
export const StudentDetailResponse = z.strictObject({
  student: StudentBasic,
  sensitive: StudentSensitive.optional(),
  medical: StudentMedical.optional(),
  guardianContacts: z.array(GuardianContact).optional(),
  allowedActions: AllowedActions,
})
export const StudentListResponse = pageOf(StudentBasic)

export const StaffDirectory = z.strictObject({
  id: Id, schoolId: Id, version: Version, displayName: DisplayName,
  designation: z.string().max(160), department: z.string().max(160).optional(),
})
export const StaffEmployment = z.strictObject({
  employeeCode: z.string().max(100), joiningDate: CalendarDate,
  employmentType: z.enum(['permanent', 'contract', 'part_time', 'probation']),
  status: z.enum(['active', 'on_leave', 'resigned', 'retired']),
})
export const StaffPrivate = z.strictObject({
  phone: Phone, address: z.string().max(1000).optional(),
  dateOfBirth: CalendarDate.optional(), panLast4: z.string().max(4).optional(),
  bankAccountLast4: z.string().regex(/^\d{4}$/).optional(),
})
export const StaffPay = z.strictObject({ monthlySalary: z.number().nonnegative() })
export const StaffDetailResponse = z.strictObject({
  staff: StaffDirectory, employment: StaffEmployment.optional(),
  private: StaffPrivate.optional(), pay: StaffPay.optional(), allowedActions: AllowedActions,
})
export const StaffListResponse = pageOf(StaffDirectory)

/** Document URLs and storage keys deliberately absent. Fetch via the authorized file endpoint. */
export const DocumentSummary = z.strictObject({
  id: Id, studentId: Id, fileName: z.string().min(1).max(255),
  type: z.string().min(1).max(100), sizeBytes: z.number().int().nonnegative(),
  verified: z.boolean(), allowedActions: AllowedActions,
})
export const TeachingAssignmentSummary = z.strictObject({
  id: Id, academicYearId: Id, section: NamedReference, subject: NamedReference,
  teacher: NamedReference, validFrom: CalendarDate, validUntil: CalendarDate.nullable(),
})
export const TimetableCell = z.strictObject({
  section: NamedReference, subject: NamedReference, teacher: NamedReference.nullable(),
  dayOfWeek: z.number().int().min(1).max(6), periodIndex: z.number().int().nonnegative(),
  roomNumber: z.string().max(100).optional(),
})
export const SubstitutionSummary = z.strictObject({
  id: Id, date: CalendarDate, section: NamedReference, subject: NamedReference,
  absentTeacher: NamedReference, substituteTeacher: NamedReference.nullable(),
  periodIndex: z.number().int().nonnegative(), notified: z.boolean(),
})
/** Contextual teacher references contain no employment, pay or private fields. */
export const TimetableResponse = z.strictObject({ cells: z.array(TimetableCell), allowedActions: AllowedActions })

/** No arbitrary `changes: unknown` field that could smuggle private records or credentials. */
export const AuditEventSummary = z.strictObject({
  id: Id, at: Timestamp, actorDisplayName: DisplayName,
  action: z.string().min(1).max(100), summary: z.string().max(500),
  outcome: z.enum(['allowed', 'denied']),
})
export const AuditListResponse = pageOf(AuditEventSummary)
export const DashboardResponse = z.discriminatedUnion('audience', [
  z.strictObject({ audience: z.literal('office'), activeStudents: z.number().int().nonnegative(), staffCount: z.number().int().nonnegative() }),
  z.strictObject({ audience: z.literal('teacher'), assignedSections: z.array(NamedReference), ownTimetable: z.array(TimetableCell) }),
  z.strictObject({ audience: z.literal('parent'), children: z.array(StudentBasic) }),
  z.strictObject({ audience: z.literal('accountant'), message: z.literal('Financial modules are not enabled yet') }),
])

export type StudentBasic = z.infer<typeof StudentBasic>
export type StaffDirectory = z.infer<typeof StaffDirectory>
