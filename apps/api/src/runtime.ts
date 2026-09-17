import type { FastifyInstance } from 'fastify'
import { loadConfig, type ApiConfig } from './config.ts'
import { createPools, type ApiPools } from './db.ts'
import { createDelivery } from './delivery/index.ts'
import { createAuth } from './auth/better-auth.ts'
import { createBlobDocumentStorage } from './files/blob.ts'
import { createLocalDocumentStorage, type DocumentStorage } from './files/storage.ts'
import { initObservability } from './observability.ts'
import { buildApp } from './app.ts'

export interface Runtime {
  readonly config: ApiConfig
  readonly pools: ApiPools
  readonly app: FastifyInstance
}

function createDocuments(config: ApiConfig): DocumentStorage {
  // loadConfig already requires the token with blob storage.
  if (config.DOCUMENT_STORAGE === 'blob' && config.BLOB_READ_WRITE_TOKEN)
    return createBlobDocumentStorage(config.BLOB_READ_WRITE_TOKEN)
  return createLocalDocumentStorage(config.DOCUMENT_STORAGE_DIR)
}

/** The one way to assemble the API, shared by the server and the function. */
export async function createRuntime(): Promise<Runtime> {
  const config = loadConfig()
  initObservability(config)
  const pools = await createPools(config)
  const delivery = createDelivery(config, pools.auth)
  const auth = createAuth(config, pools.auth, delivery, pools.identity)
  const documents = createDocuments(config)
  const app = buildApp({ config, auth, delivery, pools, documents })
  return { config, pools, app }
}
