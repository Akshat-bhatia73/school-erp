# Permission matrix

This document freezes the Task 0 access-control vocabulary. The executable source of truth is `packages/contracts/src/permissions.ts` and `role-templates.ts`. The [generated matrix](PERMISSION_MATRIX.generated.md) lists every exact permission and scope for every role. See [contract rules](CONTRACTS.md) for the checks required in addition to role grants.

## Evaluation rules

- A grant is the pair `(permission, scope)`. There are no wildcards and one action never implies another action.
- Scopes are independent relationship predicates. They are unioned when several grants apply; they are never ranked or promoted to `school`.
- Every check also requires a valid session, active membership, matching school, permitted fields and business state, and no matching deny.
- A role marked `requiredMfa` requires MFA for all school data. Otherwise MFA is required when the matched permission's `privilegedScopes` contains the matched scope.
- `school` is the only scope used for membership, role, ownership, and school-configuration privileges. Relationship scopes cannot grant those actions.
- Fixed role assignment is governed by `ROLE_DELEGATION_RULES`, separately from `roles.assign`. The owner may assign principal, admin, accountant, teacher, or parent. Principal and admin may assign teacher only. Ownership transfer is a separate permission and workflow.
- Owner and accountant are the only default roles with salary permissions. Principal and admin have none.
- Student is disabled and has no active grants. Reserved permissions never appear in a role template.

## Active permissions

| Resource | Permissions | Allowed scopes | Notes |
|---|---|---|---|
| School | `school.read`, `school.update` | school | Update is privileged. |
| Academic years | `academic_years.read`, `academic_years.manage` | school | Manage includes create and lifecycle changes. |
| Grades | `grades.read`, `grades.manage` | school; read also assigned sections/own children | Manage is privileged. |
| Sections | `sections.read`, `sections.read_strengths`, `sections.manage` | school; bounded read/count scopes | Counts use the same authorized population as detail reads. |
| Subjects | `subjects.read`, `subjects.manage` | school; read also assigned subjects/own children | Mapping subjects is manage. |
| Holidays | `holidays.read`, `holidays.manage` | school | Calendar read is broadly safe within an active membership. |
| Students | `students.read_basic`, `read_sensitive`, `read_medical`, `read_guardian_contact`, `read_guardians`, `read_siblings`, `read_documents`, `download_documents`, `read_enrollments`, `create`, `update_basic`, `update_sensitive`, `manage_enrollment`, `manage_guardians`, `import`, `export`, `promote`, `read_consents`, `manage_consents`, `anonymise`, `export_subject` | Per catalogue | Basic, sensitive, medical, guardian, and document responses are separate. Download rechecks authorization. Minimal guardian contact is a separate policy from full guardian access. Consent reads and writes follow the same student scopes, so a parent acts only for an approved child. A subject access export is one permission-gated read that returns only the blocks the caller could already read for that student; a parent may take it for their own child. Anonymisation is school scope only and refused before the retention period. |
| Staff | `staff.read_directory`, `read_employment`, `read_private`, `read_pay`, `create`, `update_employment`, `update_private`, `update_pay`, `manage_assignments`, `export`, `anonymise` | Per catalogue | A teacher's own private profile does not trigger privileged-scope MFA; school/finance private access does. Pay is separate from employment. Anonymisation is school scope only and refused before the retention period. |
| Membership | `members.read`, `invite`, `suspend`, `remove`, `restore`, `manage_credentials` | school only | These are privileged operations. Role input is never accepted by a generic member update. |
| Roles/access | `roles.read`, `roles.assign`, `access.explain` | school only | Fixed templates cannot be edited. Assignment also checks delegation. Access explanations are owner-only by default. |
| Ownership | `ownership.transfer` | school only | Owner-only, fresh MFA, verified target, last-owner lock, and audit event. |
| Audit | `audit.read`, `audit.export`, `audit.redact_notes` | school or finance; redaction is school only | Responses are redacted for the matched audience. The free-text note lives outside `safe_changes` and redaction removes it while the event itself stays. |
| Timetable | `timetable.read`, `manage_periods`, `manage_entries`, `generate`, `read_conflicts`, `read_teacher_loads`, `manage_substitutions`, `notify_substitutions` | Read may use relationship scopes; management is school only | A parent receives minimal teacher attribution nested in the timetable DTO, never directory search. |
| Dashboard | `dashboard.read` | school, self, assigned sections, own children, finance | Each scope has a distinct safe aggregate response. |

## Fixed templates

| Role | Enabled | MFA | Default access |
|---|---:|---:|---|
| Owner | yes | required | All current school operations, salary, membership lifecycle, fixed-role assignment, access explanation, audit, ownership transfer, consent, anonymisation, and audit note redaction. |
| Principal | yes | required | School-wide setup and operations, medical/private records, teacher membership lifecycle and teacher role assignment, consent, and anonymisation; no salary, access explanation, ownership transfer, or audit note redaction. |
| Administrator | yes | required | Setup, student/staff/timetable operations, approved teacher invitation and assignment, and guardian consent records; no medical, salary, audit, membership removal, custom access, or ownership. |
| Accountant | yes | required | Minimal billing identity/contact data, compensation, finance dashboard, and finance-redacted audit; no medical, broad student administration, or access management. |
| Teacher | yes | no by role | Basic students and minimal guardian contact in current assigned sections; own employment/private profile; relevant section/subject/self timetable. No student sensitive/medical/documents, staff directory, salary, or export. |
| Parent | yes | no by role | Basic and enrollment data for approved child links, the guardian contact projection for those children, relevant calendar/setup labels, child timetable, and the consent record of those children, which they may give or withdraw. No sibling inference, full guardian records, documents, staff directory, or school search. |
| Student | no | no | No active grants. Future policy remains reserved and login stays disabled. |

## Reserved permissions

The following names reserve future design space but cannot be granted by active templates: `members.update`, `roles.manage`, `access.manage`, `fees.*`, `attendance.*`, `exams.*`, `communication.*`, `report_cards.*`, `staff_attendance.*`, and `ai_assistant.*`. Implementers must not return fabricated data or expose endpoints merely because a key exists.

## Field and response boundaries

`students.read_basic` excludes medical notes, identity documents, guardian income, and finance-only fields. `students.read_guardian_contact` is limited to the approved name, relationship, and contact fields required for the operation. `staff.read_directory` excludes private contact, identity, bank, credentials, and pay. Timetable attribution uses a minimal nested person label and does not confer either student or staff detail access. Search, sort, count, joins, pagination, and export must use fields and records allowed by the same permission and scope as the visible result.
