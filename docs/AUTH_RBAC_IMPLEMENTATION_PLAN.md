# Authentication and access control implementation plan

Date: 13 September 2026. Status: proposed architecture, ready for review and agent handover. No authentication or backend implementation is included in this document.

## 1. Recommended decision

Use TypeScript throughout, with Fastify on Node.js, Better Auth for login and sessions, PostgreSQL for durable data, and Drizzle for database access and migrations. Keep the existing React and TanStack frontend. Build one backend with clear modules, rather than separate services for each school feature.

Use roles to give people their normal permissions. Add relationship checks to decide which children, classes and records those permissions cover. Keep a defined extension for person-specific allows and denies. The backend makes every access decision. The frontend reflects those decisions.

No framework can make access control flawless by itself. Our release standard is a written permission matrix, enforcement on every data path, and automated attempts to bypass those rules. A login screen in front of the current mock API does not meet that standard.

Mobile layout is outside this work. Fees, attendance and exams remain future modules, but their permission names and restrictions should be reserved now. Parent login should lead to a small, properly restricted home screen for the data that actually exists. Student identity and permissions are designed now; student login remains disabled until a later release, as the user requested.

## 2. Technology options

These are architectural recommendations for this repository, not benchmark rankings. Documentation was checked on 13 September 2026. Pin compatible stable versions during the first implementation task; do not use `latest` dependencies for this work.

### Backend framework

| Option | Why choose it | What we must account for | Recommendation |
|---|---|---|---|
| Fastify on Node.js | Explicit request hooks, schema-based validation and response serialization, and encapsulated modules. Better Auth documents a direct integration. | We must establish folder conventions, protected-route registration and dependency boundaries ourselves. | First choice: a small integration surface and sufficient structure for this ERP. |
| NestJS on Node.js | Modules, dependency injection and guards give a larger team consistent conventions. Supports Express and Fastify adapters. | More framework ceremony. Better Auth's documented Nest integration is community maintained; its Fastify support is currently described as beta. Prove the integration before adopting it. | Good choice if the team values Nest's conventions. Do not pick the Fastify adapter merely for a benchmark score. |
| Elysia | Concise TypeScript APIs, typed client tooling and a documented Better Auth integration. It also supports Node through an adapter. | Choose Bun or Node deliberately and test the exact runtime, database driver, cookies and deployment combination. Typed routes do not enforce school access automatically. | Credible alternative if we prefer its development experience. Run the same integration checks as Fastify. |
| Hono | Small, based on Web Standards, and supports several runtimes. | More application structure, persistence and authorization conventions are ours to establish. | Attractive for an edge-oriented application; this ERP does not currently require that architecture. |

Fastify's validation and serialization facilities are documented in its [validation guide](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/); module boundaries are explained in [encapsulation](https://fastify.dev/docs/latest/Reference/Encapsulation/). Nest documents [guards](https://docs.nestjs.com/guards) and its [Fastify adapter](https://docs.nestjs.com/techniques/performance). Better Auth explains the current [Nest integration limitations](https://better-auth.com/docs/integrations/nestjs). Elysia documents [Better Auth integration](https://elysiajs.com/integrations/better-auth) and [Node support](https://elysiajs.com/integrations/node). See also [Hono's supported approach](https://hono.dev/docs/).

### Authentication provider

| Option | What it gives us | Tradeoff |
|---|---|---|
| Better Auth | TypeScript authentication that we operate alongside our backend, with sessions and login plugins. | We own deployment, patching, delivery providers, abuse controls and recovery configuration. Recommended for control over this school's identity model. |
| Clerk | A managed identity service, including organization features. | Less identity infrastructure to operate. Validate required phone/student flows, current commercial terms and data-location requirements before choosing. School record authorization still belongs in our backend. |
| Supabase Auth | Authentication integrated with the Supabase platform, which uses PostgreSQL and RLS. | Useful if we also adopt Supabase hosting and conventions. Avoid running Supabase Auth and Better Auth as competing identity systems. |

The comparison draws on [Better Auth's Fastify integration](https://better-auth.com/docs/integrations/fastify), [Clerk organizations](https://clerk.com/docs/guides/organizations/overview) and [Supabase Auth](https://supabase.com/docs/guides/auth). These sources establish capabilities, not a guarantee that every proposed school workflow works without application code.

Recommendation: use Better Auth for identity, credentials, verification and sessions. Keep school memberships, school invitations, role assignments and resource policy in our own domain tables. Do not also enable a second organization-role engine as the authority for the same permissions. If we later adopt Better Auth Organizations, migrate ownership explicitly rather than keeping two writable membership stores.

### Database and access layer

Use PostgreSQL as the central database. Students, guardians, teachers, classes, memberships and grants have relationships that benefit from foreign keys and transactions. Future fee records also need transactional updates. JSON fields can hold limited flexible metadata; permissions and relationships should remain structured columns and tables.

Use managed PostgreSQL in the selected Indian hosting region. RDS PostgreSQL is a sensible deployment candidate given the existing AWS direction; verify the region, backups and operating cost when provisioning. [RDS PostgreSQL documentation](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html) describes the managed database offering.

Drizzle is my first choice because database constraints, SQL predicates and RLS policies remain visible to reviewers. Prisma is also viable; if selected, keep the same database constraints, transaction boundaries and SQL policy tests. This is a team preference, not a claim that one ORM provides stronger authorization automatically. Better Auth documents a [Drizzle adapter](https://better-auth.com/docs/adapters/drizzle), and Drizzle documents [transactions](https://orm.drizzle.team/docs/transactions) and [RLS](https://orm.drizzle.team/docs/rls).

MongoDB could store this data, but it offers no clear advantage for this relationship-heavy model. SQLite can be useful for future offline desktop storage; it should not replace the central school database. Redis is optional for shared rate limiting and short-lived coordination, not the source of truth for permissions.

### Permission engine

Start with a small application-owned `AuthorizationService`, backed by PostgreSQL relationships and a fixed permission catalogue. It must support both checking one record and constructing an authorized database query. Do not accept arbitrary JavaScript or SQL as a school-defined permission.

OpenFGA is an alternative if resource sharing develops into a large relationship graph. Cerbos is an alternative if we need a separate policy service. Both add another deployment and consistency boundary. Keep a stable authorization interface so either can be adopted later. See [OpenFGA roles and permissions](https://openfga.dev/docs/modeling/roles-and-permissions) and [Cerbos resource policies](https://docs.cerbos.dev/cerbos/latest/policies/resource_policies.html).

## 3. What must change in this repository

| Current area | Finding | Required replacement |
|---|---|---|
| `apps/web/src/lib/session.tsx` | Browser storage selects a user; missing selections can fall back to the first user. | Server-verified session. Unknown identity fails closed. No production impersonation switcher. |
| `apps/web/src/api/client.ts` | In-memory data, global mutable actor/school context, unscoped detail lookups and no consistent permission enforcement. | HTTP client calling protected backend services. Request context must be immutable and local to one request. |
| `apps/web/src/api/seed.ts` and `store.ts` | Entire mock datasets are available to frontend code. | Development-only server fixtures. Production bundles must contain no school datasets or mock fallback. |
| `packages/shared/src/rbac.ts` | A user belongs to one school. Scope resolution ranks unrelated relationships and returns one scope. | Global identity plus school memberships. Union applicable allow conditions, then subtract matching denies. |
| `apps/web/src/components/staff/create-login.ts` | Non-teaching staff are assigned admin by default; missing role can fall back to the first role. | Explicit allowed role selection. Unknown or missing role causes an error. No automatic administrator privileges. |
| `apps/web/src/components/settings/user-sheets.tsx` | An invite only creates a mock user. Role IDs are submitted without server-side delegation rules. | Real invitation lifecycle and a server-filtered list of assignable roles. |
| `apps/web/src/lib/query.ts` | Cache keys omit user and school identity. | Authenticated context in query keys, cancellation and cache clearing at context changes. |
| Staff, student, timetable and dashboard responses | Full joined objects can contain salary, medical, guardian or school-wide information. | Separate safe response schemas for each audience and operation. |

Keep reusable visual components. Do not reuse full storage models as public API responses. A field being optional in TypeScript does not prevent it from being sent.

## 4. Login experience

One login page should offer 4 clearly named entry points: school administration, teacher, parent and student. Administration includes the owner, principal, clerk and accountant. The selection changes instructions and the destination; it never assigns a role or relaxes authentication requirements.

The school can be identified by its login link or code. Before authentication, return only the minimum approved branding and login configuration. Do not expose a directory of users, parents or school memberships.

### Proposed login methods

The user confirmed email/password for staff, MFA for privileged users, phone OTP for teachers without email, and student login design now with activation later. Other operational defaults below remain recommendations.

| Audience | Primary method | Recovery and restrictions |
|---|---|---|
| Owner, principal, admin and accountant | Verified email and password, with authenticator-app MFA required before entering privileged school areas. | Single-use recovery codes; verified recovery process if those are lost. A phone-OTP login must not bypass MFA. |
| Teacher | Verified email and password; phone OTP for invited teachers without usable email. | School-approved identity recovery. Require MFA if additional permissions make the account privileged. |
| Parent | OTP sent to a verified, school-linked phone number. | School verifies changes to the guardian relationship or phone. Knowing an admission number is not proof of guardianship. |
| Student, future release | School code, school-issued username and password. | Design only now; endpoints remain disabled. Future school-managed single-use activation/reset flow. No date-of-birth passwords, shared parent credentials or public student self-registration. |

Better Auth documents [email/password](https://better-auth.com/docs/authentication/email-password), [phone verification](https://www.better-auth.com/docs/plugins/phone-number) and [username login](https://better-auth.com/docs/plugins/username). Username login extends its email/password authenticator; it is not a ready-made school-scoped identity system. The integration task must prove email-less provisioning for phone-only adults. Document the corresponding future student approach without enabling it. If the adapter needs an email-shaped internal identifier, use a generated non-deliverable identifier, keep it unverified, block email login/reset for it, and never substitute a parent's email as the student's identity. Resolve school-scoped student usernames to a unique internal identity on the server when student login is later built.

Normalize phone login identifiers to E.164, such as `+919876543210`. Keep the existing 10-digit local input where appropriate. Shared family contact numbers belong in contact records; a verified login identifier must not silently attach to several unrelated identities. A parent with several children has one identity and explicit links to each child. Never automatically merge accounts or grant child access merely because contact fields match.

### Pages and states to implement

| Route or screen | Required states |
|---|---|
| `/login` | Audience choice, configured methods, submitting, invalid credentials, throttled, delivery failure and help |
| `/verify-otp` | Masked destination, expiry, resend countdown, attempt limit and change destination |
| `/accept-invite` | Valid invitation, identity verification, activation, expired, revoked, already accepted and wrong signed-in identity |
| `/forgot-password` and `/reset-password` | Generic response, expired/used token and successful reset |
| `/mfa/setup` and `/mfa/verify` | Enrollment, confirmation, challenge and recovery code |
| `/select-school` | Only active memberships returned by the server; no global school list |
| `/account/security` | Password/contact change, MFA controls, active sessions, revoke session and sign out everywhere |
| Access unavailable | No membership, suspended membership, disabled account, insufficient access and missing resource |
| Parent home | Only linked records and available features; no staff dashboard, global search or office setup checklist |
| Student entry, future release | Specify the future home and activation flow. If shown now, clearly say student access is not enabled; do not expose a working login or enrollment endpoint. |

No public school creation or role selection on signup. Bootstrap the first school owner through a controlled operator command, with no default password. Further owners are added or transferred through a separately authorized workflow.

For parent activation, the school first approves a guardian's portal relationship to a child. Then send a targeted activation invitation or let the already provisioned parent verify their registered number. OTP proves control of the phone, while the approved link supplies child access; both are required. An unknown number must not create school membership through the phone plugin's automatic signup feature. Teacher signup is similarly limited to valid invitations.

## 5. Identity, membership and sessions

Keep these concepts separate:

- identity: the person who signed in, independent of schools
- school membership: whether that person may enter a particular school
- role assignment: their normal job permissions in that school
- relationship: which staff profile, children, sections and subjects they are linked to
- session: a signed-in browser or device, including how recently stronger verification occurred

A person can belong to 2 schools without sharing permissions across them. Removing membership in School A must not delete their global identity or remove School B access.

Use database-backed sessions with Secure, HttpOnly cookies. Prefer one browser origin for the frontend and `/api` through a reverse proxy. Configure trusted origins, CSRF protections and cookie scope explicitly. Never place bearer credentials or role claims in localStorage. Better Auth documents [session identifiers and cookie caching](https://better-auth.com/docs/concepts/session-management).

Use a host-only cookie where possible, an explicit SameSite policy, and origin/token checks for state-changing requests. Allow only approved return URLs. The proxy integration must preserve separate `Set-Cookie` headers and trusted HTTPS/host information; do not copy documentation sample bridges without testing those details. Sensitive responses use `Cache-Control: no-store` and bypass shared CDN caches. Tests must include cross-origin form/fetch requests and forged forwarding headers.

For the first release, validate sessions and current membership against the primary database on every protected request. Disable cookie/session shortcuts that can keep revoked access valid. Permission cache entries, if later added, must be keyed by the current policy version and have a proven invalidation mechanism.

Proposed limits: privileged office sessions have an 8-hour absolute life and 30-minute idle limit; teacher/student sessions have a 12-hour absolute life and 60-minute idle limit. Parent sessions can last 7 days on a personal device. Provide a shared-device mode with shorter limits and no remembered device. These are application requirements: test the library configuration and add server-side absolute/idle checks where needed. Sliding renewal must not defeat the absolute limit.

Require fresh verification within 5 minutes for ownership transfer, role escalation, MFA/contact changes and sensitive account recovery. The requirement follows actual permissions, not the login-page tab. Better Auth's [two-factor documentation](https://better-auth.com/docs/plugins/2fa) explicitly says non-credential methods are not all challenged by default. Prove every enabled login and recovery path either completes the required second factor or cannot enter privileged routes. Merely checking `twoFactorEnabled` is insufficient; the session must have completed verification.

For the initial policy, a membership with privileged roles or equivalent grants requires completed MFA for all of that school's data endpoints. Selecting the teacher or parent login tab must not bypass this membership requirement. Identity verification and MFA enrollment endpoints remain available with their own restricted rules.

Password reset revokes old sessions. Logout invalidates the server session. School suspension/removal denies that school's next request after the change commits. Global account disable invalidates access to every school. The UI clears itself on revocation notification or the next failed request; include a short permission refresh interval, proposed 30 seconds. Already downloaded information cannot be recalled, so avoid promising that revocation erases a screenshot or completed download.

Keep school selection explicit in each request, for example `/api/schools/:schoolId/...`, and validate membership. Do not rely only on a mutable active-school value in a shared cookie: two tabs can be open to different schools.

## 6. How access decisions work

### Permission names and role templates

Use stable, specific action names rather than checking role names throughout the application. Examples include `students.read_basic`, `students.update_basic`, `students.read_medical`, `staff.read_directory`, `staff.read_pay`, `staff.update_pay`, `members.invite`, `members.suspend`, `roles.assign`, `roles.manage`, `access.manage` and `audit.read`.

Preserve useful existing module names, but split actions that have different risks. Reading salary is different from editing a staff phone number. Viewing a list is different from exporting it. Managing another person's login is different from editing their employment record.

Ship fixed templates first. Use separate owner and principal templates, although the mock combines them. The owner controls ownership and delegation; the principal manages school operations. Custom role editing can follow the first release. A school administrator must not modify system templates into more privileged roles.

| Template | Starting access |
|---|---|
| Owner | School operations and access administration; ownership safeguards still apply |
| Principal | School-wide operational views and approvals; no ownership transfer or salary access by default |
| Admin / clerk | Setup and student administration, future fee collection, and approved teacher invitation/assignment tasks; no salary, owner assignment or arbitrary grants |
| Accountant | Financial records and financial audit events; necessary student billing/contact fields; no medical information or user administration |
| Teacher | Basic records for currently assigned sections, own staff profile, own timetable, future marks for assigned section and subject; no school-wide fees or salary |
| Parent | Approved links to own children and published child-facing data; no class roster, staff directory or other guardians' private fields |
| Student, disabled now | Future own published learning information and timetable; no financial or administrative permissions |

Define every active module's read/write/export/approve permissions in a checked-in matrix before agents implement routes. This table is the starting policy, not permission to interpret “school operations” as an unrestricted wildcard.

### Record and field boundaries

Every protected operation checks all of these:

1. The identity and session are valid, and the required authentication strength has been met.
2. The user has an active membership in the requested school.
3. Every referenced record belongs to that school.
4. A role or explicit grant allows the action for this record or scope.
5. No applicable explicit deny removes that action.
6. The fields and business state permit the operation.

Relationships are predicates, not ordered levels. For a teacher who is also a parent, “students in assigned sections” and “own children” are separate sets. Evaluate the conditions applicable to each permission and take their union. Never turn that union into school-wide access. The teacher-parent may read their own child's fee statement through a parent permission; that does not allow viewing class fee reports.

Teacher scope uses actual teaching/class-teacher assignments with academic year and effective dates. Subject-specific work must check subject as well as section. Historical access needs an explicit policy; past employment is not a permanent grant. Changing a section assignment must update access without a new login.

A student's profile, medical notes, guardian income, identity documents, staff compensation and credentials have different visibility. Use explicit response objects and update allowlists. A teacher's basic student response should not contain hidden medical or financial fields. Restrict filters and sorts on hidden fields too, since those can reveal information indirectly.

For parent relationships, an approved account-to-guardian link and guardian-to-child access link are required. `receivesNotifications` is not an access grant. Support revoking one guardian's portal access without deleting their contact/history record. Approved parent links may differ in what they can view; do not infer portal access from a phone match, surname or admission number.

### Person-specific and resource-specific exceptions

Design the schema, evaluator and tests now. Full resource-exception editing UI can come later. Changing one teacher from one existing role to another is included in this release and should not require an exception.

Each exception records the school, membership, permission, allow/deny effect, target, effective dates, reason and author. A target is typed: school-wide for that permission, one section, or one supported record. A section target must state which resource/permission it applies to; it does not grant everything related to the class.

Example: allow Meera `students.read_basic` for Section 6B during a temporary assignment. Separately deny `students.export` for her school membership. A future document exception can allow access to one specific document without opening every document for that child.

The decision is:

```text
allowed = valid session and membership
          and correct school and authentication strength
          and (matching role allow or matching personal allow)
          and no matching personal deny
          and permitted fields and business state
```

Default is deny. Matching deny overrides allow, including a broad deny overriding a narrower allow. An allow never crosses a school boundary, reactivates a suspended membership or bypasses MFA. Missing/unknown actions and expired grants deny access. Creating a child grant does not silently grant access to parent records or adjacent resources.

Keep owner recovery capabilities protected from accidental exceptions. Ownership removal uses the dedicated transfer/demotion workflow. Initial student memberships must not be combined with staff/administrator roles; explicitly design that transition if needed later.

### Safe permission delegation

Being able to do something does not automatically mean being able to grant it. Maintain a grantable-role/permission allowlist for each access administrator. A clerk may invite or reassign teachers only among approved non-privileged templates. Owner, principal, accountant and access-management grants require the corresponding stronger delegation authority.

Check the full resulting permission set after role changes, including custom roles and exceptions. An administrator cannot give themselves or an accomplice powers they cannot delegate. Prevent indirect escalation through editing a role already assigned to themselves, changing staff/guardian links, resetting another person's credentials, or calling the raw auth-provider administration endpoint.

Protect the last active owner with a transaction and lock. Concurrent removals or demotions must not leave a school with no owner. Ownership transfer requires fresh MFA, a verified target and an audit event. School admins never receive a global identity-provider admin role.

These principles align with [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): deny by default, check each request, protect individual resources and test the rules. The detailed policy above is our proposed school design.

## 7. Database structure and isolation

### Main tables

| Table or group | Purpose and main constraints |
|---|---|
| Auth-provider tables | Global users, credential accounts, sessions and verification records. Follow the pinned provider schema; never expose these as school directory data. |
| `schools` | Tenant root and school login code |
| `school_memberships` | Unique `(school_id, user_id)`; active/suspended/removed status, version and membership kind |
| `roles`, `role_permissions` | School-owned role templates and structured permission/scope conditions |
| `membership_roles` | Membership-to-role assignments; both must belong to the same school |
| `membership_staff_links` | Explicit membership-to-staff-profile relationship; school-constrained |
| `membership_guardian_links` | Verified membership-to-guardian-profile relationship |
| `guardian_student_access` | Approved guardian-to-child portal relationship, status and permitted child-facing areas |
| `membership_student_links` | Future student identity relationship; no active student login in this release |
| `teaching_assignments`, `enrollments` | Section/subject/year relationships with effective dates used by policy |
| `school_invitations` | Target verified identifier, proposed roles/link, inviter, lifecycle, expiry and token digest |
| `resource_access_rules` | Person-specific allow/deny rules with typed target, reason and expiry |
| `audit_events` | Actor, school, action, target, result, permitted before/after changes, timestamp and request ID |
| `delivery_outbox` | Committed notifications awaiting delivery; retries and delivery status |
| School domain tables | Persist all currently exposed students, guardians, staff, setup, timetable, substitution and document metadata |

Every tenant table needs a non-null `school_id`, relevant indexes beginning with school/context columns, and database constraints. Use composite foreign keys such as `(school_id, section_id)` referencing `(school_id, id)` so records from different schools cannot be linked accidentally. Add uniqueness for school membership, employee/admission codes, active identity links and pending invitations as appropriate.

Do not leave a free-text resource ID without integrity rules. For the first supported rule targets, use explicit nullable foreign keys with an exactly-one-target constraint, or an equivalent validated resource registry. The database owner must document how deleted resources invalidate grants and how tenant consistency is enforced.

Invitation, membership and role state are distinct. A pending invitation grants no data access. Use constrained state transitions, optimistic versions for ordinary edits, and locks for acceptance and last-owner changes. Do not let a client patch `status`, `school_id`, `role_ids` or relationship IDs through a generic profile endpoint.

### Database row-level security

Add PostgreSQL RLS as a second barrier against cross-school access. The application policy service remains responsible for teacher/parent scope and field visibility. Tenant RLS alone does not stop a teacher from seeing the wrong pupil in the same school.

Use a runtime database role that is neither a superuser, a table owner nor a `BYPASSRLS` role. Enable and force RLS on tenant tables. A missing school context must return no rows and reject writes. Policies need both read filtering (`USING`) and write validation (`WITH CHECK`). PostgreSQL documents [owner and superuser bypass behaviour](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

After session and membership validation, open a transaction and set the school context locally on that transaction's connection. Keep every tenant query on that same transaction client. Never set tenant context for the life of a pooled connection. Concurrent School A/B requests and rollback/reuse cases need explicit tests.

Separate migration credentials from runtime credentials. A restricted identity/membership lookup module can resolve the authenticated user's memberships before entering tenant context; do not solve this bootstrap step by giving all repositories a privileged connection. Keep auth-provider tables in a separate schema/credential boundary where practical. Grants must limit that connection to the tables it needs.

RLS context is set by trusted server code. It is a barrier against missing tenant filters, not protection against a fully compromised application database credential. Use parameterized queries and tightly limited database grants as well. App routes may import scoped repositories, never an unrestricted database client.

### Durable changes and audit

Persist an access change and its audit event in the same transaction. If recording a role change fails, the role change must not commit. Runtime credentials cannot update/delete audit events. Restrict audit reads and exports; redact secrets and sensitive field values by audience. Audit events must not become another way to read salary or medical data.

Send invitation and security notifications through an outbox after commit. Track queued/sent/failed separately; “queued” does not mean “delivered”. Retry safely and use idempotency keys. Credentials and raw OTPs never enter logs or audit records. If a delivery job needs an invitation token, keep the payload encrypted and short-lived and purge it after delivery; the invitation table stores only the digest.

## 8. Teacher invitation and access management

The user directory should show membership status, roles, staff linkage, class assignments, invitation status and permitted management actions. Separate employment status from account access. “Resigned” and “access removed” are related business decisions, not interchangeable fields.

### Invite a teacher

1. An authorized administrator chooses an existing staff record or creates one, supplies the teacher's email/phone and selects an assignable role.
2. The server validates delegation, school, role, staff link and duplicate invitation rules. It creates a pending invitation and notification job transactionally.
3. Send a random, single-use activation link. Proposed expiry is 48 hours. Possession of the link alone is insufficient: acceptance verifies the invited email or phone through the auth provider.
4. The invited person signs into an existing identity or completes controlled account activation. Do not create duplicate global identities for a second school.
5. The server locks and consumes the invitation, verifies its status and target identity, and rechecks the inviter's current authority and the current roles being granted.
6. Create or activate the membership and staff link atomically. MFA enrollment must complete before privileged school access. Record who invited and who accepted.

Revoked, expired and replayed links fail. Resending invalidates the previous token. Invitations must not silently regain validity after suspension or removal. Rejoining needs an explicit new invitation/reactivation decision. Concurrent acceptance should produce one membership and one activation event.

### Change a teacher's permissions

The edit screen should show current roles, proposed roles and a readable summary of added/removed access. Do not overwrite teaching assignments unless the administrator explicitly changes them. Add a separate assignment editor for section, subject, academic year and effective dates.

The server validates the target and the administrator's delegation authority, commits the change and audit event, increments the relevant access version, and notifies active clients. The next API request uses the new rules, even with an old browser session. Changes to a shared role affect all its members and need a clear affected-user count before saving.

Include an administrator-only “Why does this person have access?” view. Explain the role, relationship or exception that grants/denies it. This replaces unsafe production “viewing as” impersonation. The evaluator must be shared with actual enforcement.

### Suspend, remove and restore

Suspension blocks school access temporarily. Removal ends that school membership and invalidates its active grants/invitations as specified by policy, while preserving staff and audit history. Both require an explicit action and reason; neither deletes the global identity or other school memberships.

A departed staff member must not remain able to log into the school. The resignation flow should include an access-removal step when a linked membership exists. Restoring a membership requires explicit role/link review; do not automatically restore expired or revoked exceptions. School administrators may initiate recovery only for authorized target accounts and never read passwords, TOTP secrets or reset tokens.

## 9. Enforce the rules on every data path

Register business routes through a protected route helper. Each route declares its action, input schema and safe response schema. Missing permission metadata should fail registration or deny access, rather than produce a public endpoint. Public routes must appear in a small reviewed allowlist. Auth-provider endpoints require their own authentication/abuse policy; mounting a wildcard auth handler is not permission to expose every plugin administration endpoint.

Use these backend layers:

```text
React UI
  -> authenticated HTTP request
  -> session and membership validation
  -> action, record and field authorization
  -> scoped repository inside a tenant transaction
  -> PostgreSQL tenant RLS
  -> safe response object and allowed UI actions
```

The authorization service should expose a small contract, for example:

```ts
// Illustrative contracts, not implementation or final library APIs.
authorize(context, action, resource, requestedFields)
scopeQuery(context, action, resourceType)
allowedActions(context, resource)
explainAccess(adminContext, targetMembership, action, resource)
```

`scopeQuery` builds supported SQL conditions using the same policy model as `authorize`. Never fetch the whole school and filter in JavaScript. Lists, totals, search suggestions, aggregates, exports and pagination all use the authorized dataset. Test that a list contains a record if and only if the matching detail-read check allows it, subject to ordinary filters.

Record writes validate both the existing record and the proposed new relationships/state. A person allowed to edit a student cannot move them into an unrelated school/section or change their own guardian link through that endpoint. Bulk operations authorize every selected record; this release should reject the whole operation if any item is unauthorized. Audit one batch operation with safe item references.

Use authentication failure for absent/expired sessions, access denied for forbidden module actions, and a consistent not-found response for an inaccessible individual record. Do not expose whether an unrelated school record exists through error messages or lookup timing where avoidable.

Recheck sensitive writes inside the committing transaction. Role changes, grant changes and membership revocation must use a shared locking/version protocol with protected writes so they cannot commit based on a stale decision. Define ordering explicitly: requests authorized before a revocation may already have returned data; new requests after its commit must fail. Read authorization from the primary database, not a lagging replica.

Background jobs must carry the actor, school, action and target scope, not a blanket administrator credential. Recheck authorization when executing an export/message and when downloading the result. System jobs get a distinct, limited service identity. Future AI tools must call the same services; do not create an assistant-only bypass.

Store documents in private storage. The first release should download through an authenticated endpoint that checks current access on each request. Do not keep public document URLs in responses. If later using signed URLs, document their short validity window and the fact that a previously issued URL may outlive a permission change. Uploaded files, thumbnails, avatars, generated PDFs and audit attachments need the same review.

These tenant boundaries are consistent with [OWASP multi-tenant guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html). Application-specific field and workflow decisions must be enforced in our code, not inferred from the framework.

## 10. Make the UI reflect server permissions

Return an authenticated context containing the safe user profile, available school memberships, selected membership, access version and coarse navigation capabilities. Each record response may also contain `allowedActions`. The frontend uses these for navigation and controls; the backend always checks again on use.

Suggested application endpoints include:

| Endpoint | Purpose |
|---|---|
| `GET /api/me` | Safe identity, session state and the user's available memberships |
| `GET /api/schools/:schoolId/context` | Verified membership, coarse capabilities, access version and UI configuration |
| `GET /api/schools/:schoolId/members` | Authorized user directory |
| `POST /api/schools/:schoolId/invitations` | Create a restricted invitation |
| `POST /api/schools/:schoolId/invitations/:id/resend` | Replace invitation token and queue delivery |
| `POST /api/schools/:schoolId/invitations/:id/revoke` | Revoke invitation |
| `POST /api/invitations/accept` | Verify target identity and consume invitation; no arbitrary role input |
| `PUT /api/schools/:schoolId/members/:id/roles` | Replace role assignments with delegation checks and expected version |
| `POST /api/schools/:schoolId/members/:id/suspend` | Suspend school access |
| `POST /api/schools/:schoolId/members/:id/remove` | End school access |
| `POST /api/schools/:schoolId/members/:id/restore` | Explicitly restore reviewed school access |
| `GET /api/schools/:schoolId/members/:id/access-explanation` | Restricted explanation of effective access |

Exact routes and error codes should be frozen in the contract task. Credential login/verification routes follow the selected auth library, with an explicitly reviewed endpoint allowlist. Resource exception mutation endpoints can remain unexposed until their UI/workflow is commissioned; the evaluator and schema should already support their test fixtures.

Replace `useSession()` with server-derived state. Do not render protected children until authentication and school context are resolved. A failed request must not fall back to the owner, demo data or broad cached permissions. Route guards cover direct URLs as well as sidebar navigation.

Apply capabilities to sidebar links, command search, dashboard cards, filters, table columns, forms, detail tabs, row actions, bulk actions, exports and file downloads. Hide unavailable modules. Show a disabled control with a reason only where explaining it helps an already authorized user; do not advertise private records or fields.

Use context-specific query keys such as `[userId, schoolId, membershipId, accessVersion, resource, params]`. On logout, identity change or school switch: stop rendering old content, cancel outstanding requests, clear the old cache, reset selections/filters/detail routes that are no longer valid, then load the new context. Use a context generation check so late responses cannot repopulate a cleared cache. Broadcast logout across tabs. Do not persist protected query data in localStorage or offline caches in this release.

Keep parent navigation separate from the office shell. Show only linked children; do not infer fees or future modules from preview figures. A parent home may display a child's basic details and relevant timetable today. Minimal teacher names needed for a child's timetable do not require exposing staff profiles or a searchable staff directory.

Staff can change roles through the authorized user-management UI. The current global user switcher must be removed from production, including hidden keyboard/debug paths. Development fixtures may offer separate test accounts in a development-only build.

## 11. Login abuse, recovery and operational checks

Use the provider's maintained password hashing and token verification. Do not build password hashing, OTP cryptography or session signing from scratch. Configure identifier/IP/device rate limits with a shared backing store across API instances. Add school/global send limits to prevent messaging abuse. Avoid permanent lockouts that let an attacker deny access to a known account.

Proposed phone OTP settings: 5-minute expiry, 3 verification attempts, at least 60 seconds before resend, and progressive throttling. Ensure the selected provider/library supports atomic single-use verification; concurrent correct submissions must not create repeated activations. Resend should invalidate or clearly supersede older challenges. Use generic login/reset responses to limit account discovery. Allow password-manager use and paste. These checks follow [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

Select an email provider and an India-capable SMS provider during the integration task. Keep delivery adapters replaceable. Test actual delivery in a controlled staging environment after credentials are configured. Until then, label sandbox delivery explicitly. Never show “invite sent” when the adapter only logged a token. WhatsApp authentication can follow once its sender/templates are configured; do not make it a hidden dependency of initial login.

Account recovery is an access-control path. Changing a phone/email requires proof of the existing identity or a documented verified recovery process. Reverify the new identifier and notify the old one where possible. School recovery cannot reset a global multi-school user's credentials without identity-provider recovery; restrict a school's intervention to its membership and supported recovery initiation. Staff administrators cannot use “reset password” to take over another user's other-school account.

Before introducing real school data: set up HTTPS, private database access, secret management, database backup and restore checks, audit retention, alerting for repeated denied access and an independent review of the auth implementation. Keep access logs free of passwords, OTPs, invitation/reset URLs, cookies and sensitive record bodies. Use controlled local test doubles for delivery and real PostgreSQL for isolation tests.

## 12. Implementation tasks for agents

Every agent receives this document and the repository guide. The implementers are not alone in the codebase: do not revert another agent's work. Own only the assigned paths. Request shared contract/schema changes from the owner. The integration owner handles the workspace manifest, lockfile, route composition and coordinated migrations.

Do not launch all tasks without dependencies. Agree the contracts first, then work in parallel where the interfaces are stable.

### Task 0: Architecture and contracts

Owner: integration agent. Own `docs/`, new `packages/contracts/`, workspace setup and dependency lockfile. Coordinate the compatibility export in `packages/shared/`; other agents must not independently rewrite the shared models.

Deliver the exact permission matrix, DTOs, request context, authorization interfaces, membership/invitation state machines, error codes, module boundaries and compatible pinned versions. Confirm Fastify as the proposed default or record a deliberate alternative. Define active login methods using the user's confirmed choices. Design student contracts but keep all student activation paths disabled.

Exit check: every current route/data operation maps to a permission, scope, safe response and owner task. No broad legacy `UserInput`/`StaffInput` doubles as an account-management request schema. Other agents can implement against the published contracts without inventing permission names.

### Task 1: Database and tenant isolation

Owner: database agent. Own `packages/db/`, all SQL/Drizzle schema and migrations, development fixtures, and local database configuration. Other agents request schema changes through this owner.

Build identity adapter schema, school memberships, roles, links, invitations, exception tables, audit/outbox and all domain tables needed by current screens. Add composite foreign keys, indexes, state constraints, database roles, RLS and a transaction-scoped repository context. Create fixtures for 2 schools, unrelated families, overlapping teacher-parent roles, expired grants and suspended memberships.

Exit check: real PostgreSQL tests prove missing context fails closed; wrong-school reads/writes and foreign keys fail; connection reuse cannot carry School A context into School B. Migration credentials are absent from runtime configuration. Schema can migrate from an empty database reproducibly.

### Task 2: Authentication and session service

Owner: authentication agent. Own `apps/api/src/auth/`, `apps/api/src/identity/`, authentication delivery adapters and their tests. Depends on Task 0 and the database schema contract from Task 1.

Integrate Better Auth with Fastify. Prove secure cookies through the intended proxy, email/password, verified phone OTP for eligible teachers/parents, password reset, MFA enrollment/challenge/recovery and session revocation. Restrict self-registration and unsafe provider endpoints. Build `/me`, safe identity resolution and session assurance. Student login remains denied server-side, even if called directly.

Exit check: an OTP-only or incompletely verified session cannot enter privileged routes. Verify every enabled alternative login/recovery path. Revoked sessions fail on the next request; library caches do not restore them. Tests distinguish real provider delivery from sandbox operation.

### Task 3: Permission policy service

Owner: authorization agent. Own `packages/authz/` and policy tests. Depends on Task 0 and Task 1's repository contracts.

Implement allow/deny evaluation, relationship scope, field restrictions, query predicates, action explanations and permission delegation rules. Support person/resource exceptions through typed fixtures and internal APIs now. Implement no public arbitrary policy language. Define and implement the locking/version protocol jointly with the database owner.

Exit check: matrix tests cover every role/action; teacher-parent union remains bounded; explicit denies and expiry work; scopes for detail and list agree. Unknown actions fail closed. Granting access cannot bypass school membership, MFA or ownership safeguards.

### Task 4: Membership and invitation workflows

Owner: access-management backend agent. Own `apps/api/src/memberships/`, `apps/api/src/invitations/` and these services' tests. Depends on Tasks 1, 2 and 3.

Build invitation creation/delivery/acceptance/resend/revoke, teacher role changes, assignment coordination, suspension/removal/restore, last-owner protection and transactionally recorded audit events. Provide the restricted effective-access explanation endpoint. Do not expose a generic user-patch endpoint or the provider's global admin methods to schools.

Exit check: invitation acceptance is single-use and identity-bound; role escalation via direct API calls fails; simultaneous owner removal cannot orphan the school; School A removal leaves School B accessible; all committed changes have audit events.

### Task 5: Protected school APIs

Owner: domain backend agent. Own `apps/api/src/modules/` for setup, students, staff, timetable, dashboard, search, audit-read and files, plus endpoint tests. Depends on Tasks 1 and 3 and Task 2's authenticated context.

Move every currently exposed mock operation to scoped repositories and safe DTOs. Include nested joins, teacher suggestions, guardian/sibling lookup, promotion/import, counts and exports. Build a restricted parent data endpoint. Keep future modules absent rather than returning fabricated financial/attendance previews as real data.

Exit check: every registered business route is protected; users cannot retrieve hidden records/fields using direct HTTP, filter tricks, bulk IDs or document URLs. Each endpoint passes a cross-school and same-school wrong-person test. No unrestricted storage objects are returned.

### Task 6: Login and application session UI

Owner: authentication frontend agent. Own new public auth routes, `components/auth/`, `lib/auth-client.ts`, `lib/session.tsx`, `lib/query.ts`, the HTTP-client replacement, and protected-route integration. Coordinate generated-route changes through the integrator.

Build the administration/teacher/parent login flows, activation, reset, MFA, account security, school selection and failure states. Specify but disable the student entry. Replace all local identity selection and mock fallback with server state. Implement cache isolation, logout across tabs and safe context switching.

Exit check: protected content never flashes before context loads; localStorage edits cannot change identity; stale requests cannot restore another school's data; direct unauthorized routes fail; keyboard and field labels work. Existing mobile layout redesign remains out of scope.

### Task 7: Access management and permission-driven screens

Owner: application frontend agent. Own settings/staff access-management components, sidebar/command-menu capabilities, dashboard audience variants, protected feature screens and a minimal parent home. Depends on Task 0 contracts and Tasks 4–6 APIs/integration.

Replace fake invites with lifecycle-aware screens. Add role-change preview, suspend/remove/restore and access explanations. Remove `createStaffLogin` defaults and production “viewing as”. Use safe DTOs and `allowedActions` for fields, rows, tabs, export, search and bulk controls. Give an administrator enough context to understand why an action is unavailable.

Exit check: teacher, parent, accountant and owner sessions each expose only their permitted navigation/data/actions. The settings screen cannot assign a role the server says is not grantable. Removing access clears the visible data on notification/refresh.

### Task 8: Server-assigned admission numbers and employee codes

Owner: domain backend agent for `apps/api/src/modules/students`, `apps/api/src/modules/staff`, one new migration in `packages/db` and the contract change in `packages/contracts`; the application frontend agent adjusts the admit, import and add-staff screens. Depends on Tasks 1, 5 and 7. Added on 16 September 2026 after the Task 7 review found that both identifiers are free text typed by the office, so nothing guarantees a school-wide numbering scheme. Every remaining task moves after this one.

Format. An admission number is `<school short name>/<academic year name>/<counter>`, for example `SVM/2026-27/014`: the counter restarts at 1 for each academic year and counts admissions into that year in the order they were committed. An employee code is `<school short name>-E<counter>`, for example `SVM-E007`: one school-wide counter that never restarts. Both use the school's `short_name` in upper case and a counter padded to three digits (wider once it passes 999, never truncated). The office does not type either value and cannot edit it later; a school that needs its historical numbers keeps them through import only (below).

Sequence storage. Add a `number_sequences` table keyed by `(school_id, kind, period)` with a `next_value` column, where `kind` is `admission` or `employee` and `period` is the academic year id for admissions and empty for employee codes. The row is created on first use. Every allocation happens inside the same `withTenantTransaction` as the insert it numbers, after the school lock that the write already takes, with `UPDATE ... RETURNING` so two concurrent admissions cannot receive the same number. Keep the existing `UNIQUE (school_id, admission_number)` and `UNIQUE (school_id, employee_code)` constraints as the last line of defence; a unique violation is a bug, not a user error, and is reported as such.

Contract changes in `@erp/contracts`. Remove `admissionNumber` from the student create request and `employeeCode` from the staff create request; both stay in every response and in search. The admission year is the academic year of the section the student is admitted into, so the number and the enrolment always agree. The bulk import row keeps an optional `admissionNumber` for a school migrating its old register: a supplied value is kept verbatim (still unique per school, still validated in preview) and a blank one is generated at commit time in row order, so a preview can show "will be assigned" rather than a number that might change. Promotion never renumbers. Update `PROTECTED_APIS.md`, `CONTRACTS.md` and `WEB_SCREENS.md`.

Screens. The admit form drops its Admission number field and its client-side suggestion (`suggestAdmissionNumber`); the review step says the number is assigned on save and the success toast shows the assigned one. The add-staff sheet drops Employee code the same way. The import preview shows the kept or pending number per row. Both remain read-only facts on the record and stay searchable.

Fixtures and tests. `packages/db/scripts/fixtures.mjs` and `dev:logins` seed numbers in the new format and a sequence row that continues after them. API tests stop inventing `ADM-<hex>` and `INV-<hex>` values and assert the generated ones, including two admissions committed concurrently into the same year, an admission into a different year restarting at 001, an import that mixes kept and generated numbers, and a rejected client attempt to send a number. The API test suite must run against its own `TEST_DATABASE_URL` database, never the development one: the Task 7 review found test years, grades, students and staff with random suffixes in the development school because every documented example points both at the same database. Fix the docs and the `.env` example so a developer cannot repeat that, and reset the development database as part of this task.

Exit check: admitting two students into the same year from two sessions at once yields consecutive numbers with no gap and no duplicate; the first admission into a new year is `001`; a new staff member gets the next employee code regardless of who created them; neither value can be set or changed through any endpoint; the roster, staff directory and search show and match the new formats; the development database shows fixture data only.

### Task 9: Adversarial testing and release integration

Owner: security/test agent for `tests/security/` and browser security tests; integration agent owns CI, deployment configuration and final integration. Start test design after Task 0; execute against completed Tasks 1–8.

Implement the acceptance matrix below using direct API clients, a real PostgreSQL instance and browser tests. Inspect production assets for mock school data. Check failure paths and pooled/concurrent requests, not only happy-path login. Verify dependency advisories and the exact deployed runtime/proxy configuration before release.

Exit check: all release checks pass, the runtime has least-privilege database credentials, an independent reviewer has assessed access boundaries, and the deployment cannot fall back to the unsecured demo.

### Suggested execution order

| Wave | Work |
|---|---|
| 1 | Task 0; agree contracts and the framework/auth integration decision |
| 2 | Task 1 publishes schema; Tasks 2 and 3 start against those contracts; Task 9 authors denial cases |
| 3 | Tasks 4 and 5 build backend workflows; Task 6 builds auth/session UI against contracts |
| 4 | Task 7 connects all permission-driven screens |
| 5 | Task 8 makes admission numbers and employee codes server-assigned and resets the development database; Task 9 runs full adversarial/browser tests |
| 6 | Integration owner completes deployment checks, review and production cutover |

These are work packages, not a promise that all require separate permanent agents. With fewer agents, combine consecutive tasks while preserving ownership and review. Database migrations and shared contracts have one owner at a time.

## 13. Acceptance tests required before release

Tests must call the API directly as well as use the UI. Hidden buttons are not evidence that data is protected. Include successful permitted requests so a system that denies everything cannot pass.

| Scenario | Required result |
|---|---|
| Anonymous request to every business endpoint | No school data; authentication required |
| Change role/user/school values in localStorage or request bodies | No change to authenticated identity or granted permissions |
| School A user requests School B record/list/export/file | Denied without returning School B data or revealing record existence |
| Teacher opens unrelated student in the same school | Denied; assigned student remains accessible with allowed fields only |
| Teacher reads staff/timetable/search joins | No salary, bank details or unrelated private staff fields |
| Teacher with two section assignments | Union of those sections only; filters and totals match |
| Teacher who is also a parent | Assigned student basic data plus their own child's permitted parent data; no class-wide financial access |
| Parent changes child ID or guesses admission number | Other child's profile, documents and fees remain inaccessible |
| Guardian's contact receives notifications but portal link is absent/revoked | No child portal access |
| Future student login endpoint called now | Server rejects it; disabled frontend control is not the only protection |
| Future student policy fixtures | No financial/administrative permissions; only own published information |
| Client adds salary, role IDs, school ID or relationship changes to a normal edit | Forbidden fields rejected and database unchanged |
| Query sorts/filters/counts on a hidden field | No unauthorized inference or hidden-field exposure |
| Bulk request mixes permitted and forbidden IDs | Whole operation rejected without partial writes |
| Clerk assigns owner/accountant, edits a privileged role or resets a privileged identity | Rejected by delegation/target checks |
| Missing teacher role in setup | Invitation fails; never falls back to admin or first role |
| Suspended member reuses a valid session | That school's next request after commit is denied |
| Removed member still belongs to another school | Other membership continues to work |
| User uses passwordless login to avoid privileged MFA | Privileged access denied until the required verification completes |
| Recovery resets password or replaces MFA/contact | Policy enforced; old sessions/tokens revoked as specified |
| Expired/revoked/replayed/wrong-recipient invitation | Cannot activate membership |
| Inviter loses grant authority before invitation acceptance | Acceptance cannot grant the now-unauthorized role |
| Two requests accept one invitation or use one OTP | Single consumption and no duplicate activation |
| Two administrators remove/demote the last owners concurrently | Database still has an active owner |
| Explicit allow plus matching deny | Deny wins in detail, list, export and allowed-action responses |
| Exception expires or teaching assignment ends | Access ends without logging in again |
| Role revoked during a sensitive write/export | Lock/version protocol prevents stale authorization from committing; download rechecks current access |
| Permission/database service unavailable | Access denied/error; no broad cached/mock fallback |
| Missing tenant context and reused pooled connections | No tenant data; no context survives transaction completion |
| Audit event contains sensitive changes | Unauthorized readers cannot recover hidden field values from audit/search/export |
| Logout or school switch while requests are in flight | Old data never repopulates the next identity/school view |
| Production browser bundle and network responses | No seeded full-school store, development credentials, private fields or provider secrets |
| Delivery provider fails or times out | Clear retryable state; no false success or duplicate account/membership |
| Private document copied URL after permission removal | Authenticated download is denied; no public-storage fallback |

Add matrix-driven unit tests for policy, real-database integration tests for RLS/transactions, and browser tests for session transitions. Test every action separately: view permission must not imply export, edit, approve or delegate.

## 14. Production cutover and scope boundary

The first deliverable is a working vertical slice: invite teacher, verify identity, sign in, see only assigned students, change role/assignment, suspend membership, and prove an existing session loses school access. Complete that before broadening to every screen.

For production cutover, every currently exposed school-data route must use protected backend APIs or be explicitly unavailable. Do not release a hybrid in which some screens still read the entire mock store. Persist current modules in PostgreSQL; move fixtures to a server-only development seed command. Add a build check that excludes `api/seed.ts`, `api/store.ts`, test credentials and mock transport from production imports.

The frontend is currently deployed as a static Vite SPA. Add a real backend deployment and route `/api` to it before the SPA catch-all rewrite. Verify cookies, forwarded headers, redirects and error handling through the actual hosting setup. Use a containerized Node backend and managed PostgreSQL as the baseline proposal; hosting selection is a provisioning decision, not part of a frontend-only change.

This release includes staff/parent authentication, teacher invitations and access lifecycle, predefined role changes, relationship-based restrictions, private responses/downloads, database isolation and tests. It includes the underlying person/resource exception schema and evaluator. It does not include mobile layout redesign, native apps, offline authenticated data, student activation, a general policy editor, arbitrary custom-role building, new fees/exams modules or an AI assistant. These later features must reuse the same authorization service.

## 15. Decisions and first instructions to implementers

| Decision | Status |
|---|---|
| TypeScript | User requirement |
| Staff email/password, privileged MFA, teacher phone OTP fallback | Confirmed by user |
| Student authentication design now, enable later | Confirmed by user |
| Mobile layout deferred | Confirmed by user |
| Fastify + Node + Better Auth + PostgreSQL + Drizzle | Recommended, not yet selected by user |
| Application-owned membership/policy authority | Recommended; avoid duplicate provider/domain RBAC |
| Email and SMS providers, hosting region/account | Select/configure during integration and provisioning |
| Session limits and invitation expiry | Proposed defaults in this document |
| Principal split from owner; fixed initial delegation matrix | Proposed least-privilege product policy; finalize in Task 0 |
| Parent relationship verification/recovery operator process | Specify with the school during onboarding design; never infer from contact matching |

Start implementation by reading this plan, the repository guide and the current shared models. Freeze the contracts and run the auth integration checks. Build the vertical slice and denial tests. Then expand to all current modules. Report which checks passed and any remaining gaps; do not label RBAC complete while a mock data path or untested bypass remains.

## 16. Evidence and limits

Repository reviewed at commit `179c3ed` on 13 September 2026. The main current-state references are `packages/shared/src/rbac.ts`, `packages/shared/src/student.ts`, `packages/shared/src/staff.ts`, `apps/web/src/lib/session.tsx`, `apps/web/src/lib/query.ts`, `apps/web/src/api/client.ts`, `apps/web/src/components/staff/create-login.ts`, `apps/web/src/components/settings/user-sheets.tsx` and `vercel.json`.

Official documentation links appear beside the technology claims. Compatibility was researched, not executed as an implementation spike. The plan does not claim that the selected plugins automatically satisfy our MFA, school membership, student provisioning or revocation requirements. Those are explicit implementation gates. No production infrastructure was provisioned, provider account configured, email/SMS sent or application code changed while preparing this plan.
