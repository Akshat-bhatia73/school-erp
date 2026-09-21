import type { AuthzConnection } from '@erp/authz'
import type { RequestContext } from '@erp/contracts/server'
import { PdfBuilder } from './kit.ts'

/**
 * The two facts every export document carries besides its own record: which
 * school it belongs to and who asked for it. Both are read inside the caller's
 * own tenant transaction, so neither can name anything outside this school.
 */
interface DocumentHeader {
  readonly schoolName: string
  readonly generatedBy: string
}

interface HeaderRow {
  school_name: string | null
  actor_name: string | null
}

async function loadHeader(
  conn: AuthzConnection,
  context: RequestContext,
): Promise<DocumentHeader> {
  const found = await conn.client.query<HeaderRow>(
    `SELECT (SELECT name FROM schools WHERE id = $1) AS school_name,
            coalesce(
              (SELECT trim(s.first_name || ' ' || coalesce(s.last_name, ''))
                 FROM membership_staff_links msl
                 JOIN staff s ON s.school_id = msl.school_id AND s.id = msl.staff_id
                WHERE msl.school_id = $1 AND msl.membership_id = $2),
              (SELECT trim(g.first_name || ' ' || coalesce(g.last_name, ''))
                 FROM membership_guardian_links mgl
                 JOIN guardians g ON g.school_id = mgl.school_id AND g.id = mgl.guardian_id
                WHERE mgl.school_id = $1 AND mgl.membership_id = $2)
            ) AS actor_name`,
    [context.schoolId, context.membershipId],
  )
  const row = found.rows[0]
  const actor = (row?.actor_name ?? '').trim()
  return {
    schoolName: (row?.school_name ?? '').trim() || 'School',
    // A login with no person record behind it in this school is still allowed
    // to export; the footer simply says nothing about who they are.
    generatedBy: actor === '' ? 'a school user' : actor,
  }
}

/**
 * A document with this school's header and this caller's footer, ready for the
 * producer to add panels to.
 */
export async function openDocument(
  conn: AuthzConnection,
  context: RequestContext,
  input: { title: string; landscape?: boolean },
): Promise<PdfBuilder> {
  const header = await loadHeader(conn, context)
  return new PdfBuilder({
    schoolName: header.schoolName,
    title: input.title,
    generatedBy: header.generatedBy,
    generatedOn: context.now,
    ...(input.landscape === undefined ? {} : { landscape: input.landscape }),
  })
}
