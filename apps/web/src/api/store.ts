/**
 * In-memory dummy data store.
 * This stands in for the backend during the dummy-data phase.
 * Every mutation writes an audit log row, like the real backend will.
 */
import type {
  AcademicYear,
  AuditLog,
  BellSchedule,
  Enrollment,
  Grade,
  GradeSubject,
  Guardian,
  Holiday,
  Role,
  School,
  Section,
  Staff,
  Student,
  StudentDocument,
  StudentGuardian,
  Subject,
  Substitution,
  TeachingAssignment,
  TimetableEntry,
  User,
} from '@erp/shared'
import { seed } from './seed'

export interface Store {
  schools: School[]
  academicYears: AcademicYear[]
  grades: Grade[]
  sections: Section[]
  subjects: Subject[]
  gradeSubjects: GradeSubject[]
  holidays: Holiday[]
  students: Student[]
  enrollments: Enrollment[]
  guardians: Guardian[]
  studentGuardians: StudentGuardian[]
  documents: StudentDocument[]
  staff: Staff[]
  teachingAssignments: TeachingAssignment[]
  roles: Role[]
  users: User[]
  auditLogs: AuditLog[]
  bellSchedules: BellSchedule[]
  timetableEntries: TimetableEntry[]
  substitutions: Substitution[]
}

let _store: Store | null = null

export function getStore(): Store {
  if (!_store) _store = seed()
  return _store
}

export function resetStore() {
  _store = seed()
}

let counter = 1000
export function newId(prefix: string) {
  counter += 1
  return `${prefix}_${counter.toString(36)}`
}

export function nowIso() {
  return new Date().toISOString()
}

/** Simulate network latency so loading states are visible */
export function delay(ms = 150) {
  return new Promise((r) => setTimeout(r, ms))
}
