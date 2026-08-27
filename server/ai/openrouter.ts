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
 * Free chat models worth Lock's turns, best first.
 *
 * This is a preference, not a bet. The catalogue a key can see differs between
 * accounts and changes over time — a hardcoded default already broke
 * production twice, once as a router that picked a content-safety classifier
 * and once as a slug the key could not see at all. So the list is ranked here
 * and *resolved against the key's own catalogue* at runtime.
 *
 * Ranked for what a decision turn actually needs: instruction-following over
 * raw capability, a short answer over a long one, and a general model rather
 * than a specialist.
 */
const PREFERRED_MODELS = [
  // Dense, instruction-tuned, general. Fast, and not reasoning-first — which
  // matters when every turn is one short interactive step.
  'google/gemma-4-31b-it:free',
  // Enforces a JSON schema server-side, so shape is guaranteed rather than
  // validated after the fact. Reasoning-heavy, hence second: excellent
  // insurance, poor default for a latency-sensitive turn.
  'z-ai/glm-5.2:free',
  // Same family as the first choice, fewer active parameters.
  'google/gemma-4-26b-a4b-it:free',
  'minimax/minimax-m2.7:free',
  'minimax/minimax-m3:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
]

/**
 * Models that answer a different question than the one Lock asks.
 *
 * A content-safety classifier is why this exists: it answered `User Safety:
 * safe` to a real journey, correctly, because that is its job. Coding,
 * embedding, audio and image models are the same mistake in other clothes.
 */
const UNSUITABLE = /(^|[/-])(code|coder|codestral|guard|safety|nemoguard|moderat|whisper|audio|tts|voice|embed|rerank|vision|ocr|image|diffusion|sd\d)/i

/** A router is never a model. Requirement, and the cause of the first outage. */
const IS_ROUTER = /^openrouter\//

export function isSuitableModel(id: string): boolean {
  return !IS_ROUTER.test(id) && !UNSUITABLE.test(id)
}

export type ResponseFormat = 'json_schema' | 'json_object' | 'none'

/**
 * What each model is known to accept, when the catalogue cannot say.
 *
 * The free tier of a model is not always the paid tier: Gemma 4 31B enforces
 * a JSON schema when paid and only promises valid JSON when free. Guessing
 * upward is a 400 on every request, so anything unknown gets the weaker form.
 */
const KNOWN_FORMAT: Record<string, ResponseFormat> = {
  'google/gemma-4-31b-it:free': 'json_object',
  'google/gemma-4-26b-a4b-it:free': 'json_object',
  'z-ai/glm-5.2:free': 'json_schema',
}

/** What the catalogue says a model accepts, read from `supported_parameters`. */
export function formatFromParameters(params: unknown): ResponseFormat | null {
  if (!Array.isArray(params)) return null
  if (params.includes('structured_outputs')) return 'json_schema'
  if (params.includes('response_format')) return 'json_object'
  return 'none'
}

export function formatFor(model: string, env: NodeJS.ProcessEnv = process.env): ResponseFormat {
  const forced = (env.LOCK_MODEL_FORMAT ?? '').trim().toLowerCase()
  if (forced === 'json_schema' || forced === 'json_object' || forced === 'none') return forced
  return KNOWN_FORMAT[model] ?? 'json_object'
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
  const ranked = PREFERRED_MODELS.filter(isSuitableModel)
  return fallback ? [fallback, ...ranked.filter((m) => m !== fallback)] : ranked
}

/* ---- resolving against the key's own catalogue ------------------------- */

export interface CatalogueEntry {
  id: string
  free: boolean
  format: ResponseFormat | null
}

/** One `/models` payload, reduced to what model choice depends on. */
export function readCatalogue(payload: unknown): CatalogueEntry[] {
  const data = (payload as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  return data
    .map((raw) => {
      const m = raw as { id?: unknown; pricing?: { prompt?: unknown; completion?: unknown }
                         supported_parameters?: unknown }
      if (typeof m?.id !== 'string' || !m.id) return null
      const free =
        Number(m.pricing?.prompt ?? 1) === 0 && Number(m.pricing?.completion ?? 1) === 0
      return { id: m.id, free, format: formatFromParameters(m.supported_parameters) }
    })
    .filter((e): e is CatalogueEntry => e !== null)
}

/**
 * Picks the model to use, given what this key can actually see.
 *
 * Preference order first. If none of the preferred models are in the
 * catalogue, any free general model that can be asked for JSON will do —
 * which is still a far better answer than failing with a slug nobody has.
 */
export function chooseModels(
  catalogue: CatalogueEntry[],
  env: NodeJS.ProcessEnv = process.env,
): Array<{ model: string; format: ResponseFormat }> {
  const usable = new Map(
    catalogue
      .filter((e) => e.free && isSuitableModel(e.id) && e.format !== 'none')
      .map((e) => [e.id, e] as const),
  )

  const withFormat = (id: string) => {
    const forced = (env.LOCK_MODEL_FORMAT ?? '').trim().toLowerCase()
    if (forced === 'json_schema' || forced === 'json_object' || forced === 'none') {
      return { model: id, format: forced as ResponseFormat }
    }
    // The catalogue is the authority; the table is only a fallback for a
    // catalogue that does not carry `supported_parameters`.
    return { model: id, format: usable.get(id)?.format ?? formatFor(id, env) }
  }

  const ranked = PREFERRED_MODELS.filter((id) => usable.has(id))
  const rest = [...usable.keys()].filter((id) => !PREFERRED_MODELS.includes(id)).sort()
  const order = [...ranked, ...rest]
  return order.slice(0, 2).map(withFormat)
}

/* One catalogue read per warm function instance, not per turn. */
const CATALOGUE_TTL_MS = 10 * 60_000
let cachedCatalogue: { at: number; entries: CatalogueEntry[] } | null = null

/** Exposed so tests do not inherit each other's cache. */
export function forgetCatalogue(): void {
  cachedCatalogue = null
}

async function catalogueFor(
  env: NodeJS.ProcessEnv,
  key: string,
  signal: AbortSignal,
): Promise<CatalogueEntry[]> {
  const now = Date.now()
  if (cachedCatalogue && now - cachedCatalogue.at < CATALOGUE_TTL_MS) return cachedCatalogue.entries
  try {
    const res = await fetch(`${openRouterBaseUrl(env)}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal,
    })
    if (!res.ok) return []
    const entries = readCatalogue(await res.json())
    if (entries.length) cachedCatalogue = { at: now, entries }
    return entries
  } catch {
    // A catalogue we cannot read is not a reason to fail the turn.
    return []
  }
}

/**
 * The models this turn will try, resolved against the live catalogue.
 *
 * Costs one free request per cold start, and nothing after that. A pinned
 * `LOCK_MODEL` skips it entirely, and so does a catalogue that cannot be read
 * — in both cases the static preference order is used.
 */
export async function resolveModels(
  env: NodeJS.ProcessEnv,
  key: string,
  signal: AbortSignal,
): Promise<Array<{ model: string; format: ResponseFormat }>> {
  const pinned = (env.LOCK_MODEL ?? '').trim()
  if (pinned) {
    return openRouterModels(env).map((m) => ({ model: m, format: formatFor(m, env) }))
  }
  const chosen = chooseModels(await catalogueFor(env, key, signal), env)
  if (chosen.length) return chosen
  return openRouterModels(env).map((m) => ({ model: m, format: formatFor(m, env) }))
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
export function responseFormatFor(
  format: ResponseFormat,
  contract: { name: string; schema: unknown } = { name: 'lock_turn', schema: TURN_JSON_SCHEMA },
): Record<string, unknown> {
  if (format === 'json_schema') {
    return {
      response_format: {
        type: 'json_schema',
        json_schema: { name: contract.name, strict: true, schema: contract.schema },
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
 * The test is the same one that makes the fallback safe at all: nothing was
 * generated, so trying another model cannot duplicate a user action or pay
 * twice for one answer.
 *
 *  - unusable output (a safety verdict, prose, a truncated object) — the
 *    request succeeded but produced nothing Lock can use;
 *  - the model was unreachable or refused the request shape;
 *  - a rate limit. On OpenRouter's free tier this is usually the upstream
 *    provider for one model rather than the key, and a 429 is refused before
 *    any generation — so the second model both might work and costs nothing
 *    to try. A key-wide limit simply fails again, bounded at one extra call.
 *
 * Deliberately excluded: an empty balance and a rejected key (identical
 * everywhere), a timeout and a cancellation (no budget left), and an upstream
 * 5xx — that one may mean the model *did* run, which is exactly the case where
 * a second attempt could bill twice.
 */
function anotherModelCouldHelp(err: unknown): boolean {
  if (err instanceof InvalidModelOutput) return true
  return (
    err instanceof ProviderError &&
    (err.kind === 'model_unavailable' ||
      err.kind === 'bad_request' ||
      err.kind === 'rate_limited')
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
  return async (req, signal) => {
    const key = (env.OPENROUTER_API_KEY ?? '').trim()
    if (!key) {
      throw new ProviderError('OPENROUTER_API_KEY is not configured', 'unconfigured')
    }

    const models = await resolveModels(env, key, signal)
    let last: unknown
    for (let i = 0; i < models.length; i++) {
      const { model, format } = models[i]
      const isLast = i === models.length - 1
      const call = (r: ProviderRequest, s: AbortSignal) => attempt(env, key, model, format, r, s)
      try {
        /* Waiting out a rate limit only makes sense when there is nothing else
           to try. With another model available, switching is both faster and
           more likely to work than sitting out the retry-after. */
        return await (isLast ? withRetry(call) : call)(req, signal)
      } catch (err) {
        last = err
        const more = i < models.length - 1
        if (!more || !anotherModelCouldHelp(err) || signal.aborted) throw err
        console.warn(
          `[lock] ${model} produced nothing usable (${
            err instanceof Error ? err.message.slice(0, 140) : String(err)
          }); trying ${models[i + 1].model}`,
        )
      }
    }
    throw last
  }
}

async function attempt(
  env: NodeJS.ProcessEnv,
  key: string,
  model: string,
  format: ResponseFormat,
  req: ProviderRequest,
  signal: AbortSignal,
): Promise<unknown> {
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
          { role: 'system', content: req.system ?? SYSTEM_PROMPT },
          { role: 'user', content: `${req.brief}\n\n${req.instruction}` },
        ],
        // Deliberately low: Lock should be consistent, not creative.
        temperature: 0.35,
        // The schema is large, and several of these models think before they
        // write — reasoning tokens are charged against this same budget. Too
        // low a cap truncates the JSON mid-object and the turn is discarded as
        // unparseable. Unused budget on a free model costs nothing.
        max_tokens: 4096,
        // Only ever the form this model actually supports. Asking a model
        // that cannot enforce a schema to enforce one is a 400.
        ...responseFormatFor(format, req.schema),
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
      `[lock] openrouter ok in ${Date.now() - started}ms · asked ${model} (${format}) · answered ${
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
