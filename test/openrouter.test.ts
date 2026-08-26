import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { build } from 'esbuild'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  classifyOpenRouterError,
  createOpenRouterProvider,
  extractOpenRouterJson,
  attributionHeaders,
  openRouterModel,
} from '../server/ai/openrouter.js'
import { ProviderError } from '../server/ai/provider.js'
import { InvalidModelOutput } from '../server/ai/schema.js'
import { createProvider, describeProvider, selectProviderName, modelFor } from '../server/ai/factory.js'
import { handleTurn } from '../server/handler.js'

/**
 * OpenRouter is what production talks to, so these tests run the artifact the
 * platform deploys against a stand-in gateway rather than asserting anything
 * about the source.
 *
 * The gateway itself is never reached from this test run — nothing here needs
 * the internet, and nothing here spends money.
 */

/** Shaped like a real one, and it must never appear in any output. */
const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd'

const TURN = {
  title: 'The Halden partnership',
  understanding: {
    objective: 'Decide whether the partnership is worth its terms',
    known: ['EUR 120k offered'], openQuestions: [],
    criticalUnknown: 'What exclusivity blocks', contradiction: null,
  },
  progress: 0.55, confidence: 0.7,
  step: {
    kind: 'decision', question: 'Should I pursue the partnership?',
    commitment: 'Pursue the partnership.', rationale: 'The risk sits in the terms.',
    isFinal: false, importance: 'pivotal', framing: 'The money is settled.',
    prompt: null, why: null, options: null, allowFree: null, closing: null,
  },
}

type Recorded = { method: string; url: string; headers: Record<string, string>; body: any }
type Reply = { status: number; body: unknown; headers?: Record<string, string> }

/** A stand-in OpenRouter. Records every request so the request shape is provable. */
function gateway(
  reply: (r: Recorded) => Reply = () => ({
    status: 200,
    body: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(TURN) } }] },
  }),
) {
  const seen: Recorded[] = []
  return new Promise<{ url: string; close: () => void; seen: Recorded[] }>((resolve) => {
    const s: Server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        let parsed: any = null
        try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
        const record: Recorded = {
          method: req.method ?? '', url: req.url ?? '',
          headers: req.headers as Record<string, string>, body: parsed,
        }
        seen.push(record)
        const out = reply(record)
        res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) })
        res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body))
      })
    })
    s.listen(0, () =>
      resolve({
        url: `http://127.0.0.1:${(s.address() as any).port}`,
        close: () => s.close(), seen,
      }),
    )
  })
}

async function bundled(entry: string, tag: string) {
  const dir = await mkdtemp(join(tmpdir(), 'lock-or-'))
  const outfile = join(dir, 'fn.mjs')
  await build({
    entryPoints: [entry], bundle: true, platform: 'node',
    format: 'esm', target: 'node20', outfile, logLevel: 'silent',
  })
  return import(`file://${outfile}?${tag}`)
}

function host(fn: any): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      Promise.resolve(fn(req, res)).catch(() => {
        if (!res.headersSent) res.writeHead(500).end('crashed')
      })
    })
    s.listen(0, () =>
      resolve({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close() }),
    )
  })
}

const START = { journey: null, event: { type: 'start' as const, input: 'Should I pursue this partnership?' } }

/** Runs a body with process.env set, and always puts it back. */
async function withEnv<T>(vars: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await body()
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const CLEAN = {
  OPENROUTER_API_KEY: undefined, OPENROUTER_BASE_URL: undefined,
  LOCK_PROVIDER: undefined, LOCK_MODEL: undefined,
  OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined,
  VERCEL_ENV: undefined, VERCEL_GIT_COMMIT_SHA: undefined, VERCEL_REGION: undefined,
}

/* ---- selection ------------------------------------------------------- */

test('OpenRouter is the provider, and nothing falls back to it or away from it', () => {
  const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv

  assert.equal(selectProviderName(env({})), 'openrouter')
  assert.equal(selectProviderName(env({ OPENROUTER_API_KEY: KEY })), 'openrouter')
  // The exact situation that broke the last deployment: keys for the old
  // providers still sitting in the environment must not steer the choice.
  assert.equal(selectProviderName(env({ OPENAI_API_KEY: 'sk-old' })), 'openrouter')
  assert.equal(selectProviderName(env({ GEMINI_API_KEY: 'AIzaOld' })), 'openrouter')
  assert.equal(
    selectProviderName(env({ OPENAI_API_KEY: 'sk-old', GEMINI_API_KEY: 'AIzaOld' })),
    'openrouter',
  )
  // And a missing OpenRouter key does not become someone else's turn either.
  assert.equal(selectProviderName(env({ OPENAI_API_KEY: 'sk-old' })), 'openrouter')

  const described = describeProvider(env({}))
  assert.equal(described.name, 'openrouter')
  assert.equal(described.keyVariable, 'OPENROUTER_API_KEY')
  assert.equal(described.model, 'openrouter/free')
})

test('the model is server-side, defaulted, and overridable through LOCK_MODEL', () => {
  const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv
  assert.equal(openRouterModel(env({})), 'openrouter/free')
  assert.equal(modelFor('openrouter', env({})), 'openrouter/free')
  assert.equal(openRouterModel(env({ LOCK_MODEL: 'meta-llama/llama-3.3-70b-instruct:free' })),
    'meta-llama/llama-3.3-70b-instruct:free')
  // Whitespace around a pasted value must not become part of the slug.
  assert.equal(openRouterModel(env({ LOCK_MODEL: '  qwen/qwen3-8b:free  ' })), 'qwen/qwen3-8b:free')
  // An empty variable is not a model name.
  assert.equal(openRouterModel(env({ LOCK_MODEL: '' })), 'openrouter/free')
  // LOCK_MODEL belongs to OpenRouter; OpenAI reads its own, so one name
  // cannot end up holding a slug meant for the other provider.
  assert.equal(modelFor('openai', env({ LOCK_MODEL: 'openrouter/free' })), 'gpt-4.1')
})

test('with no key, the failure names OPENROUTER_API_KEY and nothing else', async () => {
  const provider = createOpenRouterProvider({} as NodeJS.ProcessEnv)
  await assert.rejects(
    () => provider({ brief: 'b', instruction: 'i' }, new AbortController().signal),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError)
      assert.equal(err.kind, 'unconfigured')
      assert.equal(err.message, 'OPENROUTER_API_KEY is not configured')
      return true
    },
  )

  // And through the whole handler, as the client would see it.
  const res = await handleTurn(START, createProvider({} as NodeJS.ProcessEnv))
  assert.equal(res.status, 503)
  const body = res.body as any
  assert.equal(body.error.code, 'unconfigured')
  assert.match(body.error.detail, /OPENROUTER_API_KEY is not configured/)
  assert.equal(body.error.retryable, false)
})

/* ---- the request that is actually sent -------------------------------- */

test('one turn is one POST to chat/completions, carrying the key as a bearer token', async () => {
  const g = await gateway()
  try {
    const provider = createOpenRouterProvider({
      OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `${g.url}/api/v1`,
    } as NodeJS.ProcessEnv)
    const res = await handleTurn(START, provider)
    assert.equal(res.status, 200)
    assert.equal((res.body as any).step.decision.commitment, 'Pursue the partnership.')

    assert.equal(g.seen.length, 1, 'one user action must be exactly one provider request')
    const sent = g.seen[0]
    assert.equal(sent.method, 'POST')
    assert.equal(sent.url, '/api/v1/chat/completions')
    assert.equal(sent.headers.authorization, `Bearer ${KEY}`)
    assert.equal(sent.body.model, 'openrouter/free')
    assert.equal(sent.body.messages[0].role, 'system')
    assert.equal(sent.body.messages[1].role, 'user')
    // Asking for a schema is also what narrows the free router's pool to
    // models that can honour one.
    assert.equal(sent.body.response_format.type, 'json_schema')
    assert.equal(sent.body.response_format.json_schema.name, 'lock_turn')
    assert.equal(sent.body.response_format.json_schema.strict, true)
    assert.ok(sent.body.response_format.json_schema.schema.properties.step)
  } finally { g.close() }
})

test('LOCK_MODEL is what gets sent, and the browser never chooses it', async () => {
  const g = await gateway()
  try {
    const provider = createOpenRouterProvider({
      OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `${g.url}/api/v1`,
      LOCK_MODEL: 'qwen/qwen3-8b:free',
    } as NodeJS.ProcessEnv)
    await provider({ brief: 'b', instruction: 'i' }, new AbortController().signal)
    assert.equal(g.seen[0].body.model, 'qwen/qwen3-8b:free')
  } finally { g.close() }
})

test('attribution headers are sent when configured, and carry nothing private', () => {
  assert.deepEqual(attributionHeaders({} as NodeJS.ProcessEnv), { 'X-Title': 'Lock' })
  const h = attributionHeaders({ VERCEL_URL: 'lock.vercel.app' } as NodeJS.ProcessEnv)
  assert.equal(h['HTTP-Referer'], 'https://lock.vercel.app')
  const named = attributionHeaders({
    LOCK_SITE_URL: 'https://lock.example', LOCK_SITE_NAME: 'Lock',
  } as NodeJS.ProcessEnv)
  assert.equal(named['HTTP-Referer'], 'https://lock.example')
  assert.ok(!JSON.stringify(named).includes('sk-'))
})

/* ---- the error taxonomy ----------------------------------------------- */

const headers = (o: Record<string, string> = {}) => ({ get: (n: string) => o[n.toLowerCase()] ?? null })

test('every provider failure keeps its own identity', () => {
  const at = (status: number, error: unknown, h?: Record<string, string>) =>
    classifyOpenRouterError(status, JSON.stringify({ error }), headers(h))

  assert.equal(at(401, { code: 401, message: 'No auth credentials found' }).kind, 'auth')
  assert.equal(at(403, { code: 403, message: 'Forbidden' }).kind, 'auth')

  // OpenRouter has a dedicated status for an empty balance. Waiting never
  // fixes it, so it must never be reported as a rate limit.
  assert.equal(at(402, { code: 402, message: 'Insufficient credits' }).kind, 'quota')

  // A per-minute throttle does clear on its own.
  assert.equal(at(429, { code: 429, message: 'Rate limit exceeded' }).kind, 'rate_limited')
  // A spent daily free allowance does not.
  assert.equal(
    at(429, { code: 429, message: 'Rate limit exceeded: free-models-per-day' }).kind,
    'quota',
  )

  assert.equal(at(404, { code: 404, message: 'No endpoints found for x/y' }).kind, 'model_unavailable')
  // The same fault can arrive as a 400; the message is what identifies it.
  assert.equal(
    at(400, { code: 400, message: 'x/y is not a valid model ID' }).kind,
    'model_unavailable',
  )
  assert.equal(at(400, { code: 400, message: 'temperature must be a number' }).kind, 'bad_request')
  assert.equal(at(422, { code: 422, message: 'Unprocessable' }).kind, 'bad_request')
  assert.equal(at(408, { code: 408, message: 'Request timed out' }).kind, 'timeout')
  assert.equal(at(502, { code: 502, message: 'Provider returned an error' }).kind, 'upstream')
  assert.equal(at(503, { code: 503, message: 'No available provider' }).kind, 'upstream')

  // Nothing is collapsed into one message: each carries the gateway's own code.
  const rate = at(429, { code: 429, type: 'rate_limit_exceeded', message: 'slow down' }, { 'retry-after': '3' })
  assert.equal(rate.providerCode, 'rate_limit_exceeded')
  assert.equal(rate.retryAfter, 3)
  assert.equal(rate.status, 429)

  // A body that is not JSON at all still classifies by status.
  assert.equal(classifyOpenRouterError(500, '<html>gateway</html>', headers()).kind, 'upstream')
})

test('each kind reaches the browser as its own code and status', async () => {
  const cases: Array<[number, unknown, number, string, boolean]> = [
    [401, { code: 401, message: 'No auth credentials found' }, 401, 'auth', false],
    [402, { code: 402, message: 'Insufficient credits' }, 402, 'quota', false],
    [429, { code: 429, message: 'Rate limit exceeded' }, 429, 'rate_limited', true],
    [429, { code: 429, message: 'Rate limit exceeded: free-models-per-day' }, 402, 'quota', false],
    [404, { code: 404, message: 'No endpoints found' }, 502, 'model_unavailable', false],
    [400, { code: 400, message: 'temperature must be a number' }, 502, 'model_request_rejected', false],
    [502, { code: 502, message: 'Provider returned an error' }, 502, 'upstream', true],
  ]

  for (const [status, error, expectStatus, expectCode, retryable] of cases) {
    const g = await gateway(() => ({ status, body: { error } }))
    try {
      const provider = createOpenRouterProvider({
        OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `${g.url}/api/v1`,
      } as NodeJS.ProcessEnv)
      const res = await handleTurn(START, provider)
      assert.equal(res.status, expectStatus, `${status} must answer ${expectStatus}`)
      const body = res.body as any
      assert.equal(body.error.code, expectCode, `${status} must read as ${expectCode}`)
      assert.equal(body.error.retryable, retryable)
      // The gateway's own words survive, so the fault is identifiable.
      assert.ok(body.error.detail.length > 0)
    } finally { g.close() }
  }
})

test('a gateway that answers 200 with an error body is still a failure', async () => {
  const g = await gateway(() => ({
    status: 200,
    body: { error: { code: 402, message: 'Insufficient credits' } },
  }))
  try {
    const provider = createOpenRouterProvider({
      OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `${g.url}/api/v1`,
    } as NodeJS.ProcessEnv)
    const res = await handleTurn(START, provider)
    assert.equal(res.status, 402)
    assert.equal((res.body as any).error.code, 'quota')
  } finally { g.close() }
})

test('a timeout is a timeout, not an upstream failure', async () => {
  const slow = createServer(() => { /* never answers */ })
  await new Promise<void>((r) => slow.listen(0, r))
  const port = (slow.address() as any).port
  try {
    const provider = createOpenRouterProvider({
      OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
    } as NodeJS.ProcessEnv)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 120)
    await assert.rejects(
      () => provider({ brief: 'b', instruction: 'i' }, controller.signal),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError)
        assert.equal(err.kind, 'timeout')
        return true
      },
    )
  } finally { slow.close() }
})

test('an unreachable gateway reads as upstream, not as a crash', async () => {
  const provider = createOpenRouterProvider({
    OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: 'http://127.0.0.1:1/api/v1',
  } as NodeJS.ProcessEnv)
  const res = await handleTurn(START, provider)
  assert.equal(res.status, 502)
  assert.equal((res.body as any).error.code, 'upstream')
})

/* ---- cost ------------------------------------------------------------- */

test('nothing is retried except a short rate limit, and then only once', async () => {
  // No credit: retrying spends nothing but delays the truth.
  const broke = await gateway(() => ({ status: 402, body: { error: { code: 402, message: 'Insufficient credits' } } }))
  try {
    const p = createOpenRouterProvider({
      OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `${broke.url}/api/v1`,
    } as NodeJS.ProcessEnv)
    await handleTurn(START, p)
    assert.equal(broke.seen.length, 1, 'an empty balance must not be retried')
  } finally { broke.close() }

  // A long retry-after is not worth waiting out either.
  const later = await gateway(() => ({
    status: 429, headers: { 'retry-after': '90' },
    body: { error: { code: 429, message: 'Rate limit exceeded' } },
  }))
  try {
    const p = createOpenRouterProvider({
      OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `${later.url}/api/v1`,
    } as NodeJS.ProcessEnv)
    await handleTurn(START, p)
    assert.equal(later.seen.length, 1, 'a 90s wait must not be sat out')
  } finally { later.close() }

  // A one-second one is, exactly once.
  let calls = 0
  const soon = await gateway(() => {
    calls++
    return calls === 1
      ? { status: 429, headers: { 'retry-after': '1' }, body: { error: { code: 429, message: 'Rate limit exceeded' } } }
      : { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(TURN) } }] } }
  })
  try {
    const p = createOpenRouterProvider({
      OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `${soon.url}/api/v1`,
    } as NodeJS.ProcessEnv)
    const res = await handleTurn(START, p)
    assert.equal(res.status, 200)
    assert.equal(soon.seen.length, 2, 'exactly one retry, never more')
  } finally { soon.close() }
})

/* ---- reading what comes back ------------------------------------------ */

test('the response is parsed defensively, not assumed to be perfect JSON', () => {
  const wrap = (content: unknown, finish = 'stop') => ({
    choices: [{ finish_reason: finish, message: { content } }],
  })

  // The happy path.
  assert.deepEqual(extractOpenRouterJson(wrap(JSON.stringify({ a: 1 }))), { a: 1 })
  // A model that fenced its output.
  assert.deepEqual(extractOpenRouterJson(wrap('```json\n{"a":1}\n```')), { a: 1 })
  assert.deepEqual(extractOpenRouterJson(wrap('```\n{"a":1}\n```')), { a: 1 })
  // A model that said something first.
  assert.deepEqual(extractOpenRouterJson(wrap('Here you go:\n{"a":1}\nHope that helps.')), { a: 1 })
  // Content split into parts.
  assert.deepEqual(
    extractOpenRouterJson(wrap([{ type: 'text', text: '{"a":1}' }])),
    { a: 1 },
  )
  // An already-parsed object.
  assert.deepEqual(extractOpenRouterJson(wrap({ a: 1 })), { a: 1 })

  /* A fault in what the model *said* is not a transport fault. These used to
     be reported as `upstream`, which reads as "the gateway broke" — the
     opposite of the truth, since the request succeeded and the content was
     the problem. They now carry their own identity all the way to
     `invalid_response`. */
  const content = (payload: any) =>
    assert.throws(() => extractOpenRouterJson(payload), InvalidModelOutput)

  content(wrap('I would rather not answer that.'))
  content(wrap('{"a": 1'))
  content(wrap('', 'stop'))
  content({ choices: [] })
  content({})
  // Truncated by the token cap: valid-looking, and wrong.
  content(wrap('{"a":1}', 'length'))

  // A refusal by the provider is a provider decision, and stays one.
  assert.throws(() => extractOpenRouterJson(wrap('{"a":1}', 'content_filter')), (e: unknown) => {
    assert.ok(e instanceof ProviderError)
    assert.equal(e.kind, 'bad_request')
    return true
  })
})

test('output that parses but is not a turn is rejected before it reaches anyone', async () => {
  const g = await gateway(() => ({
    status: 200,
    body: { choices: [{ finish_reason: 'stop', message: { content: '{"hello":"world"}' } }] },
  }))
  try {
    const provider = createOpenRouterProvider({
      OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `${g.url}/api/v1`,
    } as NodeJS.ProcessEnv)
    const res = await handleTurn(START, provider)
    assert.equal(res.status, 502)
    assert.equal((res.body as any).error.code, 'invalid_response')
  } finally { g.close() }
})

test('a model that ignores the schema and writes prose JSON still produces a turn', async () => {
  const g = await gateway(() => ({
    status: 200,
    body: {
      choices: [{
        finish_reason: 'stop',
        message: { content: `Sure — here is the turn:\n\`\`\`json\n${JSON.stringify(TURN)}\n\`\`\`` },
      }],
    },
  }))
  try {
    const provider = createOpenRouterProvider({
      OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `${g.url}/api/v1`,
    } as NodeJS.ProcessEnv)
    const res = await handleTurn(START, provider)
    assert.equal(res.status, 200)
    assert.equal((res.body as any).step.decision.commitment, 'Pursue the partnership.')
  } finally { g.close() }
})

/* ---- the deployed artifact -------------------------------------------- */

test('the deployed function reaches OpenRouter under both host signatures', async () => {
  const g = await gateway()
  await withEnv(
    { ...CLEAN, OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `${g.url}/api/v1` },
    async () => {
      const fn = await bundled('api/decision.ts', 'or-node')
      const h = await host(fn.default)
      try {
        const res = await fetch(`${h.url}/api/decision`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(START),
        })
        assert.equal(res.status, 200)
        assert.match(res.headers.get('content-type') ?? '', /json/)
        const body = await res.json()
        assert.equal(body.step.kind, 'decision')
        assert.equal(body.journey.decisions[0].commitment, 'Pursue the partnership.')
        assert.equal(g.seen.length, 1, 'the gateway must actually have been called')
        assert.equal(g.seen[0].url, '/api/v1/chat/completions')

        // The Web signature, same artifact.
        const web: Response = await fn.default(
          new Request('https://lock.example/api/decision', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(START),
          }),
        )
        assert.ok(web instanceof Response)
        assert.equal(web.status, 200)
        assert.equal((await web.json()).step.kind, 'decision')
        assert.equal(g.seen.length, 2)
      } finally { h.close(); g.close() }
    },
  )
})

test('the deployed probe makes one real generation request and reports what came back', async () => {
  const g = await gateway((r) =>
    r.url.endsWith('/key')
      ? { status: 200, body: { data: { label: 'lock', is_free_tier: true } } }
      : { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] } },
  )
  await withEnv(
    {
      ...CLEAN, OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `${g.url}/api/v1`,
      VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: 'abcdef1234567890', VERCEL_REGION: 'cdg1',
    },
    async () => {
      const fn = await bundled('api/health.ts', 'or-probe-ok')
      const h = await host(fn.default)
      try {
        const text = await (await fetch(`${h.url}/api/health?probe=1`)).text()
        const json = JSON.parse(text)

        assert.equal(json.provider, 'openrouter')
        assert.equal(json.providerKeyVariable, 'OPENROUTER_API_KEY')
        assert.equal(json.model, 'openrouter/free')
        assert.equal(json.env, 'production')
        assert.equal(json.commit, 'abcdef1')

        assert.equal(json.key.present, true)
        assert.equal(json.key.length, KEY.length)
        assert.equal(json.key.prefix, 'sk-')
        assert.equal(json.key.looksWellFormed, true)
        assert.equal(json.key.hasWhitespace, false)

        assert.equal(json.probe.keyAccepted, true)
        assert.equal(json.probe.modelAvailable, true)
        assert.equal(json.probe.canGenerate, true)
        assert.equal(json.probe.verdict, 'ok')
        assert.equal(json.probe.selectedModel, 'openrouter/free')

        // A real generation request was made, and it was the smallest one.
        const generation = g.seen.filter((s) => s.url.endsWith('/chat/completions'))
        assert.equal(generation.length, 1, 'exactly one generation, no more')
        assert.equal(generation[0].method, 'POST')
        assert.equal(generation[0].body.max_tokens, 1)
        assert.equal(generation[0].body.model, 'openrouter/free')
        assert.equal(generation[0].headers.authorization, `Bearer ${KEY}`)

        // Nothing about the key comes back.
        assert.ok(!text.includes(KEY))
        assert.ok(!text.includes(KEY.slice(9)))
      } finally { h.close(); g.close() }
    },
  )
})

test('the probe keeps each failure distinct, in JSON and on the page', async () => {
  const cases: Array<[number, string, string, string]> = [
    [401, 'unauthorized', 'No auth credentials found', 'auth'],
    [402, 'insufficient_credits', 'Insufficient credits', 'quota'],
    [429, 'rate_limit', 'Rate limit exceeded', 'rate_limited'],
    [429, 'rate_limit', 'Rate limit exceeded: free-models-per-day', 'quota'],
    [404, 'not_found', 'No endpoints found matching your data policy', 'model_unavailable'],
    [400, 'bad_request', 'max_tokens must be a number', 'bad_request'],
    [500, 'server_error', 'Provider returned an error', 'upstream'],
  ]

  for (const [status, code, message, verdict] of cases) {
    const g = await gateway((r) => {
      if (r.url.endsWith('/key')) {
        return status === 401
          ? { status: 401, body: { error: { code: 401, message } } }
          : { status: 200, body: { data: { label: 'lock' } } }
      }
      if (r.url.endsWith('/models')) {
        return {
          status: 200,
          body: { data: [
            { id: 'qwen/qwen3-8b:free', pricing: { prompt: '0', completion: '0' } },
            { id: 'openai/gpt-4.1', pricing: { prompt: '0.000002', completion: '0.000008' } },
          ] },
        }
      }
      return { status, body: { error: { code: status, type: code, message } } }
    })

    try {
    await withEnv(
      { ...CLEAN, OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `${g.url}/api/v1` },
      async () => {
        const fn = await bundled('api/health.ts', `or-probe-${status}-${verdict}`)
        const h = await host(fn.default)
        try {
          const text = await (await fetch(`${h.url}/api/health?probe=1`)).text()
          const json = JSON.parse(text)
          assert.equal(json.probe.verdict, verdict, `${status} "${message}" must read as ${verdict}`)
          assert.equal(json.probe.upstream.status, status)
          assert.equal(json.probe.upstream.message, message)
          assert.equal(json.provider, 'openrouter')
          assert.ok(!text.includes(KEY))

          if (verdict === 'auth') {
            assert.equal(json.probe.keyAccepted, false)
            // The free check already settled it. Sending a generation the
            // gateway is certain to refuse would spend a request to learn
            // nothing, so it is not sent.
            assert.equal(json.probe.canGenerate, null)
            assert.equal(json.probe.upstream.url, '/key')
            assert.equal(
              g.seen.filter((r) => r.url.endsWith('/chat/completions')).length, 0,
            )
          } else {
            assert.equal(json.probe.canGenerate, false)
            assert.equal(json.probe.upstream.url, '/chat/completions')
            assert.equal(json.probe.keyAccepted, true)
            // When the key is fine but something else is not, the catalogue
            // is the fix — and only the free slugs are worth offering.
            assert.deepEqual(json.probe.models, ['qwen/qwen3-8b:free'])
          }
          if (verdict === 'model_unavailable') assert.equal(json.probe.modelAvailable, false)

          const html = await (
            await fetch(`${h.url}/api/health?probe=1`, { headers: { accept: 'text/html' } })
          ).text()
          assert.match(html, /openrouter/)
          assert.match(html, new RegExp(verdict.replace(/_/g, ' ')))
          assert.match(html, /What OpenRouter said/)
          assert.ok(!html.includes(KEY))
        } finally { h.close() }
      },
    )
    } finally { g.close() }
  }
})

test('with no key the probe names the variable, and spends nothing finding out', async () => {
  const g = await gateway()
  await withEnv({ ...CLEAN, OPENROUTER_BASE_URL: `${g.url}/api/v1` }, async () => {
    const fn = await bundled('api/health.ts', 'or-nokey')
    const h = await host(fn.default)
    try {
      const json = await (await fetch(`${h.url}/api/health?probe=1`)).json()
      assert.equal(json.provider, 'openrouter')
      assert.equal(json.probe.verdict, 'no_credential')
      assert.match(json.probe.advice, /OPENROUTER_API_KEY is not configured/)
      assert.equal(json.key.present, false)
      assert.equal(json.credentials.OPENROUTER_API_KEY.present, false)
      assert.equal(g.seen.length, 0, 'no key means no request to pay for')
    } finally { h.close(); g.close() }
  })
})

test('a key pasted with stray whitespace is reported rather than silently used', async () => {
  const g = await gateway()
  await withEnv(
    { ...CLEAN, OPENROUTER_API_KEY: `${KEY}\n`, OPENROUTER_BASE_URL: `${g.url}/api/v1` },
    async () => {
      const fn = await bundled('api/health.ts', 'or-space')
      const h = await host(fn.default)
      try {
        const json = await (await fetch(`${h.url}/api/health?probe=1`)).json()
        assert.equal(json.key.hasWhitespace, true)
        assert.equal(json.credentials.OPENROUTER_API_KEY.hasWhitespace, true)
        // Trimmed before use, so the deployment still works.
        assert.equal(g.seen.at(-1)?.headers.authorization, `Bearer ${KEY}`)
      } finally { h.close(); g.close() }
    },
  )
})

/* ---- the key ---------------------------------------------------------- */

test('the key never leaves the server, in any response, page, or log', async () => {
  // A gateway that echoes the credential back inside its own error message —
  // the one way a key can escape without anyone writing it out deliberately.
  const g = await gateway(() => ({
    status: 401,
    body: { error: { code: 401, message: `Invalid credentials: ${KEY}` } },
  }))

  const logged: string[] = []
  const realError = console.error
  const realWarn = console.warn
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')) }
  console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(' ')) }

  try {
    const provider = createOpenRouterProvider({
      OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `${g.url}/api/v1`,
    } as NodeJS.ProcessEnv)
    const res = await handleTurn(START, provider)
    assert.equal(res.status, 401)

    const payload = JSON.stringify(res.body)
    assert.ok(!payload.includes(KEY), 'the key must not reach the browser')
    assert.ok(!payload.includes(KEY.slice(9)), 'not even part of it')
    assert.match(payload, /sk-or-\*\*\*/, 'it is masked, not merely absent by luck')

    const log = logged.join('\n')
    assert.ok(log.length > 0, 'the failure is still logged')
    assert.ok(!log.includes(KEY), 'the key must not reach the function log')
  } finally {
    console.error = realError
    console.warn = realWarn
    g.close()
  }
})

test('no part of the browser bundle knows the key exists', async () => {
  // Vite only inlines `import.meta.env.VITE_*`, so the proof is twofold: the
  // client never names the variable, and nothing exposes it under a VITE_ name.
  const roots = ['src', 'shared']
  const offenders: string[] = []

  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      const text = await readFile(full, 'utf8')
      if (/OPENROUTER_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|sk-or-v[0-9]-/.test(text)) {
        offenders.push(full)
      }
    }
  }
  for (const root of roots) await walk(root)
  assert.deepEqual(offenders, [], 'no client-side source may reference a provider key')

  const html = await readFile('index.html', 'utf8')
  assert.ok(!/OPENROUTER|API_KEY/i.test(html), 'the page shell must not carry a key name')

  // And the key is read from exactly one place, server-side.
  const provider = await readFile('server/ai/openrouter.ts', 'utf8')
  assert.match(provider, /env\.OPENROUTER_API_KEY/)
  assert.ok(!/VITE_/.test(provider))
})

test('the probe and the provider agree on which model is configured', async () => {
  // Two files, one default. If they drift, the diagnostic starts describing a
  // deployment that does not exist — which is how the last outage stayed
  // invisible for so long.
  const health = await readFile('api/health.ts', 'utf8')
  const provider = await readFile('server/ai/openrouter.ts', 'utf8')
  const fromHealth = /'openrouter\/free'/.test(health)
  const fromProvider = /const DEFAULT_MODEL = 'openrouter\/free'/.test(provider)
  assert.ok(fromHealth && fromProvider, 'both files must name the same default model')

  const g = await gateway()
  await withEnv(
    {
      ...CLEAN, OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `${g.url}/api/v1`,
      LOCK_MODEL: 'qwen/qwen3-8b:free',
    },
    async () => {
      const fn = await bundled('api/health.ts', 'or-model-agree')
      const h = await host(fn.default)
      try {
        const json = await (await fetch(`${h.url}/api/health?probe=1`)).json()
        assert.equal(json.model, 'qwen/qwen3-8b:free')
        assert.equal(json.probe.selectedModel, 'qwen/qwen3-8b:free')
        const generation = g.seen.filter((s) => s.url.endsWith('/chat/completions'))
        assert.equal(generation[0].body.model, 'qwen/qwen3-8b:free')
      } finally { h.close(); g.close() }
    },
  )
})
