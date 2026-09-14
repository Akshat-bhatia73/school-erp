import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Drizzle's typed view of the tenant tables. The migration is authoritative for
 * RLS, triggers and cross-table constraints that cannot be represented safely
 * in an ORM declaration.
 */
const id = () => uuid('id').defaultRandom().primaryKey()
const tenant = () => uuid('school_id').notNull()
const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const membershipStatus = pgEnum('membership_status', [
  'active',
  'suspended',
  'removed',
])
export const membershipKind = pgEnum('membership_kind', ['adult', 'student'])
export const invitationStatus = pgEnum('invitation_status', [
  'pending',
  'accepted',
  'revoked',
  'expired',
])
export const accessEffect = pgEnum('access_effect', ['allow', 'deny'])
export const deliveryStatus = pgEnum('delivery_status', [
  'queued',
  'processing',
  'sent',
  'failed',
  'dead_letter',
])

// Better Auth core + phone + two-factor plugin tables. They deliberately have
// no school_id: identity is global and is never selected through tenant RLS.
export const authUsers = pgTable('auth_user', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  phoneNumber: text('phone_number').unique(),
  phoneNumberVerified: boolean('phone_number_verified')
    .notNull()
    .default(false),
  twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
  ...timestamps(),
})
export const authSessions = pgTable(
  'auth_session',
  {
    id: id(),
    token: text('token').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
    sharedDevice: boolean('shared_device').notNull().default(false),
    ...timestamps(),
  },
  (t) => [index('auth_session_user_idx').on(t.userId)],
)
// Better Auth rateLimit model with storage "database". Global auth table.
export const authRateLimit = pgTable('auth_rate_limit', {
  id: id(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull().default(0),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull().default(0),
})
// Our own throttling store: budgets Better Auth must not prune.
export const authThrottle = pgTable('auth_throttle', {
  id: id(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull().default(0),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})
export const authAccounts = pgTable(
  'auth_account',
  {
    id: id(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    password: text('password'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      withTimezone: true,
    }),
    scope: text('scope'),
    ...timestamps(),
  },
  (t) => [
    unique('auth_account_provider_account_unique').on(
      t.providerId,
      t.accountId,
    ),
  ],
)
export const authVerifications = pgTable(
  'auth_verification',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [index('auth_verification_identifier_idx').on(t.identifier)],
)
export const authTwoFactor = pgTable('auth_two_factor', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  verified: boolean('verified').notNull().default(true),
  failedVerificationCount: integer('failed_verification_count')
    .notNull()
    .default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  ...timestamps(),
})

export const schools = pgTable('schools', {
  id: id(),
  loginCode: text('login_code').notNull().unique(),
  name: text('name').notNull(),
  shortName: text('short_name').notNull(),
  status: text('status').notNull().default('active'),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  board: text('board'),
  affiliationNumber: text('affiliation_number'),
  udiseCode: text('udise_code'),
  address: jsonb('address').notNull(),
  phone: text('phone'),
  email: text('email'),
  website: text('website'),
  principalName: text('principal_name'),
  establishedYear: integer('established_year'),
  logoUrl: text('logo_url'),
  accessVersion: integer('access_version').notNull().default(1),
  currentAcademicYearId: uuid('current_academic_year_id'),
  ...timestamps(),
})
export const schoolMemberships = pgTable(
  'school_memberships',
  {
    id: id(),
    schoolId: tenant().references(() => schools.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'restrict' }),
    kind: membershipKind('kind').notNull(),
    status: membershipStatus('status').notNull().default('active'),
    version: integer('version').notNull().default(1),
    accessVersion: integer('access_version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    unique('school_membership_school_user_unique').on(t.schoolId, t.userId),
    unique('school_membership_school_id_unique').on(t.schoolId, t.id),
    index('school_membership_school_user_idx').on(t.schoolId, t.userId),
  ],
)
export const roles = pgTable(
  'roles',
  {
    id: id(),
    schoolId: tenant().references(() => schools.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    unique('roles_school_key_unique').on(t.schoolId, t.key),
    unique('roles_school_id_unique').on(t.schoolId, t.id),
  ],
)
export const rolePermissions = pgTable(
  'role_permissions',
  {
    schoolId: tenant(),
    roleId: uuid('role_id').notNull(),
    permission: text('permission').notNull(),
    scope: text('scope').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.roleId, t.permission, t.scope] }),
    index('role_permissions_school_role_idx').on(t.schoolId, t.roleId),
  ],
)
export const membershipRoles = pgTable(
  'membership_roles',
  {
    schoolId: tenant(),
    membershipId: uuid('membership_id').notNull(),
    roleId: uuid('role_id').notNull(),
    assignedByMembershipId: uuid('assigned_by_membership_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.schoolId, t.membershipId, t.roleId] })],
)

export const academicYears = pgTable(
  'academic_years',
  {
    id: id(),
    schoolId: tenant(),
    name: text('name').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    unique('academic_years_school_id_unique').on(t.schoolId, t.id),
    unique('academic_years_school_name_unique').on(t.schoolId, t.name),
  ],
)
export const grades = pgTable(
  'grades',
  {
    id: id(),
    schoolId: tenant(),
    name: text('name').notNull(),
    shortName: text('short_name').notNull(),
    sortOrder: integer('sort_order').notNull(),
    stream: text('stream'),
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    unique('grades_school_id_unique').on(t.schoolId, t.id),
    unique('grades_school_name_unique').on(t.schoolId, t.name),
  ],
)
export const staff = pgTable(
  'staff',
  {
    id: id(),
    schoolId: tenant(),
    employeeCode: text('employee_code').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name'),
    staffType: text('staff_type').notNull(),
    designation: text('designation').notNull(),
    status: text('status').notNull(),
    gender: text('gender'),
    dateOfBirth: date('date_of_birth'),
    bloodGroup: text('blood_group'),
    phone: text('phone'),
    email: text('email'),
    photoUrl: text('photo_url'),
    address: jsonb('address'),
    department: text('department'),
    employmentType: text('employment_type'),
    joiningDate: date('joining_date'),
    leavingDate: date('leaving_date'),
    qualification: text('qualification'),
    experienceYears: numeric('experience_years'),
    monthlySalary: numeric('monthly_salary'),
    bankAccountLast4: text('bank_account_last4'),
    panLast4: text('pan_last4'),
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    unique('staff_school_id_unique').on(t.schoolId, t.id),
    unique('staff_school_employee_unique').on(t.schoolId, t.employeeCode),
  ],
)
export const sections = pgTable(
  'sections',
  {
    id: id(),
    schoolId: tenant(),
    gradeId: uuid('grade_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    name: text('name').notNull(),
    classTeacherStaffId: uuid('class_teacher_staff_id'),
    roomNumber: text('room_number'),
    capacity: integer('capacity'),
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    unique('sections_school_id_unique').on(t.schoolId, t.id),
    unique('sections_school_year_grade_name_unique').on(
      t.schoolId,
      t.academicYearId,
      t.gradeId,
      t.name,
    ),
  ],
)
export const subjects = pgTable(
  'subjects',
  {
    id: id(),
    schoolId: tenant(),
    name: text('name').notNull(),
    code: text('code').notNull(),
    type: text('type').notNull(),
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    unique('subjects_school_id_unique').on(t.schoolId, t.id),
    unique('subjects_school_code_unique').on(t.schoolId, t.code),
  ],
)
export const gradeSubjects = pgTable(
  'grade_subjects',
  {
    schoolId: tenant(),
    gradeId: uuid('grade_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    isOptional: boolean('is_optional').notNull().default(false),
  },
  (t) => [
    primaryKey({
      columns: [t.schoolId, t.gradeId, t.academicYearId, t.subjectId],
    }),
  ],
)
export const holidays = pgTable(
  'holidays',
  {
    id: id(),
    schoolId: tenant(),
    academicYearId: uuid('academic_year_id').notNull(),
    name: text('name').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    type: text('type').notNull(),
    ...timestamps(),
  },
  (t) => [unique('holidays_school_id_unique').on(t.schoolId, t.id)],
)
export const students = pgTable(
  'students',
  {
    id: id(),
    schoolId: tenant(),
    admissionNumber: text('admission_number').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name'),
    status: text('status').notNull(),
    dateOfBirth: date('date_of_birth'),
    gender: text('gender'),
    bloodGroup: text('blood_group'),
    category: text('category'),
    religion: text('religion'),
    motherTongue: text('mother_tongue'),
    nationality: text('nationality'),
    aadhaarLast4: text('aadhaar_last4'),
    apaarId: text('apaar_id'),
    photoUrl: text('photo_url'),
    address: jsonb('address'),
    admissionDate: date('admission_date'),
    admissionType: text('admission_type'),
    previousSchool: text('previous_school'),
    leftOn: date('left_on'),
    leftReason: text('left_reason'),
    house: text('house'),
    medicalNotes: text('medical_notes'),
    usesTransport: boolean('uses_transport').notNull().default(false),
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    unique('students_school_id_unique').on(t.schoolId, t.id),
    unique('students_school_admission_unique').on(
      t.schoolId,
      t.admissionNumber,
    ),
    index('students_school_status_idx').on(t.schoolId, t.status),
  ],
)
export const guardians = pgTable(
  'guardians',
  {
    id: id(),
    schoolId: tenant(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name'),
    phone: text('phone'),
    altPhone: text('alt_phone'),
    email: text('email'),
    occupation: text('occupation'),
    qualification: text('qualification'),
    annualIncome: numeric('annual_income'),
    address: jsonb('address'),
    photoUrl: text('photo_url'),
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [unique('guardians_school_id_unique').on(t.schoolId, t.id)],
)
export const enrollments = pgTable(
  'enrollments',
  {
    id: id(),
    schoolId: tenant(),
    studentId: uuid('student_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    sectionId: uuid('section_id').notNull(),
    rollNumber: integer('roll_number'),
    joinedOn: date('joined_on').notNull(),
    leftOn: date('left_on'),
    outcome: text('outcome').notNull().default('ongoing'),
    ...timestamps(),
  },
  (t) => [
    unique('enrollments_school_id_unique').on(t.schoolId, t.id),
    index('enrollments_school_student_idx').on(t.schoolId, t.studentId),
    index('enrollments_school_section_idx').on(t.schoolId, t.sectionId),
  ],
)
export const studentGuardians = pgTable(
  'student_guardians',
  {
    schoolId: tenant(),
    studentId: uuid('student_id').notNull(),
    guardianId: uuid('guardian_id').notNull(),
    relation: text('relation').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    receivesNotifications: boolean('receives_notifications')
      .notNull()
      .default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.schoolId, t.studentId, t.guardianId] })],
)
export const studentDocuments = pgTable(
  'student_documents',
  {
    id: id(),
    schoolId: tenant(),
    studentId: uuid('student_id').notNull(),
    documentType: text('document_type').notNull(),
    fileName: text('file_name').notNull(),
    storageKey: text('storage_key').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    uploadedByMembershipId: uuid('uploaded_by_membership_id'),
    verified: boolean('verified').notNull().default(false),
    ...timestamps(),
  },
  (t) => [unique('student_documents_school_id_unique').on(t.schoolId, t.id)],
)
export const teachingAssignments = pgTable(
  'teaching_assignments',
  {
    id: id(),
    schoolId: tenant(),
    staffId: uuid('staff_id').notNull(),
    academicYearId: uuid('academic_year_id').notNull(),
    sectionId: uuid('section_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    ...timestamps(),
  },
  (t) => [
    index('teaching_assignments_scope_idx').on(
      t.schoolId,
      t.staffId,
      t.academicYearId,
      t.sectionId,
      t.subjectId,
    ),
  ],
)
export const bellSchedules = pgTable(
  'bell_schedules',
  {
    id: id(),
    schoolId: tenant(),
    academicYearId: uuid('academic_year_id').notNull(),
    name: text('name').notNull(),
    gradeIds: uuid('grade_ids').array().notNull(),
    workingDays: smallint('working_days').array().notNull(),
    periods: jsonb('periods').notNull(),
    saturdayPeriodCount: integer('saturday_period_count'),
    ...timestamps(),
  },
  (t) => [unique('bell_schedules_school_id_unique').on(t.schoolId, t.id)],
)
export const timetableEntries = pgTable(
  'timetable_entries',
  {
    id: id(),
    schoolId: tenant(),
    academicYearId: uuid('academic_year_id').notNull(),
    sectionId: uuid('section_id').notNull(),
    dayOfWeek: smallint('day_of_week').notNull(),
    periodIndex: integer('period_index').notNull(),
    subjectId: uuid('subject_id').notNull(),
    staffId: uuid('staff_id'),
    roomNumber: text('room_number'),
    ...timestamps(),
  },
  (t) => [
    unique('timetable_entries_slot_unique').on(
      t.schoolId,
      t.academicYearId,
      t.sectionId,
      t.dayOfWeek,
      t.periodIndex,
    ),
  ],
)
export const bellScheduleGrades = pgTable(
  'bell_schedule_grades',
  {
    schoolId: tenant(),
    bellScheduleId: uuid('bell_schedule_id').notNull(),
    gradeId: uuid('grade_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.schoolId, t.bellScheduleId, t.gradeId] })],
)
export const substitutions = pgTable('substitutions', {
  id: id(),
  schoolId: tenant(),
  date: date('date').notNull(),
  sectionId: uuid('section_id').notNull(),
  periodIndex: integer('period_index').notNull(),
  subjectId: uuid('subject_id').notNull(),
  absentStaffId: uuid('absent_staff_id').notNull(),
  substituteStaffId: uuid('substitute_staff_id'),
  reason: text('reason'),
  notified: boolean('notified').notNull().default(false),
  ...timestamps(),
})
export const membershipStaffLinks = pgTable(
  'membership_staff_links',
  {
    schoolId: tenant(),
    membershipId: uuid('membership_id').notNull(),
    staffId: uuid('staff_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.membershipId] }),
    unique('membership_staff_links_school_staff_unique').on(
      t.schoolId,
      t.staffId,
    ),
  ],
)
export const membershipGuardianLinks = pgTable(
  'membership_guardian_links',
  {
    schoolId: tenant(),
    membershipId: uuid('membership_id').notNull(),
    guardianId: uuid('guardian_id').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.membershipId] }),
    unique('membership_guardian_links_school_guardian_unique').on(
      t.schoolId,
      t.guardianId,
    ),
  ],
)
export const guardianStudentAccess = pgTable(
  'guardian_student_access',
  {
    schoolId: tenant(),
    guardianId: uuid('guardian_id').notNull(),
    studentId: uuid('student_id').notNull(),
    status: text('status').notNull(),
    areas: text('areas').array().notNull(),
    approvedByMembershipId: uuid('approved_by_membership_id').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.schoolId, t.guardianId, t.studentId] })],
)
export const membershipStudentLinks = pgTable(
  'membership_student_links',
  {
    schoolId: tenant(),
    membershipId: uuid('membership_id').notNull(),
    studentId: uuid('student_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.membershipId] }),
    unique('membership_student_links_school_student_unique').on(
      t.schoolId,
      t.studentId,
    ),
  ],
)
export const invitations = pgTable(
  'school_invitations',
  {
    id: id(),
    schoolId: tenant(),
    identifierType: text('identifier_type').notNull(),
    identifierNormalized: text('identifier_normalized').notNull(),
    destinationMasked: text('destination_masked').notNull(),
    tokenDigest: text('token_digest').notNull().unique(),
    status: invitationStatus('status').notNull().default('pending'),
    proposedRoleKeys: text('proposed_role_keys').array().notNull(),
    displayName: text('display_name').notNull(),
    staffId: uuid('staff_id'),
    inviterMembershipId: uuid('inviter_membership_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    index('invitations_school_pending_idx').on(
      t.schoolId,
      t.status,
      t.expiresAt,
    ),
  ],
)
export const resourceAccessRules = pgTable(
  'resource_access_rules',
  {
    id: id(),
    schoolId: tenant(),
    membershipId: uuid('membership_id').notNull(),
    permission: text('permission').notNull(),
    effect: accessEffect('effect').notNull(),
    targetType: text('target_type').notNull(),
    academicYearId: uuid('academic_year_id'),
    sectionId: uuid('section_id'),
    studentId: uuid('student_id'),
    staffId: uuid('staff_id'),
    documentId: uuid('document_id'),
    effectiveFrom: timestamp('effective_from', {
      withTimezone: true,
    }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    reason: text('reason').notNull(),
    authorMembershipId: uuid('author_membership_id').notNull(),
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    index('access_rules_decision_idx').on(
      t.schoolId,
      t.membershipId,
      t.permission,
      t.expiresAt,
    ),
  ],
)
export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    schoolId: tenant(),
    actorUserId: uuid('actor_user_id'),
    actorMembershipId: uuid('actor_membership_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    result: text('result').notNull(),
    summary: text('summary').notNull(),
    safeChanges: jsonb('safe_changes')
      .notNull()
      .default(sql`'{}'::jsonb`),
    requestId: text('request_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('audit_events_school_created_idx').on(t.schoolId, t.createdAt)],
)
export const deliveryOutbox = pgTable(
  'delivery_outbox',
  {
    id: id(),
    schoolId: tenant(),
    eventType: text('event_type').notNull(),
    destination: text('destination').notNull(),
    payload: jsonb('payload').notNull(),
    status: deliveryStatus('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('delivery_outbox_ready_idx').on(t.status, t.availableAt)],
)

export const schoolTables = [
  schoolMemberships,
  roles,
  rolePermissions,
  membershipRoles,
  academicYears,
  grades,
  staff,
  sections,
  subjects,
  gradeSubjects,
  holidays,
  students,
  guardians,
  enrollments,
  studentGuardians,
  studentDocuments,
  teachingAssignments,
  bellSchedules,
  bellScheduleGrades,
  timetableEntries,
  substitutions,
  membershipStaffLinks,
  membershipGuardianLinks,
  guardianStudentAccess,
  membershipStudentLinks,
  invitations,
  resourceAccessRules,
  auditEvents,
  deliveryOutbox,
] as const
