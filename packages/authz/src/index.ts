export { AuthorizationError } from './errors.ts'
export { evaluate, explain, fieldGroupsFor, matchesScope } from './policy.ts'
export type { EvaluateInput, RelationshipFacts, ResourceFacts } from './policy.ts'
export {
  assignableRolesFor,
  checkMembershipLifecycle,
  checkRoleAssignment,
  mayTransferOwnership,
} from './delegation.ts'
export type { DelegationDenial, DelegationResult } from './delegation.ts'
export {
  loadMembershipState,
  loadMembershipStateById,
  loadPolicySnapshot,
  loadPolicySnapshotFor,
  loadRelationshipFacts,
  loadRelationshipFactsFor,
  loadResourceFacts,
  loadRoleKeys,
} from './snapshot.ts'
export type { AuthzConnection, MembershipState } from './snapshot.ts'
export {
  assertAccessVersionCurrent,
  commitAccessChange,
  lockMembershipForAccessChange,
} from './versioning.ts'
export type { LockedMembership } from './versioning.ts'
export {
  attendanceScopedTable,
  createReadPlan,
  examScopedTable,
  feeScopedTable,
  planPredicate,
  planPredicateWithout,
  reportCardScopedTable,
  scopedGet,
  scopedList,
  scopedTableFor,
  staffAttendanceScopedTable,
} from './scope.ts'
export type {
  AttendanceTableKind,
  ExamTableKind,
  FeeTableKind,
  ReportCardTableKind,
  PageRequest,
  ScopedTable,
  StaffAttendanceTableKind,
} from './scope.ts'
export { createAuthorizationService } from './service.ts'
export type { AuthorizationServiceOptions, SchoolAuthorizationService } from './service.ts'
