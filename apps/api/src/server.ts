import { loadConfig } from './config.ts'
import { createPools } from './db.ts'
import { createDelivery } from './delivery/index.ts'
import { createAuth } from './auth/better-auth.ts'
import { createLocalDocumentStorage } from './files/storage.ts'
import { buildApp } from './app.ts'

const config = loadConfig()
const pools = await createPools(config)
const delivery = createDelivery(config)
const auth = createAuth(config, pools.auth, delivery, pools.identity)
const documents = createLocalDocumentStorage(config.DOCUMENT_STORAGE_DIR)
const app = buildApp({ config, auth, delivery, pools, documents })

await app.listen({ port: config.PORT, host: config.HOST })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close()
    await pools.close()
  })
}
