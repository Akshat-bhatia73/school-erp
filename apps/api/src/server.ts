import { createRuntime } from './runtime.ts'

const { config, pools, app } = await createRuntime()

await app.listen({ port: config.PORT, host: config.HOST })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close()
    await pools.close()
  })
}
