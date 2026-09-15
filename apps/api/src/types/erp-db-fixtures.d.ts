// packages/db ships its fixtures as JavaScript; describe the parts we use.
declare module '@erp/db/fixtures' {
  import type { Pool } from 'pg'
  export const fixtureIds: Readonly<Record<string, string>>
  export function seedFixtures(pool: Pool): Promise<void>
}
