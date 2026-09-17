// packages/db ships its fixtures as JavaScript; describe the parts we use.
// The same shim as apps/api/src/types/erp-db-fixtures.d.ts, because this
// package compiles on its own.
declare module '@erp/db/fixtures' {
  import type { Pool } from 'pg'
  export const fixtureIds: Readonly<Record<string, string>>
  export function seedFixtures(pool: Pool): Promise<void>
}
