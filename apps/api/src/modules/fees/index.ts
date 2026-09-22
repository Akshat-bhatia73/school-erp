import type { FastifyInstance } from 'fastify'
import type { ModuleDependencies } from '../shared/index.ts'
import { registerFeeSetupRoutes } from './setup.ts'
import { registerFeePupilRoutes } from './pupil.ts'
import { registerFeeReceiptRoutes } from './receipts.ts'
import { registerFeeStatementRoutes } from './statement.ts'
import { registerFeeExportRoutes } from './exports.ts'

/**
 * The fees module (Task 19). What the school charges comes first, then what
 * one pupil takes and is let off, then the ledger, then the statement and the
 * dues list that are worked out from all three, then the files.
 */
export function registerFeeRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  registerFeeSetupRoutes(app, deps)
  registerFeePupilRoutes(app, deps)
  registerFeeReceiptRoutes(app, deps)
  registerFeeStatementRoutes(app, deps)
  registerFeeExportRoutes(app, deps)
}
