import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'
import type { ApiConfig } from '../config.ts'

type ProviderOptions = Record<string, Record<string, string | number | boolean | string[]>>

export interface ChosenModel {
  readonly model: LanguageModel
  readonly providerOptions: ProviderOptions
}

/**
 * The model the assistant talks to, chosen by configuration alone.
 *
 * The gateway sends every request to Google Vertex AI and, unless switched
 * off for a test deployment, only under zero data retention; it never falls
 * back to a provider that keeps data. Google AI Studio is called directly
 * with the school's own key; the model id is ASSISTANT_MODEL without its
 * `google/` prefix.
 */
export function assistantModel(config: ApiConfig): ChosenModel {
  if (config.ASSISTANT_PROVIDER === 'google') {
    const google = createGoogleGenerativeAI({ apiKey: config.GOOGLE_GENERATIVE_AI_API_KEY ?? '' })
    return { model: google(config.ASSISTANT_MODEL.slice('google/'.length)), providerOptions: {} }
  }
  return {
    model: config.ASSISTANT_MODEL,
    providerOptions: {
      gateway: {
        only: ['vertex'],
        ...(config.ASSISTANT_ZERO_DATA_RETENTION ? { zeroDataRetention: true } : {}),
      },
    },
  }
}
