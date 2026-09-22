/**
 * The protected school API, one namespace per backend module.
 *
 * Every function takes the school id first, because the server reads the school from the URL and
 * decides access against it; nothing here decides anything. Responses are parsed through the
 * @erp/contracts schema, so a server that drifts fails loudly as UNEXPECTED_RESPONSE instead of
 * handing a screen a wrong-shaped object.
 *
 * Signing in, `/api/me`, the school context and accepting an invitation are not here: they belong
 * to lib/auth-client.ts, because they are about the session rather than about one school.
 */
import * as setup from './setup'
import * as students from './students'
import * as staff from './staff'
import * as timetable from './timetable'
import * as dashboard from './dashboard'
import * as fees from './fees'
import * as searchModule from './search'
import * as audit from './audit'
import * as members from './members'
import * as files from './files'

export const api = {
  setup,
  students: {
    ...students,
    /** `export` is a keyword, so the function is declared as `exportStudents`. */
    export: students.exportStudents,
  },
  staff: {
    ...staff,
    export: staff.exportStaff,
  },
  timetable: {
    ...timetable,
    export: timetable.exportTimetable,
  },
  dashboard,
  fees,
  search: {
    ...searchModule,
    /** The whole module is one call; `api.search.run(schoolId, q)` reads best at a call site. */
    run: searchModule.search,
  },
  audit: {
    ...audit,
    export: audit.exportEvents,
  },
  members,
  files,
} as const

export * from './shared'
export type { Dashboard } from './dashboard'
export type { SearchResults } from './search'
