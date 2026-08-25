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

  // Exactly the deployment's situation: the old OpenAI key is still set, and
  // a Gemini key has been added. No LOCK_PROVIDER.
  process.env.OPENAI_API_KEY = OPENAI_KEY
  process.env.GEMINI_API_KEY = GEMINI_KEY
  process.env.OPENAI_BASE_URL = openai.url
  process.env.GEMINI_BASE_URL = gemini.url
  delete process.env.LOCK_PROVIDER

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
  delete process.env.LOCK_PROVIDER
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
  delete process.env.LOCK_PROVIDER
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
