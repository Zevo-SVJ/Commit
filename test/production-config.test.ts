import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { build } from 'esbuild'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Runs the artifact the platform actually deploys, under the environment the
 * deployment actually has, against stand-ins for both providers — so "Gemini
 * is being used" is demonstrated rather than asserted.
 */

const GEMINI_KEY = 'AIzaSyPRODUCTIONLIKEKEYzzzzzzzzzzzzzzz'
const OPENAI_KEY = 'sk-proj-still-present-but-out-of-credit-00000'

async function bundled(entry: string, tag: string) {
  const dir = await mkdtemp(join(tmpdir(), 'lock-prod-'))
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
    s.listen(0, () => resolve({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close() }))
  })
}

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

/** Counts calls so we can prove which provider was actually used. */
function provider(kind: 'gemini' | 'openai') {
  let calls = 0
  return new Promise<{ url: string; close: () => void; calls: () => number }>((resolve) => {
    const s: Server = createServer((req, res) => {
      calls++
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        if (kind === 'gemini' && req.url === '/models') {
          res.end(JSON.stringify({
            models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }],
          }))
          return
        }
        res.end(
          kind === 'gemini'
            ? JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(TURN) }] } }] })
            : JSON.stringify({ output_text: JSON.stringify(TURN) }),
        )
      })
    })
    s.listen(0, () => resolve({
      url: `http://127.0.0.1:${(s.address() as any).port}`,
      close: () => s.close(), calls: () => calls,
    }))
  })
}

test('with a Gemini key present, the deployed function calls Gemini and not OpenAI', async () => {
  const gemini = await provider('gemini')
  const openai = await provider('openai')

  // The legacy providers are reachable, but only by asking for one by name.
  process.env.OPENAI_API_KEY = OPENAI_KEY
  process.env.GEMINI_API_KEY = GEMINI_KEY
  process.env.OPENAI_BASE_URL = openai.url
  process.env.GEMINI_BASE_URL = gemini.url
  process.env.LOCK_PROVIDER = 'gemini'

  const fn = await bundled('api/decision.ts', 'prod-gemini')
  const h = await host(fn.default)
  try {
    const res = await fetch(`${h.url}/api/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ journey: null, event: { type: 'start', input: 'Should I pursue this partnership?' } }),
    })
    assert.equal(res.status, 200, 'a decision must come back')
    const body = await res.json()
    assert.equal(body.step.kind, 'decision')
    assert.equal(body.step.decision.commitment, 'Pursue the partnership.')

    assert.equal(gemini.calls(), 1, 'Gemini must have been called')
    assert.equal(openai.calls(), 0, 'OpenAI must NOT have been called')

    // Nothing about the key reaches the response.
    const text = JSON.stringify(body)
    assert.ok(!text.includes('AIza'), 'no Gemini key material in the response')
    assert.ok(!text.includes('sk-'), 'no OpenAI key material in the response')
  } finally {
    h.close(); gemini.close(); openai.close()
    delete process.env.OPENAI_BASE_URL; delete process.env.GEMINI_BASE_URL
  }
})

test('OpenAI is no longer required: the app works with only a Gemini key', async () => {
  const gemini = await provider('gemini')
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  process.env.LOCK_PROVIDER = 'gemini'
  process.env.GEMINI_API_KEY = GEMINI_KEY
  process.env.GEMINI_BASE_URL = gemini.url

  const fn = await bundled('api/decision.ts', 'prod-only-gemini')
  const h = await host(fn.default)
  try {
    const res = await fetch(`${h.url}/api/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ journey: null, event: { type: 'start', input: 'Should I get a cat?' } }),
    })
    assert.equal(res.status, 200, 'no OpenAI key present, and it still works')
    assert.equal((await res.json()).step.kind, 'decision')
    assert.equal(gemini.calls(), 1)
  } finally {
    h.close(); gemini.close()
    delete process.env.GEMINI_BASE_URL
  }
})

test('the deployed probe reports gemini, and never the key', async () => {
  const gemini = await provider('gemini')
  process.env.OPENAI_API_KEY = OPENAI_KEY
  process.env.GEMINI_API_KEY = GEMINI_KEY
  process.env.GEMINI_BASE_URL = gemini.url
  process.env.VERCEL_ENV = 'production'
  process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef1234567890'
  process.env.VERCEL_REGION = 'cdg1'
  process.env.LOCK_PROVIDER = 'gemini'
  delete process.env.GEMINI_MODEL

  const fn = await bundled('api/health.ts', 'prod-probe')
  const h = await host(fn.default)
  try {
    const json = await (await fetch(`${h.url}/api/health?probe=1`)).json()

    // Every field the report is required to expose.
    assert.equal(json.provider, 'gemini')
    assert.equal(json.providerKeyVariable, 'GEMINI_API_KEY')
    assert.equal(json.probe.keyAccepted, true)
    assert.equal(json.probe.modelAvailable, true)
    assert.equal(json.probe.canGenerate, true)
    assert.equal(json.probe.verdict, 'ok')
    assert.equal(json.model, 'gemini-2.5-flash')
    assert.equal(json.env, 'production')
    assert.equal(json.commit, 'abcdef1')
    assert.equal(json.region, 'cdg1')
    assert.ok('providerCode' in json.probe)

    // An OpenAI verdict must not be able to overwrite a Gemini one.
    assert.ok(!JSON.stringify(json).includes('insufficient_quota'))
    assert.ok(!JSON.stringify(json).includes(GEMINI_KEY))
    assert.ok(!JSON.stringify(json).includes(OPENAI_KEY))
    assert.equal(json.key.prefix, 'AIz')

    // ?format=json and the HTML view both work, and neither leaks.
    const forced = await fetch(`${h.url}/api/health?probe=1&format=json`, { headers: { accept: 'text/html' } })
    assert.match(forced.headers.get('content-type') ?? '', /application\/json/)
    assert.equal((await forced.json()).provider, 'gemini')

    const html = await (await fetch(`${h.url}/api/health?probe=1`, { headers: { accept: 'text/html' } })).text()
    assert.match(html, /gemini/)
    assert.ok(!html.includes(GEMINI_KEY))
  } finally {
    h.close(); gemini.close()
    delete process.env.GEMINI_BASE_URL; delete process.env.VERCEL_ENV
    delete process.env.VERCEL_GIT_COMMIT_SHA; delete process.env.VERCEL_REGION
  }
})

test('a bad Gemini key reads as auth, and a spent quota as quota — never swapped', async () => {
  const cases: Array<[number, string, string, string]> = [
    [401, 'UNAUTHENTICATED', 'API key not valid. Please pass a valid API key.', 'auth'],
    [429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for quota metric requests per day', 'quota'],
    [429, 'RESOURCE_EXHAUSTED', 'Resource exhausted, please retry shortly', 'rate_limited'],
  ]
  for (const [status, canonical, message, expected] of cases) {
    const bad = await new Promise<{ url: string; close: () => void }>((resolve) => {
      const s = createServer((req, res) => {
        req.resume()
        req.on('end', () => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: status, status: canonical, message } }))
        })
      })
      s.listen(0, () => resolve({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close() }))
    })

    delete process.env.OPENAI_API_KEY
    process.env.GEMINI_API_KEY = GEMINI_KEY
    process.env.GEMINI_BASE_URL = bad.url

    const fn = await bundled('api/decision.ts', `prod-err-${status}-${expected}`)
    const h = await host(fn.default)
    try {
      const res = await fetch(`${h.url}/api/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ journey: null, event: { type: 'start', input: 'x' } }),
      })
      const body = await res.json()
      const codes: Record<string, string> = { auth: 'auth', quota: 'quota', rate_limited: 'rate_limited' }
      assert.equal(body.error.code, codes[expected], `${canonical}: ${message}`)
      // Retrying is only ever offered where it can help.
      assert.equal(body.error.retryable, expected === 'rate_limited')
      assert.ok(!JSON.stringify(body).includes('AIza'), 'no key in an error body')
    } finally {
      h.close(); bad.close()
      delete process.env.GEMINI_BASE_URL
    }
  }
})

/** Stands in for Google, accepting one transport and one API version only. */
function pickyGoogle(accept: { auth: 'bearer' | 'api-key'; version: string }) {
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const s = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        const url = req.url ?? ''
        const isBearer = Boolean(req.headers['authorization'])
        const isKey = Boolean(req.headers['x-goog-api-key'])
        const version = url.startsWith('/v1beta') ? 'v1beta' : url.startsWith('/v1') ? 'v1' : '?'

        if (url.endsWith('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }],
          }))
          return
        }

        const authOk = accept.auth === 'bearer' ? isBearer : isKey
        if (!authOk) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            error: { code: 401, status: 'UNAUTHENTICATED', message: 'Expected OAuth 2 access token' },
          }))
          return
        }
        if (version !== accept.version) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            error: {
              code: 404, status: 'NOT_FOUND',
              message: `models/gemini-2.5-flash is not found for API version ${version}`,
            },
          }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}' }] } }],
        }))
      })
    })
    s.listen(0, () => resolve({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close() }))
  })
}

test('the probe reports Google’s own words and which transport works', async () => {
  // Google here accepts only bearer + v1beta. The probe is pointed at v1beta
  // but its credential is AIza-shaped, so it will use the API-key header and
  // fail — exactly the shape of the reported production fault.
  const google = await pickyGoogle({ auth: 'bearer', version: 'v1beta' })
  delete process.env.OPENAI_API_KEY
  process.env.GEMINI_API_KEY = 'AIzaSyWRONGTRANSPORTzzzzzzzzzzzz'
  process.env.GEMINI_BASE_URL = `${google.url}/v1beta`
  delete process.env.GEMINI_AUTH_MODE

  const fn = await bundled('api/health.ts', 'matrix-probe')
  const h = await host(fn.default)
  try {
    const json = await (await fetch(`${h.url}/api/health?probe=1`)).json()

    assert.equal(json.probe.keyAccepted, true, 'listing models still works')
    assert.equal(json.probe.canGenerate, false)
    assert.equal(json.probe.authMode, 'api-key')

    // Google's own message, not just the category.
    assert.equal(json.probe.upstream.status, 401)
    assert.match(json.probe.upstream.message, /OAuth 2 access token/)
    assert.match(json.probe.upstream.url, /generateContent/)

    // And the matrix names the combination that does work.
    const working = json.probe.matrix.filter((m: any) => m.code === 'OK')
    assert.equal(working.length, 1, JSON.stringify(json.probe.matrix))
    assert.equal(working[0].auth, 'bearer')
    assert.equal(working[0].version, 'v1beta')

    assert.ok(!JSON.stringify(json).includes('AIzaSyWRONGTRANSPORT'), 'no credential anywhere')
  } finally {
    h.close(); google.close()
    delete process.env.GEMINI_BASE_URL
  }
})

test('an AQ. credential reaches Google as a bearer token, end to end', async () => {
  const google = await pickyGoogle({ auth: 'bearer', version: 'v1beta' })
  delete process.env.OPENAI_API_KEY
  delete process.env.GEMINI_AUTH_MODE
  process.env.GEMINI_API_KEY = 'AQ.Ab8RN6PRODUCTIONSHAPEDAUTHKEY000000'
  process.env.GEMINI_BASE_URL = `${google.url}/v1beta`

  const fn = await bundled('api/decision.ts', 'aq-bearer')
  const h = await host(fn.default)
  try {
    const res = await fetch(`${h.url}/api/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ journey: null, event: { type: 'start', input: 'x' } }),
    })
    // Google accepted the bearer transport; the empty turn then fails
    // validation, which is a different failure and proves auth got through.
    const body = await res.json()
    assert.notEqual(body?.error?.code, 'auth', 'the credential must be accepted')
    assert.notEqual(body?.error?.code, 'model_unavailable')
    assert.ok(!JSON.stringify(body).includes('AQ.Ab8RN6'), 'no credential in the response')
  } finally {
    h.close(); google.close()
    delete process.env.GEMINI_BASE_URL
  }
})

/* ---- the probe must explain itself ------------------------------------ */

test('with no credential the probe says so, instead of "not probed"', async () => {
  delete process.env.GEMINI_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  delete process.env.LOCK_PROVIDER

  const fn = await bundled('api/health.ts', 'no-cred')
  const h = await host(fn.default)
  try {
    const json = await (await fetch(`${h.url}/api/health?probe=1`)).json()

    // The bug: this used to come back null, rendering as "not probed", which
    // reads as a missing flag rather than a missing credential.
    assert.notEqual(json.probe, null, 'the probe must run and report')
    assert.equal(json.probe.verdict, 'no_credential')
    // It must name the variable the deployment actually needs.
    assert.match(json.probe.advice, /OPENROUTER_API_KEY is not configured/)
    assert.match(json.probe.advice, /redeploy/)
    assert.equal(json.provider, 'openrouter')

    // Every credential is reported, not just the selected provider's.
    assert.equal(json.credentials.OPENROUTER_API_KEY.present, false)
    assert.equal(json.credentials.GEMINI_API_KEY.present, false)
    assert.equal(json.credentials.OPENAI_API_KEY.present, false)
    assert.ok(Array.isArray(json.configVars))
  } finally { h.close() }
})

test('an AQ. credential is recognised as an auth key, and never returned', async () => {
  delete process.env.OPENAI_API_KEY
  process.env.LOCK_PROVIDER = 'gemini'
  delete process.env.OPENROUTER_API_KEY
  process.env.GEMINI_API_KEY = 'AQ.Ab8RN6REALSHAPEDAUTHKEYzzzzzzzzzzzzzzzzzzzzzzzzz'

  const fn = await bundled('api/health.ts', 'aq-kind')
  const h = await host(fn.default)
  try {
    const json = await (await fetch(`${h.url}/api/health?probe=1`)).json()
    assert.equal(json.provider, 'gemini')
    assert.equal(json.credentials.GEMINI_API_KEY.present, true)
    assert.equal(json.credentials.GEMINI_API_KEY.kind, 'google-auth-key')
    assert.equal(json.credentials.GEMINI_API_KEY.prefix, 'AQ.')
    // The variable is visible by name.
    assert.ok(json.configVars.some((v: any) => v.name === 'GEMINI_API_KEY' && v.set))
    assert.ok(!JSON.stringify(json).includes('Ab8RN6REALSHAPED'), 'never the credential itself')
  } finally { h.close(); delete process.env.GEMINI_API_KEY }
})

test('the probe flag is accepted in every form it might arrive in', async () => {
  process.env.GEMINI_API_KEY = 'AQ.Ab8RN6flagtestzzzzzzzzzzzzzzzzzzz'
  process.env.LOCK_PROVIDER = 'gemini'
  delete process.env.OPENAI_API_KEY
  const fn = await bundled('api/health.ts', 'flag-forms')
  const h = await host(fn.default)
  try {
    // A rewrite that drops or rewrites the query must not silently downgrade
    // the request to the cheap check.
    for (const path of ['/api/health?probe=1', '/api/health?probe=true', '/api/health?probe', '/probe']) {
      const json = await (await fetch(`${h.url}${path}`)).json()
      assert.notEqual(json.probe, null, `${path} must run the probe`)
    }
    // And it can still be turned off deliberately.
    for (const path of ['/api/health', '/api/health?probe=0', '/api/health?probe=false']) {
      const json = await (await fetch(`${h.url}${path}`)).json()
      assert.equal(json.probe, null, `${path} must not run the probe`)
    }
  } finally { h.close(); delete process.env.GEMINI_API_KEY }
})
