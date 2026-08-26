import { SYSTEM_PROMPT } from './prompt.js'
import { TURN_JSON_SCHEMA } from './schema.js'
import { ProviderError, withRetry, type Provider, type ProviderRequest } from './provider.js'

/**
 * OpenRouter, over its OpenAI-compatible chat/completions endpoint.
 *
 * No SDK: one POST with a JSON body, same as the other two implementations.
 * OpenRouter is a gateway, so a request can fail in two places — at the
 * gateway (bad key, no credit, unknown model) or at whichever upstream
 * provider it routed to. Both are reported here as the same
 * `ProviderErrorKind` vocabulary, so nothing above this file has to know that
 * a gateway is involved at all.
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * OpenRouter's free-models router.
 *
 * Chosen over pinning one `:free` model because free model availability churns
 * — a slug that is free today can be paid or retired next month, and this app
 * has no budget to fall back on. The router only ever selects from free models,
 * and it filters that pool down to models that support the features the request
 * actually uses, which for Lock means structured outputs.
 *
 * The cost of the router is that the model varies between requests. Set
 * `LOCK_MODEL` to a specific slug to pin one; `/probe` lists the slugs the
 * configured key can actually reach.
 */
const DEFAULT_MODEL = 'openrouter/free'

/**
 * Reads OpenRouter's error envelope.
 *
 * The distinction that matters most here is 402 from 429. OpenRouter answers
 * 402 when the account is out of credit and 429 when a rate limit was hit, so
 * unlike OpenAI the two are not tangled together in one status — but a spent
 * free-tier daily allowance still arrives as 429, and telling someone to "give
 * it a moment" when the allowance resets tomorrow sends them nowhere.
 */
export function classifyOpenRouterError(
  status: number,
  body: string,
  headers: { get(name: string): string | null },
): ProviderError {
  let code = ''
  let message = ''
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string | number; type?: string; message?: string; metadata?: unknown }
    }
    const raw = parsed.error?.code
    // OpenRouter usually puts the HTTP status in `code`; a numeric code that
    // just repeats the status carries no information, so prefer `type`.
    code = parsed.error?.type ?? (typeof raw === 'string' ? raw : raw ? String(raw) : '')
    message = parsed.error?.message ?? ''
  } catch {
    message = body.slice(0, 300)
  }

  const providerCode = code || undefined
  const requestId = headers.get('x-request-id') ?? undefined
  const retryHeader = Number(headers.get('retry-after'))
  const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined
  const extra = { status, retryAfter, requestId, providerCode }
  const detail = `${status} ${providerCode ?? 'unknown'}: ${message}`.slice(0, 400)

  // "No endpoints found" is how OpenRouter says a slug exists but nothing can
  // serve it under the current data policy or parameter requirements. That is
  // a model problem, not a request problem, whichever status carries it.
  const noRoute = /no endpoints found|not a valid model|no allowed providers|is not a valid model/i.test(message)
  const outOfCredit = /credit|quota|balance|insufficient|payment|billing/i.test(message)

  if (status === 402) {
    return new ProviderError(`out of credit — ${detail}`, 'quota', extra)
  }

  if (status === 429) {
    // A daily free-tier allowance is spent rather than throttled; waiting the
    // retry-after does not bring it back.
    const daily = /per day|daily|day\b/i.test(message)
    return daily || outOfCredit
      ? new ProviderError(`allowance spent — ${detail}`, 'quota', extra)
      : new ProviderError(`rate limited — ${detail}`, 'rate_limited', extra)
  }

  if (status === 401 || status === 403) {
    return new ProviderError(`credentials rejected — ${detail}`, 'auth', extra)
  }

  if (status === 404 || noRoute) {
    return new ProviderError(`model unavailable — ${detail}`, 'model_unavailable', extra)
  }

  if (status === 408) {
    return new ProviderError(`model call timed out — ${detail}`, 'timeout', extra)
  }

  if (status === 400 || status === 422) {
    return new ProviderError(`request refused — ${detail}`, 'bad_request', extra)
  }

  return new ProviderError(`model returned ${detail}`, 'upstream', extra)
}

/**
 * Optional attribution. OpenRouter uses these to attribute traffic on its
 * rankings; neither is required, and neither carries anything private.
 */
export function attributionHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const site =
    env.LOCK_SITE_URL || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : '')
  const headers: Record<string, string> = { 'X-Title': env.LOCK_SITE_NAME || 'Lock' }
  if (site) headers['HTTP-Referer'] = site
  return headers
}

export function openRouterModel(env: NodeJS.ProcessEnv = process.env): string {
  return (env.LOCK_MODEL ?? '').trim() || DEFAULT_MODEL
}

export function openRouterBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

export function createOpenRouterProvider(env: NodeJS.ProcessEnv = process.env): Provider {
  return withRetry((req, signal) => attempt(env, req, signal))
}

async function attempt(
  env: NodeJS.ProcessEnv,
  req: ProviderRequest,
  signal: AbortSignal,
): Promise<unknown> {
  const key = (env.OPENROUTER_API_KEY ?? '').trim()
  if (!key) {
    throw new ProviderError('OPENROUTER_API_KEY is not configured', 'unconfigured')
  }

  let res: Response
  try {
    res = await fetch(`${openRouterBaseUrl(env)}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        ...attributionHeaders(env),
      },
      body: JSON.stringify({
        model: openRouterModel(env),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `${req.brief}\n\n${req.instruction}` },
        ],
        // Deliberately low: Lock should be consistent, not creative.
        temperature: 0.35,
        // The schema is large, and a free model may spend part of the budget
        // reasoning before it writes anything. Too low a cap truncates the
        // JSON mid-object and the turn is discarded as unparseable.
        max_tokens: 2048,
        // Asking for a schema is also what makes the free router narrow its
        // pool to models that can honour one.
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'lock_turn', strict: true, schema: TURN_JSON_SCHEMA },
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
    // The gateway's own envelope is the only thing that separates an empty
    // balance from a throttle. Logged in full server-side; only a scrubbed
    // summary ever reaches the browser.
    throw classifyOpenRouterError(res.status, body, res.headers)
  }

  const text = await res.text()
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new ProviderError('gateway returned a non-JSON response', 'upstream', {
      status: res.status,
    })
  }

  // A gateway can answer 200 and put the upstream provider's failure in the
  // body. Treated as the failure it is, with the same classification.
  if (payload.error) {
    throw classifyOpenRouterError(
      Number((payload.error as { code?: unknown }).code) || 502,
      text,
      res.headers,
    )
  }

  return extractOpenRouterJson(payload)
}

/**
 * Pulls the structured object out of a chat/completions payload.
 *
 * Structured outputs are honoured by most models and approximated by some, so
 * this does not assume the content is already clean JSON: a fenced block or a
 * sentence of preamble is unwrapped rather than thrown away. Whatever comes out
 * still has to survive `parseTurn` before it reaches anyone.
 */
export function extractOpenRouterJson(payload: Record<string, unknown>): unknown {
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderError('model returned an empty response', 'upstream')
  }

  const choice = choices[0] as Record<string, unknown>
  const finish = choice.finish_reason ?? choice.native_finish_reason
  if (finish === 'length') {
    throw new ProviderError('model stopped early (length)', 'upstream')
  }
  if (finish === 'content_filter') {
    throw new ProviderError('model refused the request (content_filter)', 'bad_request')
  }

  const message = (choice.message ?? {}) as Record<string, unknown>
  const content = message.content

  if (typeof content === 'string' && content.trim()) return safeParse(content)

  // Some models answer with content parts rather than a single string.
  if (Array.isArray(content)) {
    for (const part of content) {
      const p = part as Record<string, unknown>
      if (typeof p?.text === 'string' && p.text.trim()) return safeParse(p.text)
    }
  }

  // A rare gateway shape: the object already parsed.
  if (content && typeof content === 'object') return content

  throw new ProviderError('model returned an empty response', 'upstream')
}

/** JSON, a fenced block of JSON, or JSON with something said around it. */
function safeParse(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    /* fall through to the tolerant paths */
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim())
    } catch {
      /* fall through */
    }
  }

  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1))
    } catch {
      /* fall through */
    }
  }

  // A refusal or a truncated stream lands here.
  throw new ProviderError('model returned unparseable output', 'upstream')
}
