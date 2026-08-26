import { SYSTEM_PROMPT } from './prompt.js'
import { InvalidModelOutput, TURN_JSON_SCHEMA } from './schema.js'
import {
  ProviderError,
  providerFailure,
  withRetry,
  type Provider,
  type ProviderRequest,
} from './provider.js'

/**
 * OpenAI, over the Responses API.
 *
 * No SDK: one POST with a JSON body. Avoiding the dependency keeps the
 * serverless bundle small and the failure modes visible.
 */

/**
 * Reads the provider's own error envelope.
 *
 * This is the whole point of the exercise: HTTP 429 covers two completely
 * different situations. `insufficient_quota` means the account has no credit
 * and no amount of waiting fixes it; `rate_limit_exceeded` means slow down.
 * Telling a user to "give it a moment" when their billing is empty sends them
 * in the wrong direction indefinitely.
 */
export function classifyProviderError(
  status: number,
  body: string,
  headers: { get(name: string): string | null },
): ProviderError {
  let type = ''
  let code = ''
  let message = ''
  try {
    const parsed = JSON.parse(body) as { error?: { type?: string; code?: string; message?: string } }
    type = parsed.error?.type ?? ''
    code = parsed.error?.code ?? ''
    message = parsed.error?.message ?? ''
  } catch {
    message = body.slice(0, 300)
  }

  const providerCode = code || type || undefined
  const requestId = headers.get('x-request-id') ?? undefined
  const retryHeader = Number(headers.get('retry-after'))
  const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined
  const extra = { status, retryAfter, requestId, providerCode }
  const detail = `${status} ${providerCode ?? 'unknown'}: ${message}`.slice(0, 400)

  const quota =
    type === 'insufficient_quota' ||
    code === 'insufficient_quota' ||
    code === 'billing_hard_limit_reached' ||
    /quota|billing|credit|payment/i.test(message)

  if (status === 429) {
    return quota
      ? new ProviderError(`quota exhausted — ${detail}`, 'quota', extra)
      : new ProviderError(`rate limited — ${detail}`, 'rate_limited', extra)
  }

  if (status === 401 || status === 403) {
    return new ProviderError(`credentials rejected — ${detail}`, 'auth', extra)
  }

  if (status === 404 || code === 'model_not_found') {
    return new ProviderError(`model unavailable — ${detail}`, 'model_unavailable', extra)
  }

  if (status === 400 || status === 422) {
    return new ProviderError(`request refused — ${detail}`, 'bad_request', extra)
  }

  return new ProviderError(`model returned ${detail}`, 'upstream', extra)
}

const DEFAULT_MODEL = 'gpt-4.1'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

export function createOpenAIProvider(env: NodeJS.ProcessEnv = process.env): Provider {
  return withRetry((req, signal) => attempt(env, req, signal))
}

async function attempt(
  env: NodeJS.ProcessEnv,
  req: ProviderRequest,
  signal: AbortSignal,
): Promise<unknown> {
  const key = env.OPENAI_API_KEY
  if (!key) {
    throw new ProviderError('OPENAI_API_KEY is not set', 'unconfigured')
  }

  /* One try around the whole exchange — see the note in openrouter.ts. */
  const base = (env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
  let stage = 'connecting'
  try {
    const res = await fetch(`${base}/responses`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || DEFAULT_MODEL,
        instructions: SYSTEM_PROMPT,
        input: [{ role: 'user', content: `${req.brief}\n\n${req.instruction}` }],
        // Deliberately low: Lock should be consistent, not creative.
        temperature: 0.35,
        // The schema is large; too low a cap truncates the JSON mid-object
        // and the turn is discarded as unparseable.
        max_output_tokens: 1600,
        text: {
          format: {
            type: 'json_schema',
            name: 'lock_turn',
            strict: true,
            schema: TURN_JSON_SCHEMA,
          },
        },
      }),
    })

    stage = 'reading the response'
    const text = await res.text()

    if (!res.ok) {
      // The provider's own envelope is the only thing that can tell a genuine
      // rate limit apart from an empty account. Logged in full server-side;
      // only a scrubbed summary ever reaches the browser.
      throw classifyProviderError(res.status, text, res.headers)
    }

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new ProviderError('provider returned a non-JSON response', 'upstream', {
        status: res.status,
      })
    }

    // A run cut short by the token cap yields valid-looking but partial JSON.
    if (payload.status === 'incomplete') {
      const reason = (payload.incomplete_details as { reason?: string } | undefined)?.reason
      throw new InvalidModelOutput(`the model stopped early (${reason ?? 'unknown'})`)
    }
    return extractJson(payload)
  } catch (err) {
    if (err instanceof InvalidModelOutput) throw err
    throw providerFailure(err, signal, stage)
  }
}

/**
 * Pulls the structured object out of a Responses API payload.
 *
 * `output_text` is the documented convenience field, but it is not always
 * present depending on the shape of the response, so the nested output array is
 * walked as a fallback.
 */
export function extractJson(payload: Record<string, unknown>): unknown {
  const direct = payload.output_text
  if (typeof direct === 'string' && direct.trim()) return safeParse(direct)

  const output = payload.output
  if (Array.isArray(output)) {
    for (const item of output) {
      const content = (item as Record<string, unknown>)?.content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        const p = part as Record<string, unknown>
        if (typeof p?.text === 'string' && p.text.trim()) return safeParse(p.text)
        // Some gateways return the already-parsed object.
        if (p?.type === 'output_json' && p.json) return p.json
      }
    }
  }
  throw new ProviderError('model returned an empty response', 'upstream')
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // A refusal or a truncated stream lands here.
    throw new ProviderError('model returned unparseable output', 'upstream')
  }
}
