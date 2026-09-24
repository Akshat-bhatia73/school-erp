import type { FastifyInstance } from 'fastify'
import type { ModuleDependencies } from '../shared/index.ts'
import { registerMessageReadRoutes } from './reads.ts'
import { registerInboxRoutes } from './inbox.ts'
import { registerMessageWriteRoutes } from './messages.ts'
import { registerMessageAttachmentRoutes } from './attachments.ts'
import { registerMessageTemplateRoutes } from './templates.ts'
import { registerCommunicationSettingsRoutes } from './settings.ts'
import { registerMessageExportRoutes } from './exports.ts'

/**
 * The communication module (Task 22). The inbox and the sent messages first,
 * then writing and sending, the files, the school's templates and the
 * automatic message settings, then the delivery record export. The automatic
 * messages and the email queue are not routes: see pump.ts.
 */
export function registerCommunicationRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  registerInboxRoutes(app, deps)
  registerMessageReadRoutes(app, deps)
  registerMessageWriteRoutes(app, deps)
  registerMessageAttachmentRoutes(app, deps)
  registerMessageTemplateRoutes(app, deps)
  registerCommunicationSettingsRoutes(app, deps)
  registerMessageExportRoutes(app, deps)
}
