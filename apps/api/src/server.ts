import { loadConfig } from './config.ts'
import { createPools } from './db.ts'
import { createDelivery } from './delivery/index.ts'
import { createAuth } from './auth/better-auth.ts'
import { buildApp } from './app.ts'

const config = loadConfig()
const pools = await createPools(config)
const delivery = createDelivery(config)
const auth = createAuth(config, pools.auth, delivery, pools.identity)
const app = buildApp({ config, auth, delivery, pools })

await app.listen({ port: config.PORT, host: '127.0.0.1' })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close()
    await pools.close()
  })
}
