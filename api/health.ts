/**
 * Deployment diagnostics. Deliberately imports nothing.
 *
 * If /api/health answers and /api/decision does not, the problem is the
 * decision function's module graph, not routing or the platform.
 *
 * `?probe=1` additionally asks the provider two questions — is this key
 * accepted, and does this account have credit — and reports the answers as
 * classifications. It never reports the key.
 */

/* Provider selection is duplicated here rather than imported: this file stays
   dependency-free so that, if it answers and /api/decision does not, the fault
   is the decision function's module graph and nothing else. */
function providerName(): 'openrouter' | 'openai' | 'gemini' {
  const explicit = (process.env.LOCK_PROVIDER ?? '').trim().toLowerCase()
  if (explicit === 'openai' || explicit === 'gemini' || explicit === 'openrouter') return explicit
  // No key sniffing. Selecting by "whichever key is present" is what made a
  // missing OpenRouter key read as a missing OpenAI key, and described the
  // wrong variable to the person trying to fix it.
  return 'openrouter'
}

const PROVIDER = providerName()
const IS_GEMINI = PROVIDER === 'gemini'
const IS_ROUTER = PROVIDER === 'openrouter'

const KEY_VAR = IS_GEMINI
  ? 'GEMINI_API_KEY'
  : IS_ROUTER
    ? 'OPENROUTER_API_KEY'
    : 'OPENAI_API_KEY'
const OPENAI = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
const GEMINI = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta')
  .replace(/\/+$/, '')
const ROUTER = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1')
  .replace(/\/+$/, '')
/* Kept in step with server/ai/openrouter.ts and server/ai/factory.ts by the
   tests in test/openrouter.test.ts, which read both and compare. */
/* Mirrors PREFERRED_MODELS in server/ai/openrouter.ts. Kept in step by a test
   that reads both files and compares. */
const ROUTER_CANDIDATES = [
  'google/gemma-4-31b-it:free',
  'z-ai/glm-5.2:free',
  'google/gemma-4-26b-a4b-it:free',
  'minimax/minimax-m2.7:free',
  'minimax/minimax-m3:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
]

function routerModels(): string[] {
  const pinned = (process.env.LOCK_MODEL ?? '').trim()
  const fallback = (process.env.LOCK_MODEL_FALLBACK ?? '').trim()
  if (pinned) return fallback && fallback !== pinned ? [pinned, fallback] : [pinned]
  return fallback
    ? [fallback, ...ROUTER_CANDIDATES.filter((m) => m !== fallback)]
    : [...ROUTER_CANDIDATES]
}

const MODEL = IS_GEMINI
  ? process.env.GEMINI_MODEL || 'gemini-2.5-flash'
  : IS_ROUTER
    ? routerModels()[0]
    : process.env.OPENAI_MODEL || 'gpt-4.1'

/* Duplicated from gemini.ts on purpose: this file imports nothing, so that if
   it answers and /api/decision does not, the fault is the decision function's
   module graph and nothing else. Google validates `AQ.` auth keys as bearer
   tokens and `AIza` standard keys as API keys. */
function geminiAuth(key: string): Record<string, string> {
  const forced = (process.env.GEMINI_AUTH_MODE ?? '').trim().toLowerCase()
  const bearer = forced === 'bearer' || (forced !== 'api-key' && key.startsWith('AQ.'))
  return bearer ? { authorization: `Bearer ${key}` } : { 'x-goog-api-key': key }
}

/** Everything about a credential except the credential. */
function describeKey(raw: string) {
  const trimmed = raw.trim()
  return {
    present: raw.length > 0,
    length: raw.length,
    prefix: raw ? raw.slice(0, 3) : null,
    hasWhitespace: raw !== trimmed,
    // AQ. auth keys are bearer tokens; AIza standard keys are API keys.
    kind: trimmed.startsWith('sk-or-')
      ? 'openrouter-key'
      : trimmed.startsWith('AQ.')
        ? 'google-auth-key'
        : trimmed.startsWith('AIza')
          ? 'google-standard-key'
          : trimmed.startsWith('sk-')
            ? 'openai-key'
            : trimmed
              ? 'unrecognised'
              : null,
  }
}

/** Nothing key-shaped may travel back in a message. */
function scrub(text: string): string {
  return text
    .replace(/sk-or-v[0-9]-[A-Za-z0-9_\-]{8,}/g, 'sk-or-***')
    .replace(/AQ\.[A-Za-z0-9_.\-]{8,}/g, 'AQ.***')
    .replace(/AIza[A-Za-z0-9_\-]{8,}/g, 'AIza***')
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-***')
    .slice(0, 300)
}

type Probe = {
  keyAccepted: boolean | null
  modelAvailable: boolean | null
  canGenerate: boolean | null
  /** One of: ok, auth, quota, rate_limited, model_unavailable, upstream, unreachable. */
  verdict: string
  /** The provider's own error code, never its message verbatim. */
  providerCode: string | null
  advice: string | null
  /** Where to go and fix it, when there is such a place. */
  link: string | null
  /** Models this key can actually use, when the provider will say. */
  models?: string[]
  /** The model the deployment is configured to send. */
  selectedModel?: string
  /** Every model this deployment will try, in order. */
  modelsConfigured?: string[]
  /** Which model actually answered the probe's generation. */
  answeredBy?: string | null
  /** Whether the catalogue says this model accepts the response_format we send. */
  supportsResponseFormat?: boolean | null
  /** Which form of response_format this deployment sends to this model. */
  responseFormat?: string
  /** The only check that means "a real journey will work": a validated turn. */
  returnsValidLockJson?: boolean | null
  /** Why the contract check failed, when it did. */
  contractError?: string | null
  /** Where the model choice came from: a pin, the catalogue, or the built-in order. */
  resolvedFrom?: string
  /** Whether the verdict engine produced a schema-valid Lock decision object. */
  verdictOk?: boolean | null
  /** The verdict it produced, so a real generation is visible rather than claimed. */
  verdictSample?: { verdict: string; action: string; confidence: number } | null
  /** Why the verdict check failed, when it did. */
  verdictError?: string | null
  /** The provider's own words on the failing call, scrubbed. */
  upstream?: { status: number; code: string | null; message: string; url: string } | null
  /** Which credential transport was used. */
  authMode?: string
  /**
   * Every combination of transport and API version, with what each returned.
   * One run of this settles which the credential actually works with.
   */
  matrix?: Array<{ auth: string; version: string; status: number; code: string | null; message: string }>
}

/** Free: proves whether the key is accepted at all, and whether the model exists. */
async function checkKey(key: string): Promise<Partial<Probe>> {
  try {
    const res = await fetch(`${OPENAI}/models/${encodeURIComponent(MODEL)}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) return { keyAccepted: true, modelAvailable: true }

    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; type?: string } }
    const code = body.error?.code ?? body.error?.type ?? null
    if (res.status === 401 || res.status === 403) {
      return {
        keyAccepted: false, modelAvailable: null, verdict: 'auth', providerCode: code,
        advice: 'The key was rejected. Check it was pasted whole, then redeploy.',
        link: 'https://platform.openai.com/api-keys',
      }
    }
    if (res.status === 404) {
      return {
        keyAccepted: true, modelAvailable: false, verdict: 'model_unavailable', providerCode: code,
        advice: `This account cannot use "${MODEL}". Set LOCK_MODEL to one it can.`,
      }
    }
    return { keyAccepted: true, modelAvailable: null, verdict: 'upstream', providerCode: code }
  } catch {
    return { verdict: 'unreachable', advice: 'Could not reach the provider from this function.' }
  }
}

/**
 * Gemini's free tier makes the model list worth reporting: model availability
 * changes, so rather than trusting a hardcoded default this asks the key what
 * it can actually use.
 */
async function checkGeminiKey(key: string): Promise<Partial<Probe>> {
  try {
    const res = await fetch(`${GEMINI}/models`, {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { status?: string } }
      const code = body.error?.status ?? null
      if (res.status === 401 || res.status === 403) {
        return {
          keyAccepted: false, verdict: 'auth', providerCode: code,
          advice: 'Google rejected the key. Check it was pasted whole, then redeploy.',
          link: 'https://aistudio.google.com/apikey',
        }
      }
      return { keyAccepted: true, verdict: 'upstream', providerCode: code }
    }

    const data = (await res.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>
    }
    const usable = (data.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => (m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean)

    if (usable.length && !usable.includes(MODEL)) {
      return {
        keyAccepted: true, modelAvailable: false, verdict: 'model_unavailable',
        models: usable.slice(0, 40),
        advice: `This key cannot use "${MODEL}". Set GEMINI_MODEL to one of the models listed below.`,
      }
    }
    return { keyAccepted: true, modelAvailable: true, models: usable.slice(0, 40) }
  } catch {
    return { verdict: 'unreachable', advice: 'Could not reach Google from this function.' }
  }
}

/** One tiny generation: the only way to tell a spent quota from a working key. */
async function checkGeminiQuota(key: string): Promise<Partial<Probe>> {
  const url = `${GEMINI}/models/${encodeURIComponent(MODEL)}:generateContent`
  const authMode = 'authorization' in geminiAuth(key) ? 'bearer' : 'api-key'
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...geminiAuth(key), 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 8 },
      }),
      signal: AbortSignal.timeout(15000),
    })
    if (res.ok) return { canGenerate: true, verdict: 'ok', advice: null, authMode, upstream: null }

    const body = (await res.json().catch(() => ({}))) as {
      error?: { status?: string; message?: string }
    }
    const code = body.error?.status ?? null
    const message = body.error?.message ?? ''
    const upstream = {
      status: res.status, code, message: scrub(message),
      url: url.replace(/^https?:\/\/[^/]+/, ''),
    }

    if (res.status === 404 || code === 'NOT_FOUND') {
      return {
        canGenerate: false, verdict: 'model_unavailable', providerCode: code, authMode, upstream,
        advice: `Google authenticated the request and then could not resolve "${MODEL}" for generateContent. The matrix below shows which transport and API version this credential does work with.`,
      }
    }
    if (res.status === 401 || code === 'UNAUTHENTICATED') {
      return {
        canGenerate: false, verdict: 'auth', providerCode: code, authMode, upstream,
        advice: 'The credential was refused for generation. If it starts with AQ. it is an auth key and must travel as a bearer token; set GEMINI_AUTH_MODE=bearer to force that.',
      }
    }
    if (res.status === 429) {
      const daily = /per day|daily|quota metric/i.test(message)
      return {
        canGenerate: false, verdict: daily ? 'quota' : 'rate_limited', providerCode: code,
        authMode, upstream,
        advice: daily
          ? 'The free tier\u2019s daily request allowance is spent. It resets on Google\u2019s schedule; no payment is required.'
          : 'A per-minute limit. This one clears on its own within a minute.',
      }
    }
    return { canGenerate: false, verdict: 'upstream', providerCode: code, authMode, upstream }
  } catch {
    return { canGenerate: false, verdict: 'unreachable', authMode }
  }
}

/**
 * Tries every transport against every API version and reports what each said.
 * Cheap, bounded, and it turns "which combination does this credential want"
 * from a guess into one line of output.
 */
async function geminiMatrix(key: string): Promise<Probe['matrix']> {
  const host = GEMINI.replace(/\/v1beta$|\/v1$/, '')
  const combos: Array<{ auth: string; headers: Record<string, string> }> = [
    { auth: 'bearer', headers: { authorization: `Bearer ${key}` } },
    { auth: 'api-key', headers: { 'x-goog-api-key': key } },
  ]
  const versions = ['v1beta', 'v1']
  const out: NonNullable<Probe['matrix']> = []

  for (const { auth, headers } of combos) {
    for (const version of versions) {
      try {
        const res = await fetch(
          `${host}/${version}/models/${encodeURIComponent(MODEL)}:generateContent`,
          {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
              generationConfig: { maxOutputTokens: 8 },
            }),
            signal: AbortSignal.timeout(12000),
          },
        )
        if (res.ok) {
          out.push({ auth, version, status: res.status, code: 'OK', message: '' })
          continue
        }
        const b = (await res.json().catch(() => ({}))) as {
          error?: { status?: string; message?: string }
        }
        out.push({
          auth, version, status: res.status,
          code: b.error?.status ?? null,
          message: scrub(b.error?.message ?? ''),
        })
      } catch {
        out.push({ auth, version, status: 0, code: 'unreachable', message: '' })
      }
    }
  }
  return out
}

/** Costs a few tokens: the only way to tell an empty account from a working one. */
async function checkQuota(key: string): Promise<Partial<Probe>> {
  try {
    const res = await fetch(`${OPENAI}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: 'ping', max_output_tokens: 16 }),
      signal: AbortSignal.timeout(15000),
    })
    if (res.ok) return { canGenerate: true, verdict: 'ok', advice: null }

    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; type?: string; message?: string }
    }
    const code = body.error?.code ?? body.error?.type ?? null
    const message = body.error?.message ?? ''
    const quota =
      code === 'insufficient_quota' ||
      code === 'billing_hard_limit_reached' ||
      /quota|billing|credit|payment/i.test(message)

    if (res.status === 429 && quota) {
      return {
        canGenerate: false, verdict: 'quota', providerCode: code,
        advice:
          'The key is valid but the account has no credit. Add a payment method and credit, then try again. A project key can also carry its own spend limit, separate from the organisation.',
        link: 'https://platform.openai.com/settings/organization/billing/overview',
      }
    }
    if (res.status === 429) {
      return {
        canGenerate: false, verdict: 'rate_limited', providerCode: code,
        advice: 'A real rate limit. This one does clear on its own.',
      }
    }
    return { canGenerate: false, verdict: 'upstream', providerCode: code }
  } catch {
    return { canGenerate: false, verdict: 'unreachable' }
  }
}

/* ---- OpenRouter ---------------------------------------------------- */

/* Mirrors MODEL_FORMAT in server/ai/openrouter.ts; a test reads both and
   compares, so they cannot drift apart unnoticed. */
const ROUTER_FORMATS: Record<string, string> = {
  'google/gemma-4-31b-it:free': 'json_object',
  'google/gemma-4-26b-a4b-it:free': 'json_object',
  'z-ai/glm-5.2:free': 'json_schema',
}

function routerFormat(model: string): string {
  const forced = (process.env.LOCK_MODEL_FORMAT ?? '').trim().toLowerCase()
  if (forced === 'json_schema' || forced === 'json_object' || forced === 'none') return forced
  return ROUTER_FORMATS[model] ?? 'json_object'
}

/**
 * Free, and it costs no tokens: OpenRouter answers this with the key's own
 * metadata. It settles "is this key accepted" before anything is spent.
 *
 * A status other than 200 or 401 is treated as inconclusive rather than as a
 * verdict — the generation call below is the authority, and reporting "key
 * rejected" off a gateway hiccup would send someone to regenerate a key that
 * was fine.
 */
async function checkRouterKey(key: string): Promise<Partial<Probe>> {
  try {
    const res = await fetch(`${ROUTER}/key`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) return { keyAccepted: true }
    if (res.status === 401 || res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
      return {
        keyAccepted: false,
        verdict: 'auth',
        providerCode: 'unauthorized',
        advice: `OpenRouter rejected the key. Check ${KEY_VAR} was pasted whole, with no trailing space, then redeploy — environment variables only apply to deployments made after they were added.`,
        link: 'https://openrouter.ai/settings/keys',
        upstream: {
          status: res.status,
          code: 'unauthorized',
          message: scrub(body.error?.message ?? ''),
          url: '/key',
        },
      }
    }
    return {}
  } catch {
    return { verdict: 'unreachable', advice: 'Could not reach OpenRouter from this function.' }
  }
}

/**
 * Free, and it costs no tokens: the catalogue settles which models this key
 * can actually see, and which of them accept a response_format at all.
 *
 * The probe resolves exactly the way the provider does — same ranking, same
 * catalogue — so what it reports is what a real turn will use. Reporting a
 * statically-guessed model here is how the last two outages stayed invisible.
 */
async function resolveFromCatalogue(key: string): Promise<{
  models: Array<{ model: string; format: string }>
  free: string[]
  known: boolean
}> {
  try {
    const res = await fetch(`${ROUTER}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { models: [], free: [], known: false }
    const { chooseModels, readCatalogue } = await import('../server/ai/openrouter.js')
    const entries = readCatalogue(await res.json())
    if (!entries.length) return { models: [], free: [], known: false }
    return {
      models: chooseModels(entries) as Array<{ model: string; format: string }>,
      free: entries.filter((e) => e.free).map((e) => e.id).sort().slice(0, 60),
      known: true,
    }
  } catch {
    return { models: [], free: [], known: false }
  }
}

/**
 * The only check that answers the question that matters.
 *
 * `canGenerate: true` used to mean a one-token "ping" came back, which a
 * content-safety classifier answers just as happily as a chat model — which is
 * exactly how a probe reporting all-green sat above a production journey that
 * could never work. This sends the real contract and runs the real validator,
 * so a green probe means a real turn parses.
 */
async function checkRouterContract(
  key: string,
  model: string,
  format: string,
): Promise<Partial<Probe>> {
  const url = `${ROUTER}/chat/completions`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'X-Title': process.env.LOCK_SITE_NAME || 'Lock',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You produce a single JSON object and nothing else. No prose, no fences, no commentary.',
          },
          {
            role: 'user',
            content:
              'Return this exact JSON object and nothing else: {"understanding":{"objective":"probe","known":[],"openQuestions":[],"criticalUnknown":null,"contradiction":null},"progress":0.1,"confidence":0.5,"title":"Probe","step":{"kind":"question","prompt":"Is this working?","why":"Confirms the contract.","options":[],"allowFree":true,"framing":null,"question":null,"commitment":null,"rationale":null,"isFinal":null,"importance":null,"closing":null}}',
          },
        ],
        max_tokens: 400,
        temperature: 0,
        ...(format === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(20000),
    })

    const text = await res.text()
    let parsed: any = {}
    try { parsed = JSON.parse(text) } catch { /* reported below */ }

    if (!res.ok || parsed.error) {
      const raw = parsed.error?.code
      const code = parsed.error?.type ?? (raw === undefined || raw === null ? null : String(raw))
      const message = parsed.error?.message ?? text.slice(0, 300)
      const status = res.ok ? Number(raw) || 502 : res.status
      const upstream = { status, code, message: scrub(message), url: '/chat/completions' }
      const base = { canGenerate: false, returnsValidLockJson: false, providerCode: code, upstream,
                     responseFormat: format }

      if (status === 401 || status === 403) {
        return { ...base, keyAccepted: false, verdict: 'auth',
          advice: `OpenRouter rejected the key. Check ${KEY_VAR} was pasted whole, then redeploy.`,
          link: 'https://openrouter.ai/settings/keys' }
      }
      if (status === 402) {
        return { ...base, keyAccepted: true, verdict: 'quota',
          advice: 'The key is valid but this model is not free for this account. Set LOCK_MODEL to one of the free models listed below.',
          link: 'https://openrouter.ai/settings/credits' }
      }
      if (status === 429) {
        const daily = /per day|daily|day\b/i.test(message)
        return { ...base, keyAccepted: true, verdict: daily ? 'quota' : 'rate_limited',
          advice: daily
            ? 'The free tier\u2019s daily request allowance is spent. It resets on OpenRouter\u2019s schedule; no payment is required.'
            : 'A per-minute limit. This one clears on its own within a minute.' }
      }
      if (status === 404 || /no endpoints found|not a valid model|no allowed providers/i.test(message)) {
        return { ...base, keyAccepted: true, modelAvailable: false, verdict: 'model_unavailable',
          advice: `This key cannot reach "${model}". Set LOCK_MODEL to one of the models listed below.` }
      }
      if (status === 400 || status === 422) {
        return { ...base, keyAccepted: true, verdict: 'bad_request',
          advice: `"${model}" refused the request itself — most often the response_format. Set LOCK_MODEL_FORMAT to json_object or none, or pick another model.` }
      }
      return { ...base, keyAccepted: true, verdict: 'upstream' }
    }

    /* It generated. Now the part that actually matters: does what it wrote
       survive the same extractor and validator a real turn goes through? */
    const answeredBy = typeof parsed.model === 'string' ? parsed.model : null
    const generated = { keyAccepted: true, modelAvailable: true, canGenerate: true,
                        answeredBy, responseFormat: format }
    try {
      const { extractOpenRouterJson } = await import('../server/ai/openrouter.js')
      const { parseTurn } = await import('../server/ai/schema.js')
      const turn = parseTurn(extractOpenRouterJson(parsed), 0.1)
      if (!turn?.step?.kind) throw new Error('no step')
      return { ...generated, returnsValidLockJson: true, verdict: 'ok', advice: null, upstream: null,
               contractError: null }
    } catch (err) {
      const why = err instanceof Error ? scrub(err.message) : String(err)
      return {
        ...generated, returnsValidLockJson: false, verdict: 'invalid_response',
        contractError: why,
        advice: `"${model}" answered, but not with a turn Lock can use: ${why}. A real journey will fail the same way. Set LOCK_MODEL to one of the free models listed below.`,
      }
    }
  } catch {
    return { canGenerate: false, verdict: 'unreachable', responseFormat: format,
      advice: 'Could not reach OpenRouter from this function.' }
  }
}

/**
 * The free slugs this key can choose from. Public, free, and only fetched when
 * something already went wrong — at that point the list is the fix.
 */
async function routerFreeModels(key: string): Promise<string[]> {
  try {
    const res = await fetch(`${ROUTER}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return []
    const data = (await res.json()) as {
      data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }>
    }
    return (data.data ?? [])
      .filter((m) => Number(m.pricing?.prompt ?? 1) === 0 && Number(m.pricing?.completion ?? 1) === 0)
      .map((m) => m.id ?? '')
      .filter(Boolean)
      .sort()
      .slice(0, 40)
  } catch {
    return []
  }
}

/**
 * One real verdict, through the real engine.
 *
 * The turn check above proves Lock can produce a journey step. This proves the
 * decision engine ported from lock-ai-logic can produce a valid Lock decision
 * object — a different prompt and a different schema, so passing one says
 * nothing about the other. Same cost discipline: one generation, only under
 * ?probe=1, and only once the credential has already checked out.
 */
async function checkVerdict(): Promise<Partial<Probe>> {
  try {
    const { runVerdict } = await import('../server/verdict.js')
    const result = await runVerdict({
      journey: { id: 'diagnostic', state: 'diagnostic_check', decision: 'Health check turn.' },
      history: [{ role: 'lock', content: 'Diagnostic: confirm the decision engine responds.' }],
      answer: 'Yes, proceed with the diagnostic check.',
    })
    if (result.status === 200 && 'verdict' in result.body) {
      const d = result.body
      return {
        verdictOk: true,
        verdictSample: { verdict: d.verdict, action: d.action, confidence: d.confidence },
        verdictError: null,
      }
    }
    const err = (result.body as { error?: { code?: string; message?: string } }).error
    return {
      verdictOk: false,
      verdictSample: null,
      verdictError: scrub(`${err?.code ?? 'unknown'}: ${err?.message ?? ''}`),
    }
  } catch (err) {
    return {
      verdictOk: false,
      verdictSample: null,
      verdictError: scrub(err instanceof Error ? err.message : String(err)),
    }
  }
}

/** A readable page for a browser. No CSS file, no imports — one self-contained view. */
function renderHtml(body: any): string {
  const verdict: string | null = body.probe?.verdict ?? null
  const good = verdict === 'ok'
  const tone = verdict === null ? '#8E9196' : good ? '#7FD1AE' : '#E0C08A'

  const row = (label: string, value: unknown) =>
    `<div class="r"><span>${label}</span><b>${
      value === null || value === undefined ? '—' : String(value)
    }</b></div>`

  const probeRows = body.probe
    ? [
        row('Provider', body.provider),
        row('Selected model', body.probe.selectedModel ?? body.model),
        row('Key accepted', body.probe.keyAccepted),
        row('Model available', body.probe.modelAvailable),
        row('Accepts response_format', body.probe.supportsResponseFormat),
        row('Response format sent', body.probe.responseFormat),
        row('Can generate', body.probe.canGenerate),
        row('Returns valid Lock JSON', body.probe.returnsValidLockJson),
        row('Verdict engine', body.probe.verdictOk),
        row(
          'Verdict sample',
          body.probe.verdictSample
            ? `${body.probe.verdictSample.verdict} / ${body.probe.verdictSample.action}`
            : null,
        ),
        row('Answered by', body.probe.answeredBy),
        row('Fallback model', (body.probe.modelsConfigured ?? [])[1] ?? null),
        row('Chosen from', body.probe.resolvedFrom),
        row('Provider code', body.probe.providerCode),
      ].join('')
    : `<p class="hint">Add <code>?probe=1</code> to test the key against the provider.</p>`

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark"><title>Lock — diagnostic</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#08090b;color:#f1f2f4;
 font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;
 letter-spacing:-.011em;padding:calc(env(safe-area-inset-top) + 32px) 22px
 calc(env(safe-area-inset-bottom) + 40px)}
main{max-width:520px;margin:0 auto}
h1{font-size:13px;font-weight:600;letter-spacing:.02em;color:#676b71;margin:0 0 22px}
.v{font-size:27px;font-weight:600;letter-spacing:-.03em;margin:0 0 8px;color:${tone}}
.advice{color:#9ea2a8;margin:0 0 18px;font-size:15.5px;text-wrap:pretty;overflow-wrap:anywhere}
.fix{margin:0 0 28px}
.fix a{display:inline-block;color:#0a0b0d;background:#f1f2f4;text-decoration:none;
 font-size:14.5px;font-weight:600;padding:11px 18px;border-radius:12px}
.r{display:flex;justify-content:space-between;gap:16px;padding:12px 0;
 border-top:1px solid rgba(255,255,255,.075);font-size:14.5px}
.r span{color:#8e9196}
.r b{font-weight:500;font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}
h2{font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;
 color:#494d53;margin:30px 0 4px}
.hint{color:#676b71;font-size:14px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#e0c08a}
a{color:#9ea2a8}
</style></head><body><main>
<h1>Lock — deployment diagnostic</h1>
<p class="v">${verdict ? verdict.replace(/_/g, ' ') : 'not probed'}</p>
${body.probe?.advice ? `<p class="advice">${body.probe.advice}</p>` : ''}
${body.probe?.link ? `<p class="fix"><a href="${body.probe.link}" target="_blank" rel="noreferrer">Open the page that fixes this</a></p>` : ''}
<h2>Provider</h2>${probeRows}
${
  body.probe?.upstream
    ? `<h2>What ${
        body.provider === 'gemini' ? 'Google' : body.provider === 'openrouter' ? 'OpenRouter' : 'OpenAI'
      } said</h2>${row('HTTP', body.probe.upstream.status)}${row(
        'Code', body.probe.upstream.code,
      )}${row('Path', body.probe.upstream.url)}<p class="hint">${
        body.probe.upstream.message || '(no message)'
      }</p>`
    : ''
}
${
  body.probe?.matrix?.length
    ? `<h2>Transport × API version</h2>${body.probe.matrix
        .map((m: any) =>
          row(`${m.auth} · ${m.version}`, `${m.status} ${m.code ?? ''}`.trim()),
        )
        .join('')}`
    : ''
}
${
  body.probe?.verdictError
    ? `<h2>Why the verdict failed</h2><p class="hint">${body.probe.verdictError}</p>`
    : ''
}
${
  body.probe?.contractError
    ? `<h2>Why the turn was rejected</h2><p class="hint">${body.probe.contractError}</p>`
    : ''
}
${
  body.probe?.models?.length
    ? `<h2>Models this key can use</h2><p class="hint">${body.probe.models.join(', ')}</p>`
    : ''
}
<h2>Credentials</h2>
${['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY']
  .map((name) => {
    const c = body.credentials[name]
    return c.present
      ? `${row(name, `${c.kind ?? 'unrecognised'} · ${c.length} chars · ${c.prefix}…`)}${
          c.hasWhitespace ? row(`${name} whitespace`, 'YES — trim it') : ''
        }`
      : row(name, 'not set')
  })
  .join('')}

<h2>Variables this function can see</h2>
${
  body.configVars.length
    ? body.configVars
        .map((v: any) => row(v.name, v.set ? 'set' : 'present but empty'))
        .join('')
    : '<p class="hint">None. No OPENROUTER_, GEMINI_, GOOGLE_, OPENAI_ or LOCK_ variable reached this deployment — environment variables only apply to deployments made after they were added.</p>'
}
<h2>Deployment</h2>
${row('Provider', body.provider)}
${body.probe?.authMode ? row('Auth transport', body.probe.authMode) : ''}
${row('Model', body.model)}
${row('Environment', body.env)}
${row('Commit', body.commit)}
${row('Region', body.region)}
${row('Node', body.node)}
<h2></h2>
<p class="hint">The key itself is never shown or returned.
 <a href="?probe=1&amp;format=json">Raw JSON</a></p>
</main></body></html>`
}

export default async function handler(req: any, b?: any) {
  const rawKey = process.env[KEY_VAR] ?? ''
  const key = rawKey.trim()

  /* Reporting only the selected provider's key made a missing Gemini key look
     like a missing OpenAI key: with no GEMINI_API_KEY the selection falls back
     to openai, and the row then described the wrong variable entirely. */
  const credentials = {
    OPENROUTER_API_KEY: describeKey(process.env.OPENROUTER_API_KEY ?? ''),
    GEMINI_API_KEY: describeKey(process.env.GEMINI_API_KEY ?? ''),
    OPENAI_API_KEY: describeKey(process.env.OPENAI_API_KEY ?? ''),
  }

  /* Names only, never values. This is what distinguishes "the variable is not
     set" from "it is set under a different name" or "set but empty". */
  const configVars = Object.keys(process.env)
    .filter((n) => /^(OPENROUTER|GEMINI|GOOGLE|OPENAI|LOCK)_/i.test(n))
    .sort()
    .map((n) => ({ name: n, set: (process.env[n] ?? '').trim().length > 0 }))

  const url = new URL(req?.url ?? '/', 'http://localhost')

  /* Any form of the flag counts, and the /probe path counts on its own — a
     rewrite that does not carry its query through would otherwise silently
     downgrade the request to the cheap check. */
  const flag = url.searchParams.get('probe')
  const wantsProbe =
    flag !== null
      ? flag !== '0' && flag.toLowerCase() !== 'false'
      : /(^|\/)probe\/?$/.test(url.pathname)

  let probe: Probe | null = null
  if (wantsProbe && !key) {
    // Say so, rather than rendering "not probed" as though the flag was missing.
    probe = {
      keyAccepted: null, modelAvailable: null, canGenerate: null,
      verdict: 'no_credential', providerCode: null, link: null,
      selectedModel: MODEL,
      authMode: IS_GEMINI ? 'bearer' : undefined,
      advice: `${KEY_VAR} is not configured. No value for it reached this function. Environment variables only apply to deployments made after they were added, so add it in the project's settings and redeploy. The variables this function can see are listed below.`,
    }
  } else if (wantsProbe && key && IS_ROUTER) {
    /* Two calls at most, and only the second costs anything: one token.
       If the free key check already settled that the key is refused, the
       generation call is skipped rather than sent to be refused again. */
    /* Three checks, and only the last one costs anything:
         1. the key, from its own metadata      — free
         2. the model, from the catalogue       — free, and it answers
            "does this model even accept our response_format"
         3. one real LOCK turn, validated       — one small generation
       Each is skipped once an earlier one has settled the verdict, so a
       rejected key never pays for a generation it cannot make. */
    const credential = await checkRouterKey(key)
    const resolved = credential.keyAccepted === false
      ? { models: [], free: [] as string[], known: false }
      : await resolveFromCatalogue(key)

    /* Whatever the catalogue said, a pin always wins — same rule as the
       provider. With no pin and no readable catalogue, the static preference
       order is used, and the probe says so. */
    const pinned = (process.env.LOCK_MODEL ?? '').trim()
    const chain = pinned || !resolved.models.length
      ? routerModels().map((m) => ({ model: m, format: routerFormat(m) }))
      : resolved.models
    const model = chain[0]?.model ?? MODEL

    const capability: Partial<Probe> =
      credential.keyAccepted === false
        ? {}
        : resolved.known && !resolved.free.includes(model)
          ? {
              modelAvailable: false, verdict: 'model_unavailable', supportsResponseFormat: null,
              advice: `"${model}" is not among the free models this key can see. The ones it can are listed below — set LOCK_MODEL to one of them.`,
            }
          : { modelAvailable: resolved.known ? true : null,
              supportsResponseFormat: resolved.known ? chain[0]?.format !== 'none' : null }

    const contract =
      credential.keyAccepted === false || capability.modelAvailable === false
        ? {}
        : await checkRouterContract(key, model, chain[0]?.format ?? routerFormat(model))

    /* Only once a turn has actually validated: if the model cannot produce a
       journey step, it will not produce a verdict either, and the second
       generation would spend an allowance to learn nothing. */
    const verdict =
      (contract as Partial<Probe>).returnsValidLockJson === true ? await checkVerdict() : {}

    const merged = { ...credential, ...capability, ...contract, ...verdict }
    // The catalogue is free, but it is only the fix when something is broken.
    const models =
      merged.verdict && merged.verdict !== 'ok' && merged.keyAccepted !== false
        ? { models: resolved.free.length ? resolved.free : await routerFreeModels(key) }
        : {}
    probe = {
      keyAccepted: null, modelAvailable: null, canGenerate: null,
      verdict: 'unknown', providerCode: null, advice: null, link: null,
      selectedModel: model,
      modelsConfigured: chain.map((c) => c.model),
      responseFormat: chain[0]?.format ?? routerFormat(model),
      resolvedFrom: pinned ? 'LOCK_MODEL' : resolved.models.length ? 'the key\u2019s catalogue' : 'the built-in preference order',
      ...merged, ...models,
    }
  } else if (wantsProbe && key) {
    const first = IS_GEMINI ? await checkGeminiKey(key) : await checkKey(key)
    // Only ask about credit once the key and the model have both checked out.
    // Otherwise a passing credit check would overwrite the real verdict.
    const settled = first.keyAccepted === false || first.modelAvailable === false
    const second = settled ? {} : IS_GEMINI ? await checkGeminiQuota(key) : await checkQuota(key)
    // Only when Gemini generation actually failed — it costs four calls.
    const matrix =
      IS_GEMINI && second.canGenerate === false ? { matrix: await geminiMatrix(key) } : {}
    probe = {
      keyAccepted: null, modelAvailable: null, canGenerate: null,
      verdict: 'unknown', providerCode: null, advice: null, link: null,
      selectedModel: MODEL,
      ...first, ...second, ...matrix,
    }
  }

  const body = {
    ok: true,
    service: 'lock',
    // Whether a key reached the runtime at all. Environment variable changes
    // only apply to deployments made after the change.
    key: {
      present: rawKey.length > 0,
      length: rawKey.length,
      prefix: rawKey ? rawKey.slice(0, 3) : null,
      looksWellFormed: IS_GEMINI
        ? /^AIza[A-Za-z0-9_\-]{20,}$/.test(key)
        : IS_ROUTER
          ? /^sk-or-v[0-9]-[A-Za-z0-9_\-]{20,}$/.test(key)
          : /^sk-[A-Za-z0-9_\-]{20,}$/.test(key),
      hasWhitespace: rawKey !== rawKey.trim(),
    },
    provider: PROVIDER,
    providerKeyVariable: KEY_VAR,
    credentials,
    configVars,
    // The resolved model when the probe ran, the static first choice otherwise.
    // Reporting the guess next to a different resolved value is how a
    // diagnostic starts describing a deployment that does not exist.
    model: probe?.selectedModel ?? MODEL,
    baseUrlOverridden: Boolean(
      IS_GEMINI
        ? process.env.GEMINI_BASE_URL
        : IS_ROUTER
          ? process.env.OPENROUTER_BASE_URL
          : process.env.OPENAI_BASE_URL,
    ),
    probe,
    probeHint: wantsProbe ? null : 'add ?probe=1 to test the credential against the provider',
    node: process.version,
    region: process.env.VERCEL_REGION ?? null,
    env: process.env.VERCEL_ENV ?? 'local',
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    time: new Date().toISOString(),
  }

  // A browser gets a page it can read; anything else gets JSON. `?format=json`
  // forces JSON either way.
  const accept: string =
    (typeof req?.headers?.get === 'function' ? req.headers.get('accept') : req?.headers?.accept) ?? ''
  const wantsHtml =
    url.searchParams.get('format') !== 'json' && accept.includes('text/html')

  const text = wantsHtml ? renderHtml(body) : JSON.stringify(body, null, 2)
  const type = wantsHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'

  if (b && typeof b.setHeader === 'function') {
    b.statusCode = 200
    b.setHeader('content-type', type)
    b.setHeader('cache-control', 'no-store')
    b.end(text)
    return
  }
  return new Response(text, {
    status: 200,
    headers: { 'content-type': type, 'cache-control': 'no-store' },
  })
}
