import { SYSTEM_PROMPT } from './prompt.js'
import { TURN_JSON_SCHEMA } from './schema.js'
import { ProviderError, withRetry, type Provider, type ProviderRequest } from './provider.js'

/**
 * Google Gemini, over the Generative Language API.
 *
 * Shapes below are taken from the v1beta discovery document
 * (generativelanguage.googleapis.com/$discovery/rest?version=v1beta), not from
 * memory: `generationConfig.responseSchema` is an OpenAPI 3.0 subset whose
 * `type` is an uppercase enum, which has `nullable` but no
 * `additionalProperties`. The turn shape is still defined once, in schema.ts,
 * and translated here.
 */

const DEFAULT_MODEL = 'gemini-2.5-flash'
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

/* ------------------------------------------------------------------ */
/* Schema translation                                                  */
/* ------------------------------------------------------------------ */

/** Keywords the OpenAPI subset accepts. Anything else is dropped. */
const ALLOWED = new Set([
  'type', 'format', 'description', 'nullable', 'enum', 'items', 'properties',
  'required', 'propertyOrdering', 'anyOf', 'minItems', 'maxItems', 'title',
])

const TYPE_NAMES: Record<string, string> = {
  string: 'STRING', number: 'NUMBER', integer: 'INTEGER',
  boolean: 'BOOLEAN', array: 'ARRAY', object: 'OBJECT', null: 'NULL',
}

/**
 * Rewrites the strict JSON Schema into Gemini's dialect.
 *
 * Three differences matter: types are uppercase; a `["string","null"]` union
 * becomes `nullable: true`; and `additionalProperties` does not exist and must
 * be removed rather than passed through, or the request is refused.
 */
export function toGeminiSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toGeminiSchema)
  if (!node || typeof node !== 'object') return node

  const src = node as Record<string, unknown>
  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(src)) {
    if (!ALLOWED.has(key)) continue

    if (key === 'type') {
      const types = Array.isArray(value) ? value : [value]
      const real = types.filter((t) => t !== 'null')
      // A union with null is the only union the turn schema uses.
      if (types.length !== real.length) out.nullable = true
      const name = String(real[0] ?? 'string').toLowerCase()
      out.type = TYPE_NAMES[name] ?? 'STRING'
      continue
    }

    if (key === 'properties') {
      const props = value as Record<string, unknown>
      out.properties = Object.fromEntries(
        Object.entries(props).map(([k, v]) => [k, toGeminiSchema(v)]),
      )
      // Ordering the fields makes the model's output stable turn to turn.
      out.propertyOrdering = Object.keys(props)
      continue
    }

    if (key === 'items' || key === 'anyOf') {
      out[key] = toGeminiSchema(value)
      continue
    }

    if (key === 'enum') {
      // Gemini enums are strings only; a null member is expressed by nullable.
      const members = (value as unknown[]).filter((v) => v !== null).map(String)
      if (members.length) out.enum = members
      continue
    }

    out[key] = value
  }

  return out
}

export const GEMINI_TURN_SCHEMA = toGeminiSchema(TURN_JSON_SCHEMA)

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * Google APIs answer with `{error:{code,message,status}}`, where `status` is a
 * canonical code. RESOURCE_EXHAUSTED covers both a per-minute limit and a
 * spent quota, exactly as OpenAI's 429 does, so the message decides which.
 */
export function classifyGeminiError(
  status: number,
  body: string,
  headers: { get(name: string): string | null },
): ProviderError {
  let canonical = ''
  let message = ''
  try {
    const parsed = JSON.parse(body) as { error?: { status?: string; message?: string } }
    canonical = parsed.error?.status ?? ''
    message = parsed.error?.message ?? ''
  } catch {
    message = body.slice(0, 300)
  }

  const providerCode = canonical || undefined
  const retryHeader = Number(headers.get('retry-after'))
  const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined
  const extra = {
    status,
    retryAfter,
    requestId: headers.get('x-request-id') ?? undefined,
    providerCode,
  }
  const detail = `${status} ${providerCode ?? 'unknown'}: ${message}`.slice(0, 400)

  if (status === 429 || canonical === 'RESOURCE_EXHAUSTED') {
    // A free-tier key that has run out of daily requests reads as quota; a
    // per-minute ceiling reads as a rate limit and does clear on its own.
    const quota = /quota|billing|credit|per day|daily limit/i.test(message)
    return quota
      ? new ProviderError(`quota exhausted — ${detail}`, 'quota', extra)
      : new ProviderError(`rate limited — ${detail}`, 'rate_limited', extra)
  }

  if (status === 401 || status === 403 || canonical === 'UNAUTHENTICATED' ||
      canonical === 'PERMISSION_DENIED') {
    return new ProviderError(`credentials rejected — ${detail}`, 'auth', extra)
  }

  if (status === 404 || canonical === 'NOT_FOUND') {
    return new ProviderError(`model unavailable — ${detail}`, 'model_unavailable', extra)
  }

  if (status === 400 || canonical === 'INVALID_ARGUMENT' ||
      canonical === 'FAILED_PRECONDITION') {
    return new ProviderError(`request refused — ${detail}`, 'bad_request', extra)
  }

  return new ProviderError(`model returned ${detail}`, 'upstream', extra)
}

/* ------------------------------------------------------------------ */
/* Response                                                            */
/* ------------------------------------------------------------------ */

/** Pulls the JSON turn out of a generateContent response. */
export function extractGeminiJson(payload: Record<string, unknown>): unknown {
  const feedback = payload.promptFeedback as { blockReason?: string } | undefined
  if (feedback?.blockReason) {
    throw new ProviderError(`prompt blocked (${feedback.blockReason})`, 'bad_request')
  }

  const candidates = payload.candidates as Array<Record<string, unknown>> | undefined
  const candidate = candidates?.[0]
  if (!candidate) {
    throw new ProviderError('model returned no candidates', 'upstream')
  }

  const finish = candidate.finishReason as string | undefined
  // A run cut short leaves valid-looking but partial JSON, so say so rather
  // than letting the validator report a mangled turn.
  if (finish && finish !== 'STOP' && finish !== 'FINISH_REASON_UNSPECIFIED') {
    throw new ProviderError(`model stopped early (${finish})`, 'upstream')
  }

  const content = candidate.content as { parts?: Array<{ text?: string }> } | undefined
  const text = (content?.parts ?? [])
    .map((p) => p?.text)
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .join('')

  if (!text.trim()) throw new ProviderError('model returned an empty response', 'upstream')

  try {
    return JSON.parse(text)
  } catch {
    throw new ProviderError('model returned unparseable output', 'upstream')
  }
}

/* ------------------------------------------------------------------ */
/* The provider                                                        */
/* ------------------------------------------------------------------ */

export function createGeminiProvider(env: NodeJS.ProcessEnv = process.env): Provider {
  return withRetry((req, signal) => attempt(env, req, signal))
}

async function attempt(
  env: NodeJS.ProcessEnv,
  req: ProviderRequest,
  signal: AbortSignal,
): Promise<unknown> {
  const key = env.GEMINI_API_KEY
  if (!key) throw new ProviderError('GEMINI_API_KEY is not set', 'unconfigured')

  const model = env.GEMINI_MODEL || DEFAULT_MODEL
  const base = (env.GEMINI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')

  let res: Response
  try {
    res = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        // The header form, not ?key= — a query parameter ends up in access
        // logs, proxies and browser history.
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: `${req.brief}\n\n${req.instruction}` }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_TURN_SCHEMA,
          // Deliberately low: Lock should be consistent, not creative.
          temperature: 0.35,
          maxOutputTokens: 1600,
        },
      }),
    })
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new ProviderError('model call timed out', 'timeout')
    }
    throw new ProviderError('could not reach the model', 'upstream')
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw classifyGeminiError(res.status, body, res.headers)
  }

  return extractGeminiJson((await res.json()) as Record<string, unknown>)
}
