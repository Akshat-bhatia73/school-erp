import { z } from 'zod'
import { Address, BloodGroup, Gender, ISODate, Id, IndianPhone, TenantRecord } from './common'

export const StaffType = z.enum(['teaching', 'non_teaching', 'admin', 'support'])
export type StaffType = z.infer<typeof StaffType>

export const EmploymentType = z.enum(['permanent', 'contract', 'part_time', 'probation'])
export type EmploymentType = z.infer<typeof EmploymentType>

export const StaffStatus = z.enum(['active', 'on_leave', 'resigned', 'retired'])
export type StaffStatus = z.infer<typeof StaffStatus>

export const Staff = TenantRecord.extend({
  employeeCode: z.string(),
  firstName: z.string().min(1),
  lastName: z.string().optional(),
  gender: Gender,
  dateOfBirth: ISODate.optional(),
  bloodGroup: BloodGroup.default('unknown'),
  phone: IndianPhone,
  email: z.string().email().optional(),
  photoUrl: z.string().optional(),
  address: Address.optional(),
  staffType: StaffType,
  designation: z.string(), // "PGT Mathematics", "Office Clerk", "Principal"
  department: z.string().optional(), // "Science", "Administration"
  employmentType: EmploymentType,
  joiningDate: ISODate,
  leavingDate: ISODate.optional(),
  qualification: z.string().optional(), // "M.Sc, B.Ed"
  experienceYears: z.number().optional(),
  /** Visible to Owner and Accountant only */
  monthlySalary: z.number().optional(),
  bankAccountLast4: z.string().optional(),
  panLast4: z.string().optional(),
  status: StaffStatus,
  /** Linked login user, if any */
  userId: Id.optional(),
})
export type Staff = z.infer<typeof Staff>

/** Teacher X teaches Subject Y to Section Z in year W */
export const TeachingAssignment = TenantRecord.extend({
  staffId: Id,
  academicYearId: Id,
  sectionId: Id,
  subjectId: Id,
})
export type TeachingAssignment = z.infer<typeof TeachingAssignment>

export const StaffInput = Staff.omit({ id: true, createdAt: true, updatedAt: true, schoolId: true, userId: true })
export type StaffInput = z.infer<typeof StaffInput>
