import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import {
  classifyGeminiError, createGeminiProvider, extractGeminiJson,
  GEMINI_TURN_SCHEMA, toGeminiSchema,
} from '../server/ai/gemini.js'
import { ProviderError } from '../server/ai/provider.js'
import { SYSTEM_PROMPT } from '../server/ai/prompt.js'
import { createProvider, describeProvider, selectProviderName } from '../server/ai/factory.js'
import { handleTurn } from '../server/handler.js'

const headers = (h: Record<string, string> = {}) => ({ get: (n: string) => h[n.toLowerCase()] ?? null })

/* ---- schema translation --------------------------------------------- */

test('the turn schema converts to Gemini’s OpenAPI dialect', () => {
  const s = GEMINI_TURN_SCHEMA as any
  assert.equal(s.type, 'OBJECT', 'types must be the uppercase enum')
  assert.equal(s.properties.progress.type, 'NUMBER')
  assert.deepEqual(s.required.sort(), ['confidence', 'progress', 'step', 'title', 'understanding'].sort())

  // A ["string","null"] union becomes nullable, which is the only form Gemini has.
  const critical = s.properties.understanding.properties.criticalUnknown
  assert.equal(critical.type, 'STRING')
  assert.equal(critical.nullable, true)

  const options = s.properties.step.properties.options
  assert.equal(options.type, 'ARRAY')
  assert.equal(options.nullable, true)
  assert.equal(options.items.type, 'STRING')
})

test('nothing outside the OpenAPI subset survives the conversion', () => {
  // additionalProperties has no equivalent and a request carrying it is refused.
  const banned = ['additionalProperties', 'minimum', 'maximum', '$schema', 'strict', 'default']
  const walk = (node: any, path: string) => {
    if (!node || typeof node !== 'object') return
    for (const key of Object.keys(node)) {
      assert.ok(!banned.includes(key), `${path}.${key} must not reach Gemini`)
      walk(node[key], `${path}.${key}`)
    }
  }
  walk(GEMINI_TURN_SCHEMA, 'schema')
  // And every `type` really is uppercase, everywhere.
  const types: string[] = []
  const collect = (n: any) => {
    if (!n || typeof n !== 'object') return
    if (typeof n.type === 'string') types.push(n.type)
    Object.values(n).forEach(collect)
  }
  collect(GEMINI_TURN_SCHEMA)
  assert.ok(types.length > 10)
  for (const t of types) assert.equal(t, t.toUpperCase(), `${t} is not uppercase`)
})

test('the conversion handles the shapes it will meet', () => {
  assert.deepEqual(toGeminiSchema({ type: 'string' }), { type: 'STRING' })
  assert.deepEqual(toGeminiSchema({ type: ['boolean', 'null'] }), { type: 'BOOLEAN', nullable: true })
  assert.deepEqual(
    toGeminiSchema({ type: 'string', enum: ['a', 'b', null] }),
    { type: 'STRING', enum: ['a', 'b'] },
  )
  // Property order is pinned so output is stable turn to turn.
  const obj = toGeminiSchema({ type: 'object', properties: { b: { type: 'string' }, a: { type: 'string' } } }) as any
  assert.deepEqual(obj.propertyOrdering, ['b', 'a'])
})

/* ---- request shape --------------------------------------------------- */

function mockGemini(reply: (res: any, req: any) => void) {
  let seen: any = null
  return new Promise<{ url: string; close: () => void; seen: () => any }>((resolve) => {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        seen = { url: req.url, headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null }
        reply(res, seen)
      })
    })
    server.listen(0, () => {
      const port = (server.address() as any).port
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close(), seen: () => seen })
    })
  })
}

const okReply = (obj: unknown) => (res: any) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(obj) }] } }],
  }))
}

test('sends a correctly shaped generateContent request', async () => {
  const s = await mockGemini(okReply({ hello: 'world' }))
  try {
    const provider = createGeminiProvider({
      GEMINI_API_KEY: 'AIza-test-key', GEMINI_BASE_URL: s.url, GEMINI_MODEL: 'gemini-2.5-flash',
    } as NodeJS.ProcessEnv)
    const out = await provider({ brief: 'BRIEF', instruction: 'INSTRUCTION' }, new AbortController().signal)
    assert.deepEqual(out, { hello: 'world' })

    const seen = s.seen()
    assert.equal(seen.url, '/models/gemini-2.5-flash:generateContent')
    // The key travels in a header, never in the URL where logs would keep it.
    assert.equal(seen.headers['x-goog-api-key'], 'AIza-test-key')
    assert.ok(!seen.url.includes('AIza'), 'the key must not be a query parameter')

    assert.equal(seen.body.systemInstruction.parts[0].text, SYSTEM_PROMPT)
    assert.equal(seen.body.contents[0].role, 'user')
    assert.match(seen.body.contents[0].parts[0].text, /BRIEF[\s\S]*INSTRUCTION/)
    assert.equal(seen.body.generationConfig.responseMimeType, 'application/json')
    assert.equal(seen.body.generationConfig.responseSchema.type, 'OBJECT')
    assert.ok(seen.body.generationConfig.maxOutputTokens > 0)
  } finally { s.close() }
})

/* ---- responses ------------------------------------------------------- */

test('reads the turn out of a candidate, joining split parts', () => {
  const out = extractGeminiJson({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"a":' }, { text: '1}' }] } }],
  })
  assert.deepEqual(out, { a: 1 })
})

test('a truncated or blocked response is reported, not parsed', () => {
  for (const finish of ['MAX_TOKENS', 'SAFETY', 'MALFORMED_RESPONSE', 'RECITATION']) {
    assert.throws(
      () => extractGeminiJson({ candidates: [{ finishReason: finish, content: { parts: [{ text: '{' }] } }] }),
      (e: unknown) => e instanceof ProviderError && e.kind === 'upstream',
      finish,
    )
  }
  assert.throws(
    () => extractGeminiJson({ promptFeedback: { blockReason: 'SAFETY' } }),
    (e: unknown) => e instanceof ProviderError && e.kind === 'bad_request',
  )
  assert.throws(
    () => extractGeminiJson({ candidates: [] }),
    (e: unknown) => e instanceof ProviderError && e.kind === 'upstream',
  )
  assert.throws(
    () => extractGeminiJson({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }),
    (e: unknown) => e instanceof ProviderError && e.kind === 'upstream',
  )
})

/* ---- errors map onto the same kinds ---------------------------------- */

test('Google’s canonical codes map onto the existing kinds', () => {
  const cases: Array<[number, string, string, string]> = [
    [429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for quota metric requests per day', 'quota'],
    [429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check your rate limit)', 'rate_limited'],
    [401, 'UNAUTHENTICATED', 'API key not valid', 'auth'],
    [403, 'PERMISSION_DENIED', 'Method does not allow unregistered callers', 'auth'],
    [404, 'NOT_FOUND', 'models/gemini-9 is not found', 'model_unavailable'],
    [400, 'INVALID_ARGUMENT', 'Invalid JSON payload', 'bad_request'],
    [500, 'INTERNAL', 'Internal error', 'upstream'],
    [503, 'UNAVAILABLE', 'The model is overloaded', 'upstream'],
  ]
  for (const [status, canonical, message, kind] of cases) {
    const err = classifyGeminiError(
      status, JSON.stringify({ error: { code: status, status: canonical, message } }), headers(),
    )
    assert.equal(err.kind, kind, `${status} ${canonical}: ${message}`)
    assert.equal(err.providerCode, canonical)
  }
})

test('a daily free-tier limit is quota, and is never retried', async () => {
  let hits = 0
  const s = await mockGemini((res) => {
    hits++
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      error: { code: 429, status: 'RESOURCE_EXHAUSTED',
               message: 'Quota exceeded for quota metric requests per day' },
    }))
  })
  try {
    const provider = createGeminiProvider({
      GEMINI_API_KEY: 'k', GEMINI_BASE_URL: s.url,
    } as NodeJS.ProcessEnv)
    await assert.rejects(
      () => provider({ brief: 'b', instruction: 'i' }, new AbortController().signal),
      (e: unknown) => e instanceof ProviderError && e.kind === 'quota',
    )
    assert.equal(hits, 1, 'a spent daily quota must not be retried')
  } finally { s.close() }
})

test('a per-minute limit is waited out once, as with the other provider', async () => {
  let hits = 0
  const s = await mockGemini((res) => {
    hits++
    if (hits === 1) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
      res.end(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'rate limit' } }))
      return
    }
    okReply({ ok: true })(res)
  })
  try {
    const provider = createGeminiProvider({
      GEMINI_API_KEY: 'k', GEMINI_BASE_URL: s.url,
    } as NodeJS.ProcessEnv)
    assert.deepEqual(
      await provider({ brief: 'b', instruction: 'i' }, new AbortController().signal),
      { ok: true },
    )
    assert.equal(hits, 2)
  } finally { s.close() }
})

test('a missing Gemini key never reaches the network', async () => {
  let hit = false
  const s = await mockGemini((res) => { hit = true; res.end('{}') })
  try {
    const provider = createGeminiProvider({ GEMINI_BASE_URL: s.url } as NodeJS.ProcessEnv)
    await assert.rejects(
      () => provider({ brief: 'b', instruction: 'i' }, new AbortController().signal),
      (e: unknown) => e instanceof ProviderError && e.kind === 'unconfigured',
    )
    assert.equal(hit, false)
  } finally { s.close() }
})

/* ---- selection ------------------------------------------------------- */

test('the provider is chosen by configuration alone', () => {
  const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv
  assert.equal(selectProviderName(env({ GEMINI_API_KEY: 'k' })), 'gemini')
  assert.equal(selectProviderName(env({ OPENAI_API_KEY: 'k' })), 'openai')
  // With both, Gemini wins, so adding a Gemini key is enough to switch.
  assert.equal(selectProviderName(env({ OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'b' })), 'gemini')
  // Explicit configuration beats key presence in both directions.
  assert.equal(selectProviderName(env({ LOCK_PROVIDER: 'openai', GEMINI_API_KEY: 'b' })), 'openai')
  assert.equal(selectProviderName(env({ LOCK_PROVIDER: 'gemini', OPENAI_API_KEY: 'a' })), 'gemini')
  assert.equal(selectProviderName(env({})), 'openai')
  assert.equal(describeProvider(env({ GEMINI_API_KEY: 'k' })).keyVariable, 'GEMINI_API_KEY')
})

/* ---- the contract above the seam is untouched ------------------------ */

test('a Gemini turn produces the same /api/decision response as any other', async () => {
  const turn = {
    title: 'Getting a cat',
    understanding: {
      objective: 'Decide whether to get a cat', known: ['Wants one'],
      openQuestions: [], criticalUnknown: null, contradiction: null,
    },
    progress: 0.6, confidence: 0.8,
    step: {
      kind: 'decision', question: 'Should I get a cat?', commitment: 'Get the cat.',
      rationale: 'Nothing is stopping you.', isFinal: true, importance: 'pivotal',
      framing: null, prompt: null, why: null, options: null, allowFree: null, closing: null,
    },
  }
  const s = await mockGemini(okReply(turn))
  try {
    const provider = createProvider({
      GEMINI_API_KEY: 'k', GEMINI_BASE_URL: s.url,
    } as NodeJS.ProcessEnv)
    const res = await handleTurn(
      { journey: null, event: { type: 'start', input: 'Should I get a cat?' } },
      provider,
    )
    assert.equal(res.status, 200)
    const body = res.body as any
    assert.equal(body.step.kind, 'decision')
    assert.equal(body.step.decision.commitment, 'Get the cat.')
    assert.equal(body.journey.decisions[0].status, 'pending')
    assert.equal(body.journey.currentDecisionId, body.journey.decisions[0].id)
  } finally { s.close() }
})

/* ---- the diagnostic, for Gemini -------------------------------------- */

test('the probe reports Gemini and lists the models the key can use', async () => {
  const { build } = await import('esbuild')
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = await mkdtemp(join(tmpdir(), 'lock-gh-'))
  const outfile = join(dir, 'h.mjs')
  await build({
    entryPoints: ['api/health.ts'], bundle: true, platform: 'node',
    format: 'esm', target: 'node20', outfile, logLevel: 'silent',
  })

  // Google answering: two usable models, and one that cannot generate.
  const google = await mockGemini((res, req) => {
    if (req.url === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        models: [
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        ],
      }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }] }))
  })

  process.env.LOCK_PROVIDER = 'gemini'
  process.env.GEMINI_API_KEY = 'AIzaSyTESTKEYzzzzzzzzzzzzzzzzzzzzzzzz'
  process.env.GEMINI_BASE_URL = google.url
  delete process.env.GEMINI_MODEL

  const mod = await import(`file://${outfile}?gemini`)
  const server = createServer((req, res) => mod.default(req, res))
  await new Promise<void>((r) => server.listen(0, r))
  const port = (server.address() as any).port

  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/health?probe=1`)).json()
    assert.equal(body.provider, 'gemini')
    assert.equal(body.providerKeyVariable, 'GEMINI_API_KEY')
    assert.equal(body.key.present, true)
    assert.equal(body.key.looksWellFormed, true, 'a Google key must not be judged by the sk- shape')
    assert.equal(body.probe.verdict, 'ok')
    assert.equal(body.probe.keyAccepted, true)
    assert.equal(body.probe.canGenerate, true)
    // Model availability comes from the key, not from a hardcoded guess.
    assert.deepEqual(body.probe.models, ['gemini-2.5-flash', 'gemini-2.5-pro'])

    const text = JSON.stringify(body)
    assert.ok(!text.includes('AIzaSyTESTKEY'), 'the key must never be returned')

    const html = await (
      await fetch(`http://127.0.0.1:${port}/api/health?probe=1`, { headers: { accept: 'text/html' } })
    ).text()
    assert.match(html, /gemini-2\.5-flash/)
    assert.ok(!html.includes('AIzaSyTESTKEY'))
  } finally {
    server.close(); google.close()
    delete process.env.LOCK_PROVIDER
    delete process.env.GEMINI_API_KEY
    delete process.env.GEMINI_BASE_URL
  }
})

test('the probe flags a model the key cannot use, and says which it can', async () => {
  const { build } = await import('esbuild')
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = await mkdtemp(join(tmpdir(), 'lock-gh2-'))
  const outfile = join(dir, 'h.mjs')
  await build({
    entryPoints: ['api/health.ts'], bundle: true, platform: 'node',
    format: 'esm', target: 'node20', outfile, logLevel: 'silent',
  })

  const google = await mockGemini((res, req) => {
    if (req.url === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }],
      }))
      return
    }
    res.writeHead(200).end('{}')
  })

  process.env.LOCK_PROVIDER = 'gemini'
  process.env.GEMINI_API_KEY = 'AIzaSyOTHERKEYzzzzzzzzzzzzzzzzzzzzz'
  process.env.GEMINI_BASE_URL = google.url
  process.env.GEMINI_MODEL = 'gemini-does-not-exist'

  const mod = await import(`file://${outfile}?geminimodel`)
  const server = createServer((req, res) => mod.default(req, res))
  await new Promise<void>((r) => server.listen(0, r))
  const port = (server.address() as any).port
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/health?probe=1`)).json()
    assert.equal(body.probe.verdict, 'model_unavailable')
    assert.equal(body.probe.modelAvailable, false)
    assert.match(body.probe.advice, /GEMINI_MODEL/)
    assert.deepEqual(body.probe.models, ['gemini-2.5-flash'])
  } finally {
    server.close(); google.close()
    delete process.env.LOCK_PROVIDER
    delete process.env.GEMINI_API_KEY
    delete process.env.GEMINI_BASE_URL
    delete process.env.GEMINI_MODEL
  }
})
