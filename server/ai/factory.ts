import { createGeminiProvider } from './gemini.js'
import { createOpenAIProvider } from './openai.js'
import type { Provider } from './provider.js'

/**
 * Which model answers, decided by configuration alone.
 *
 * Nothing above this file changes when the answer changes — the handler asks
 * for a Provider and gets one.
 */
export type ProviderName = 'openai' | 'gemini'

/**
 * Explicit `LOCK_PROVIDER` wins. Otherwise whichever key is present decides,
 * with Gemini first so that adding a Gemini key is all it takes to switch.
 * With neither, OpenAI is named so the "not connected" message stays familiar.
 */
export function selectProviderName(env: NodeJS.ProcessEnv = process.env): ProviderName {
  const explicit = (env.LOCK_PROVIDER ?? '').trim().toLowerCase()
  if (explicit === 'openai' || explicit === 'gemini') return explicit
  if (env.GEMINI_API_KEY) return 'gemini'
  if (env.OPENAI_API_KEY) return 'openai'
  return 'openai'
}

export function createProvider(env: NodeJS.ProcessEnv = process.env): Provider {
  return selectProviderName(env) === 'gemini'
    ? createGeminiProvider(env)
    : createOpenAIProvider(env)
}

/** What is configured, for diagnostics. Never includes a key. */
export function describeProvider(env: NodeJS.ProcessEnv = process.env) {
  const name = selectProviderName(env)
  return {
    name,
    model:
      name === 'gemini'
        ? env.GEMINI_MODEL || 'gemini-2.5-flash'
        : env.LOCK_MODEL || 'gpt-4.1',
    keyVariable: name === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY',
    selectedBy: (env.LOCK_PROVIDER ?? '').trim() ? 'LOCK_PROVIDER' : 'the key that is present',
  }
}
