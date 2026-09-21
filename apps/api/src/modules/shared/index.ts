export { protectedRoute } from './route.ts'
export type { ModuleDependencies, RouteDefinition, RouteInput, RouteMethod } from './route.ts'
export {
  allowedActionsFor,
  authorizeResource,
  authorizeSchoolAction,
  decideResource,
  decideSchoolAction,
  readPlan,
  requiresMfa,
} from './authorize.ts'
export { lockSchool, recordAuditEvent, writeAudit } from './audit.ts'
export type { ModuleAuditEntry, TenantConnection } from './audit.ts'
export { ApiFailure, assertAllowed, assertUuidParam, requireFound } from './errors.ts'
export {
  allocateAdmissionNumber,
  allocateEmployeeCode,
  formatAdmissionNumber,
  formatCounter,
  formatEmployeeCode,
  schoolPrefix,
} from './sequences.ts'
export { assertVersion, bumpVersion } from './version.ts'
export type { VersionedTable } from './version.ts'
export { maskApaar, open, seal } from './crypto.ts'
