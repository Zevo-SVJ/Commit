import { createGeminiProvider } from './gemini.js'
import { createOpenAIProvider } from './openai.js'
import { createOpenRouterProvider, openRouterModel } from './openrouter.js'
import type { Provider } from './provider.js'

/**
 * Which model answers, decided by configuration alone.
 *
 * Nothing above this file changes when the answer changes — the handler asks
 * for a Provider and gets one.
 */
export type ProviderName = 'openrouter' | 'openai' | 'gemini'

const NAMES: ProviderName[] = ['openrouter', 'openai', 'gemini']

/**
 * OpenRouter unless `LOCK_PROVIDER` explicitly says otherwise.
 *
 * Deliberately not "whichever key happens to be present". A silent fallback is
 * how a deployment ends up quietly talking to a provider nobody chose, and how
 * a missing OpenRouter key gets reported as a missing OpenAI key — which is
 * exactly what happened here. With no key, the name is still `openrouter`, so
 * the failure that follows names the variable that is actually missing.
 * OpenAI and Gemini remain reachable, but only by asking for them by name.
 */
export function selectProviderName(env: NodeJS.ProcessEnv = process.env): ProviderName {
  const explicit = (env.LOCK_PROVIDER ?? '').trim().toLowerCase() as ProviderName
  if (NAMES.includes(explicit)) return explicit
  return 'openrouter'
}

export function createProvider(env: NodeJS.ProcessEnv = process.env): Provider {
  switch (selectProviderName(env)) {
    case 'gemini':
      return createGeminiProvider(env)
    case 'openai':
      return createOpenAIProvider(env)
    default:
      return createOpenRouterProvider(env)
  }
}

/** The model each provider would use. Never a key. */
export function modelFor(name: ProviderName, env: NodeJS.ProcessEnv = process.env): string {
  if (name === 'gemini') return env.GEMINI_MODEL || 'gemini-2.5-flash'
  // `LOCK_MODEL` belongs to OpenRouter, so OpenAI reads its own variable —
  // one shared name across two providers cannot hold two different slugs.
  if (name === 'openai') return env.OPENAI_MODEL || 'gpt-4.1'
  return openRouterModel(env)
}

export function keyVariableFor(name: ProviderName): string {
  if (name === 'gemini') return 'GEMINI_API_KEY'
  if (name === 'openai') return 'OPENAI_API_KEY'
  return 'OPENROUTER_API_KEY'
}

/** What is configured, for diagnostics. Never includes a key. */
export function describeProvider(env: NodeJS.ProcessEnv = process.env) {
  const name = selectProviderName(env)
  return {
    name,
    model: modelFor(name, env),
    keyVariable: keyVariableFor(name),
      selectedBy: (env.LOCK_PROVIDER ?? '').trim() ? 'LOCK_PROVIDER' : 'the default (openrouter)',
  }
}
