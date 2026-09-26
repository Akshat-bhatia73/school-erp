/**
 * The app the eval talks to: assembled in-process the way src/runtime.ts
 * assembles it (configuration, pools, delivery, authentication, buildApp),
 * against the fixture database, with every seeded role signed in. The model
 * is the configured one (ASSISTANT_PROVIDER, ASSISTANT_MODEL and its key),
 * paced to stay under the provider's rate limit, or with --scripted the
 * scripted one.
 */
import { gateway, wrapLanguageModel, type LanguageModel } from 'ai'
import type { FastifyInstance } from 'fastify'
import pg from 'pg'
import { loadConfig, type ApiConfig } from '../src/config.ts'
import { createPools, type ApiPools } from '../src/db.ts'
import { createDelivery, type DeliveryAdapter } from '../src/delivery/index.ts'
import { createAuth, type AuthInstance } from '../src/auth/better-auth.ts'
import { createMemoryDocumentStorage } from '../src/files/storage.ts'
import { buildApp } from '../src/app.ts'
import { assistantModel } from '../src/assistant/model.ts'
import { clearSignInLimits, InjectClient, signInAsPupil, signInWithEmail, signInWithPhone } from './client.ts'
import { addInjectedNote, addTwins, openTheAssistant, sendInjectedNotice } from './extras.ts'
import { loadFacts, LOGIN_CODE, LOGINS, schoolIdOf } from './facts.ts'
import { EVAL_ORIGIN, fixtureEnv, fixtureUrls, runDevSeed, seededLogins } from './fixture.ts'
import { scriptedModel, type ScriptedTurn } from './scripted.ts'
import type { EvalRole, Facts } from './types.ts'

export interface EnvironmentOptions {
  readonly scripted: boolean
  /** Build the school afresh with the dev seed first. */
  readonly seed: boolean
  /** The least time between two requests to the model, in milliseconds. */
  readonly gapMs: number
  /** Where the fixture is; EVAL_DATABASE_URL by default. */
  readonly databaseUrl?: string
  readonly log?: (line: string) => void
}

export interface EvalEnvironment {
  readonly app: FastifyInstance
  readonly config: ApiConfig
  /** The fixture database as its owner: for the eval's own setup and the truth functions only. */
  readonly db: pg.Pool
  readonly facts: Facts
  readonly clients: Readonly<Record<EvalRole, InjectClient>>
  /** "google/gemini-3.5-flash-lite", or "scripted". */
  readonly modelId: string
  readonly provider: string
  /** Scripted mode: what the scripted model answers next. */
  setScriptedTurn(turn: ScriptedTurn | undefined): void
  close(): Promise<void>
}

/** Which key the configured provider needs, or null when it is there. */
export function missingModelKey(env: NodeJS.ProcessEnv): string | null {
  const provider = env.ASSISTANT_PROVIDER ?? 'gateway'
  if (provider === 'google') {
    return env.GOOGLE_GENERATIVE_AI_API_KEY
      ? null
      : 'ASSISTANT_PROVIDER=google needs GOOGLE_GENERATIVE_AI_API_KEY (a Google AI Studio key; test data only on the free tier).'
  }
  return env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN
    ? null
    : 'ASSISTANT_PROVIDER=gateway (the default) needs AI_GATEWAY_API_KEY. Or set ASSISTANT_PROVIDER=google with GOOGLE_GENERATIVE_AI_API_KEY.'
}

/**
 * The configured model with one wait in front of each request, so a run
 * stays under a per-minute quota (4.5 s is about 13 a minute, under 15 RPM).
 * Everything else is the model runtime.ts would use: the same provider
 * options are added by the turn from the same configuration.
 */
function pacedModel(config: ApiConfig, gapMs: number): LanguageModel {
  const chosen = assistantModel(config).model
  const model = typeof chosen === 'string' ? gateway(chosen) : chosen
  let next = 0
  const wait = async () => {
    const now = Date.now()
    const at = Math.max(now, next)
    next = at + gapMs
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now))
  }
  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]['model'],
    middleware: {
      wrapGenerate: async ({ doGenerate }) => {
        await wait()
        return doGenerate()
      },
      wrapStream: async ({ doStream }) => {
        await wait()
        return doStream()
      },
    },
  })
}

export async function openEnvironment(options: EnvironmentOptions): Promise<EvalEnvironment> {
  const log = options.log ?? (() => {})
  const urls = fixtureUrls(options.databaseUrl ?? process.env.EVAL_DATABASE_URL)
  if (!options.scripted) {
    const missing = missingModelKey(process.env)
    if (missing) throw new Error(`${missing}\nTo exercise the eval without a model, pass --scripted.`)
  }
  if (options.seed) {
    log(`Seeding the Sunrise school into ${urls.name} with the dev seed…`)
    await runDevSeed(urls)
  }

  // NODE_ENV=test only keeps the request log quiet; nothing else in the app reads it but cookies in production.
  // The scripted model is never a provider; the placeholder key only lets the
  // service switch read "on", as the API tests do. A real key is never used then.
  const scriptedProvider = options.scripted
    ? { ASSISTANT_PROVIDER: 'gateway', AI_GATEWAY_API_KEY: 'scripted-eval-never-used', GOOGLE_GENERATIVE_AI_API_KEY: undefined }
    : {}
  const config = loadConfig(fixtureEnv(urls, { ASSISTANT_ENABLED: 'true', PORT: '3999', NODE_ENV: 'test', ...scriptedProvider }))
  const pools: ApiPools = await createPools(config)
  const delivery: DeliveryAdapter = createDelivery(config, pools.auth)
  const auth: AuthInstance = createAuth(config, pools.auth, delivery, pools.identity)
  let scriptedTurn: ScriptedTurn | undefined
  const model = options.scripted ? scriptedModel(() => scriptedTurn) : pacedModel(config, options.gapMs)
  const app = buildApp({
    config,
    auth,
    delivery,
    pools,
    documents: createMemoryDocumentStorage(),
    assistant: { assistantModel: model },
  })
  await app.ready()

  const db = new pg.Pool({ connectionString: urls.migrator })
  const close = async () => {
    await app.close()
    await pools.close()
    await db.end()
  }
  try {
    const schoolId = await schoolIdOf(db)
    await addTwins(db, schoolId)
    const facts = await loadFacts(db)
    await addInjectedNote(db, facts)
    await openTheAssistant(db, schoolId)

    const logins = await seededLogins()
    const loginFor = (key: string) => {
      const found = logins.get(key)
      if (!found) throw new Error(`The seeded logins have no ${key}.`)
      return found
    }
    const clients = {} as Record<EvalRole, InjectClient>
    for (const role of Object.keys(LOGINS) as EvalRole[]) {
      await clearSignInLimits(db)
      const client = new InjectClient(app, EVAL_ORIGIN)
      const login = loginFor(LOGINS[role])
      if (role === 'pupil') {
        await signInAsPupil(client, { schoolCode: LOGIN_CODE, admissionNumber: login.email, password: login.password })
      } else if (role === 'parent') {
        await signInWithPhone(client, delivery, login.phone)
      } else {
        await signInWithEmail(client, auth, { email: login.email, password: login.password, totpSecret: login.totpSecret || undefined })
      }
      const status = await client.get(`/api/schools/${schoolId}/assistant/status`)
      const available = status.status === 200 && status.json<{ available: boolean; reason?: string }>()
      if (!available || !available.available) {
        throw new Error(`The assistant is not available to the ${role} login: ${status.status} ${status.body.slice(0, 200)}`)
      }
      clients[role] = client
    }
    await sendInjectedNotice(db, schoolId, clients.owner)
    log(`Signed in ${Object.keys(clients).length} people at ${facts.schoolName}; today is ${facts.today}.`)

    return {
      app,
      config,
      db,
      facts,
      clients,
      modelId: options.scripted ? 'scripted' : config.ASSISTANT_MODEL,
      provider: options.scripted ? 'scripted' : config.ASSISTANT_PROVIDER,
      setScriptedTurn: (turn) => {
        scriptedTurn = turn
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
