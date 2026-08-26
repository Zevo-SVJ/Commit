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
 * Concrete free chat models, in preference order. Deliberately not a router.
 *
 * `openrouter/free` was the default here and it is what broke production. It
 * selects at random from everything free, and everything free includes models
 * that are not chat models at all: one real journey was routed to an NVIDIA
 * NemoGuard content-safety classifier, which answered `User Safety: safe` —
 * its job — and nothing downstream could turn that into a decision. A router
 * cannot promise instruction-following, so it is not something to build on.
 *
 * First choice enforces a JSON schema natively. Second is a fallback for when
 * the first is unreachable or answers with something unusable.
 */
const CANDIDATE_MODELS = [
  'openai/gpt-oss-120b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
]

/**
 * How a model wants to be asked for JSON.
 *
 * `json_schema` is enforcement: the model cannot emit anything else.
 * `json_object` only promises valid JSON, not our shape — the prompt and the
 * validator carry the rest. Sending `json_schema` to a model that does not
 * enforce it is a 400, so the default for anything unlisted is the weaker,
 * safer form rather than an assumption.
 */
export type ResponseFormat = 'json_schema' | 'json_object' | 'none'

const MODEL_FORMAT: Record<string, ResponseFormat> = {
  'openai/gpt-oss-120b:free': 'json_schema',
  'meta-llama/llama-3.3-70b-instruct:free': 'json_object',
}

export function formatFor(model: string, env: NodeJS.ProcessEnv = process.env): ResponseFormat {
  const forced = (env.LOCK_MODEL_FORMAT ?? '').trim().toLowerCase()
  if (forced === 'json_schema' || forced === 'json_object' || forced === 'none') return forced
  return MODEL_FORMAT[model] ?? 'json_object'
}

/**
 * The models this deployment will try, in order.
 *
 * `LOCK_MODEL` pins one outright. `LOCK_MODEL_FALLBACK` adds a second for when
 * the first cannot produce a usable turn.
 */
export function openRouterModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const pinned = (env.LOCK_MODEL ?? '').trim()
  const fallback = (env.LOCK_MODEL_FALLBACK ?? '').trim()
  if (pinned) return fallback && fallback !== pinned ? [pinned, fallback] : [pinned]
  return fallback ? [fallback, ...CANDIDATE_MODELS.filter((m) => m !== fallback)] : [...CANDIDATE_MODELS]
}

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

/** The model a turn is sent to first. What /probe and the diagnostics name. */
export function openRouterModel(env: NodeJS.ProcessEnv = process.env): string {
  return openRouterModels(env)[0]
}

/** The request body fragment for a given format. */
export function responseFormatFor(format: ResponseFormat): Record<string, unknown> {
  if (format === 'json_schema') {
    return {
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'lock_turn', strict: true, schema: TURN_JSON_SCHEMA },
      },
    }
  }
  if (format === 'json_object') return { response_format: { type: 'json_object' } }
  return {}
}

export function openRouterBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

/**
 * Which failures a *different model* could plausibly fix.
 *
 * Only two: the model produced nothing usable (a safety verdict, prose, a
 * truncated object), or it refused the request shape / could not be reached.
 * Everything else — no credit, a rejected key, a rate limit, a timeout, a
 * cancellation — would fail identically on any model, so trying a second one
 * spends an allowance to learn nothing.
 */
function anotherModelCouldHelp(err: unknown): boolean {
  if (err instanceof InvalidModelOutput) return true
  return (
    err instanceof ProviderError &&
    (err.kind === 'model_unavailable' || err.kind === 'bad_request')
  )
}

/**
 * One generation per model, at most one fallback.
 *
 * The fallback is safe by construction: it only runs when the previous model
 * produced no usable turn at all, so it cannot duplicate a user action or
 * commit a decision twice. `withRetry` sits inside the loop rather than around
 * it, so a rate limit retries its own model once instead of replaying the
 * whole chain.
 */
export function createOpenRouterProvider(env: NodeJS.ProcessEnv = process.env): Provider {
  const models = openRouterModels(env)
  return async (req, signal) => {
    let last: unknown
    for (let i = 0; i < models.length; i++) {
      const model = models[i]
      try {
        return await withRetry((r, s) => attempt(env, model, r, s))(req, signal)
      } catch (err) {
        last = err
        const more = i < models.length - 1
        if (!more || !anotherModelCouldHelp(err) || signal.aborted) throw err
        console.warn(
          `[lock] ${model} produced nothing usable (${
            err instanceof Error ? err.message.slice(0, 140) : String(err)
          }); trying ${models[i + 1]}`,
        )
      }
    }
    throw last
  }
}

async function attempt(
  env: NodeJS.ProcessEnv,
  model: string,
  req: ProviderRequest,
  signal: AbortSignal,
): Promise<unknown> {
  const key = (env.OPENROUTER_API_KEY ?? '').trim()
  if (!key) {
    throw new ProviderError('OPENROUTER_API_KEY is not configured', 'unconfigured')
  }

  /* One try around the *whole* exchange, not just the fetch.
     A slow model returns its headers early and then streams; an abort landing
     during the body read used to escape as a bare DOMException, which is what
     produced `HTTP 500 · upstream · AbortError` in production. Every await
     below can be interrupted, so every await below is covered. */
  const started = Date.now()
  let stage = 'connecting'
  try {
    const res = await fetch(`${openRouterBaseUrl(env)}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        ...attributionHeaders(env),
      },
      body: JSON.stringify({
        model,
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
        // Only ever the form this model actually supports. Asking a model
        // that cannot enforce a schema to enforce one is a 400.
        ...responseFormatFor(formatFor(model, env)),
      }),
    })

    stage = 'reading the response'
    const text = await res.text()

    if (!res.ok) {
      // The gateway's own envelope is the only thing that separates an empty
      // balance from a throttle. Logged in full server-side; only a scrubbed
      // summary ever reaches the browser.
      throw classifyOpenRouterError(res.status, text, res.headers)
    }

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

    console.log(
      `[lock] openrouter ok in ${Date.now() - started}ms · asked ${model} · answered ${
        typeof payload.model === 'string' ? payload.model : 'unknown'
      }`,
    )
    return extractOpenRouterJson(payload)
  } catch (err) {
    // A content fault is about what the model said, not about the transport,
    // so it keeps its own identity all the way to `invalid_response`.
    if (err instanceof InvalidModelOutput) throw err
    const failure = providerFailure(err, signal, stage)
    if (failure !== err) {
      console.error(
        `[lock] openrouter (${model}) failed after ${Date.now() - started}ms while ${stage}`,
      )
    }
    throw failure
  }
}

/**
 * A content-safety classifier answering instead of a chat model.
 *
 * NVIDIA's NemoGuard models — free, and therefore in the pool a router draws
 * from — emit exactly this: a `User Safety` verdict, sometimes as JSON,
 * sometimes as the bare line `User Safety: safe`. It is not malformed output
 * and it is not a refusal; it is a different model doing a different job.
 * Naming it is what makes the failure diagnosable instead of looking like the
 * model "did not return JSON".
 */
const SAFETY_VERDICT_TEXT = /^\s*(user|response)\s*safety\s*:\s*(safe|unsafe)\b/i
const SAFETY_VERDICT_ONLY = /^\s*(safe|unsafe)\s*$/i

export function safetyVerdict(text: string): string | null {
  const t = text.trim()
  if (SAFETY_VERDICT_TEXT.test(t) || SAFETY_VERDICT_ONLY.test(t)) {
    return t.slice(0, 80)
  }
  return null
}

/** The same verdict, when the classifier emitted it as the JSON it was built to emit. */
function safetyVerdictObject(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value as object)
  const hit = keys.find((k) => /^(user|response)\s*safety$/i.test(k.trim()))
  if (!hit) return null
  return `${hit}: ${String((value as Record<string, unknown>)[hit]).slice(0, 40)}`
}

/** Thrown when the answer came from a model that cannot do this job at all. */
export function wrongKindOfModel(detail: string): InvalidModelOutput {
  return new InvalidModelOutput(
    `the provider returned a content-safety verdict (${JSON.stringify(detail)}), not a decision — ` +
      'the model that answered is a safety classifier, not a chat model',
  )
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
    throw new InvalidModelOutput('the model returned no choices')
  }

  const choice = choices[0] as Record<string, unknown>
  const finish = choice.finish_reason ?? choice.native_finish_reason
  if (finish === 'length') {
    // Valid-looking JSON cut off mid-object. Reported as what it is rather
    // than as an upstream fault, because the request did succeed.
    throw new InvalidModelOutput('the model stopped early (hit the token cap)')
  }
  if (finish === 'content_filter') {
    throw new ProviderError('model refused the request (content_filter)', 'bad_request')
  }

  const message = (choice.message ?? {}) as Record<string, unknown>
  const content = message.content

  if (typeof content === 'string' && content.trim()) {
    const parsed = safeParse(content)
    const verdict = safetyVerdictObject(parsed)
    if (verdict) throw wrongKindOfModel(verdict)
    return parsed
  }

  // Some models answer with content parts rather than a single string.
  if (Array.isArray(content)) {
    for (const part of content) {
      const p = part as Record<string, unknown>
      if (typeof p?.text === 'string' && p.text.trim()) return safeParse(p.text)
    }
  }

  // A rare gateway shape: the object already parsed.
  if (content && typeof content === 'object') {
    const verdict = safetyVerdictObject(content)
    if (verdict) throw wrongKindOfModel(verdict)
    return content
  }

  throw new InvalidModelOutput('the model returned an empty message')
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

  // Before calling it malformed: a safety classifier answering is a different
  // fault with a different fix, and saying so is the difference between
  // "the model did not return JSON" and "the wrong model answered".
  const verdict = safetyVerdict(trimmed)
  if (verdict) throw wrongKindOfModel(verdict)

  // A refusal, or prose with no JSON in it at all.
  throw new InvalidModelOutput(
    `the model did not return JSON (${trimmed.length} chars, starts "${trimmed.slice(0, 40)}")`,
  )
}
