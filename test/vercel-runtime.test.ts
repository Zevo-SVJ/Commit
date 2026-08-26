import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { build } from 'esbuild'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Verifies the artifact Vercel actually deploys, not the source.
 *
 * The function is bundled the way the platform bundles it, then invoked under
 * both handler signatures against a stand-in for the OpenAI API. A green build
 * only proves the code compiles; this proves the request path runs.
 */

async function bundleFunction(entry: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lock-fn-'))
  const outfile = join(dir, 'fn.mjs')
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'silent',
  })
  return outfile
}

/** A stand-in for the Responses API that returns one valid turn. */
function mockOpenAI(): Promise<{ url: string; close: () => void; calls: () => number }> {
  let calls = 0
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      calls++
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            output: [
              {
                content: [
                  {
                    type: 'output_text',
                    text: JSON.stringify({
                      title: 'Getting a cat',
                      understanding: {
                        objective: 'Decide whether to get a cat',
                        known: ['Wants one'], openQuestions: [],
                        criticalUnknown: null, contradiction: null,
                      },
                      progress: 0.6, confidence: 0.8,
                      step: {
                        kind: 'decision', question: 'Should I get a cat?',
                        commitment: 'Get the cat.', rationale: 'Nothing is stopping you.',
                        isFinal: true, importance: 'pivotal', framing: null,
                        prompt: null, why: null, options: null, allowFree: null, closing: null,
                      },
                    }),
                  },
                ],
              },
            ],
          }),
        )
      })
    })
    server.listen(0, () => {
      const port = (server.address() as any).port
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close(), calls: () => calls })
    })
  })
}

/** Serves the bundled function over real HTTP, the Node (req, res) way. */
function hostNodeStyle(fn: any): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      Promise.resolve(fn(req, res)).catch(() => {
        if (!res.headersSent) res.writeHead(500).end('crashed')
      })
    })
    server.listen(0, () => {
      const port = (server.address() as any).port
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() })
    })
  })
}

const START = {
  journey: null,
  event: { type: 'start', input: 'Should I get a cat?' },
}

test('the bundled function runs under the Node signature and reaches the model', async () => {
  const openai = await mockOpenAI()
  const bundled = await bundleFunction('api/decision.ts')
  process.env.LOCK_PROVIDER = 'openai'
  process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key-000000000000'
  process.env.OPENAI_BASE_URL = openai.url

  const mod = await import(`file://${bundled}`)
  const host = await hostNodeStyle(mod.default)
  try {
    const res = await fetch(`${host.url}/api/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(START),
    })
    assert.equal(res.status, 200, 'the function must answer 200')
    assert.match(res.headers.get('content-type') ?? '', /json/)
    const turn = await res.json()
    assert.equal(turn.step.kind, 'decision')
    assert.equal(turn.journey.decisions[0].commitment, 'Get the cat.')
    assert.equal(openai.calls(), 1, 'the model must actually have been called')
  } finally {
    host.close(); openai.close()
    delete process.env.OPENAI_BASE_URL; delete process.env.LOCK_PROVIDER
  }
})

test('the bundled function also runs under the Web signature', async () => {
  const openai = await mockOpenAI()
  const bundled = await bundleFunction('api/decision.ts')
  process.env.LOCK_PROVIDER = 'openai'
  process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key-000000000000'
  process.env.OPENAI_BASE_URL = openai.url

  const mod = await import(`file://${bundled}?web`)
  try {
    const res: Response = await mod.default(
      new Request('https://example.com/api/decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(START),
      }),
    )
    assert.ok(res instanceof Response, 'must return a Response for the Web signature')
    assert.equal(res.status, 200)
    const turn = await res.json()
    assert.equal(turn.step.kind, 'decision')
  } finally {
    openai.close()
    delete process.env.OPENAI_BASE_URL; delete process.env.LOCK_PROVIDER
  }
})

test('every failure path still answers JSON, never an HTML error page', async () => {
  const bundled = await bundleFunction('api/decision.ts')
  delete process.env.OPENAI_API_KEY
  delete process.env.LOCK_PROVIDER
  const mod = await import(`file://${bundled}?nokey`)
  const host = await hostNodeStyle(mod.default)
  try {
    // A missing key must be reported, not crash the function.
    const missing = await fetch(`${host.url}/api/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(START),
    })
    assert.match(missing.headers.get('content-type') ?? '', /json/)
    const body = await missing.json()
    assert.equal(body.error.code, 'unconfigured')
    assert.equal(missing.status, 503)

    // A genuinely wrong method still refuses in JSON. (GET is not one: it
    // hands over to the diagnostic, covered separately.)
    const put = await fetch(`${host.url}/api/decision`, { method: 'PUT' })
    assert.equal(put.status, 405)
    assert.match(put.headers.get('content-type') ?? '', /json/)
    assert.equal(put.headers.get('allow'), 'POST')

    // Body that is not JSON at all.
    const junk = await fetch(`${host.url}/api/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    assert.equal(junk.status, 400)
    assert.equal((await junk.json()).error.code, 'bad_request')
  } finally {
    host.close()
  }
})

test('the function reads a body Vercel has already parsed', async () => {
  const openai = await mockOpenAI()
  const bundled = await bundleFunction('api/decision.ts')
  process.env.LOCK_PROVIDER = 'openai'
  process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key-000000000000'
  process.env.OPENAI_BASE_URL = openai.url
  const mod = await import(`file://${bundled}?parsed`)

  const server = createServer((req, res) => {
    // Vercel parses JSON bodies onto req.body and leaves the stream consumed.
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      ;(req as any).body = JSON.parse(Buffer.concat(chunks).toString())
      Promise.resolve(mod.default(req, res)).catch(() => res.writeHead(500).end())
    })
  })
  await new Promise<void>((r) => server.listen(0, r))
  const port = (server.address() as any).port
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(START),
    })
    assert.equal(res.status, 200, 'a pre-parsed body must still be read')
    assert.equal((await res.json()).step.kind, 'decision')
  } finally {
    server.close(); openai.close()
    delete process.env.OPENAI_BASE_URL; delete process.env.LOCK_PROVIDER
  }
})

test('the health endpoint bundles, runs, and never leaks the key', async () => {
  const bundled = await bundleFunction('api/health.ts')
  process.env.LOCK_PROVIDER = 'openai'
  process.env.OPENAI_API_KEY = 'sk-secret-value-that-must-not-appear-1234'
  const mod = await import(`file://${bundled}?health`)
  const host = await hostNodeStyle(mod.default)
  try {
    const res = await fetch(`${host.url}/api/health`)
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.ok(!text.includes('secret-value'), 'the key must never appear in the response')
    const body = JSON.parse(text)
    assert.equal(body.ok, true)
    assert.equal(body.key.present, true)
    assert.equal(body.key.prefix, 'sk-')
    assert.equal(body.key.looksWellFormed, true)
    assert.ok(body.node.startsWith('v'))
  } finally {
    host.close()
  }
})

test('the OpenAI request carries no unsupported strict-schema keywords', async () => {
  const { TURN_JSON_SCHEMA } = await import('../server/ai/schema.js')
  // Strict structured outputs accept only a subset of JSON Schema. A request
  // carrying anything outside it is rejected outright with a 400.
  const banned = ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format', 'default',
                  'minItems', 'maxItems', 'multipleOf', 'uniqueItems']
  const walk = (node: any, path: string) => {
    if (!node || typeof node !== 'object') return
    for (const key of Object.keys(node)) {
      assert.ok(!banned.includes(key), `${path}.${key} is not supported in strict mode`)
      walk(node[key], `${path}.${key}`)
    }
  }
  walk(TURN_JSON_SCHEMA, 'schema')
})

/* ---- the health probe ------------------------------------------------ */

/** Stands in for the provider, answering however the case needs. */
function fakeProvider(handlers: {
  model?: (res: any) => void
  responses?: (res: any) => void
}): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        if (req.url?.startsWith('/models/')) {
          if (handlers.model) return handlers.model(res)
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"gpt-4.1"}')
          return
        }
        if (handlers.responses) return handlers.responses(res)
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"output_text":"{}"}')
      })
    })
    server.listen(0, () => {
      const port = (server.address() as any).port
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() })
    })
  })
}

const probeOnce = async (base: string, key: string, tag: string) => {
  const bundled = await bundleFunction('api/health.ts')
  process.env.LOCK_PROVIDER = 'openai'
  process.env.OPENAI_API_KEY = key
  process.env.OPENAI_BASE_URL = base
  const mod = await import(`file://${bundled}?${tag}`)
  const host = await hostNodeStyle(mod.default)
  try {
    const res = await fetch(`${host.url}/api/health?probe=1`)
    return await res.json()
  } finally {
    host.close()
    delete process.env.OPENAI_BASE_URL; delete process.env.LOCK_PROVIDER
  }
}

test('the probe names an empty account as a billing problem', async () => {
  const p = await fakeProvider({
    responses: (res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: { type: 'insufficient_quota', code: 'insufficient_quota',
                 message: 'You exceeded your current quota' },
      }))
    },
  })
  try {
    const body = await probeOnce(p.url, 'sk-live-key-aaaaaaaaaaaaaaaaaaaaaa', 'quota')
    assert.equal(body.probe.keyAccepted, true, 'the key itself is fine')
    assert.equal(body.probe.canGenerate, false)
    assert.equal(body.probe.verdict, 'quota')
    assert.match(body.probe.advice, /credit|billing/i)
    assert.ok(!JSON.stringify(body).includes('sk-live-key-aaa'))
  } finally { p.close() }
})

test('the probe distinguishes a rejected key from an empty account', async () => {
  const p = await fakeProvider({
    model: (res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'Incorrect API key' } }))
    },
  })
  try {
    const body = await probeOnce(p.url, 'sk-bad-key-bbbbbbbbbbbbbbbbbbbbbb', 'auth')
    assert.equal(body.probe.keyAccepted, false)
    assert.equal(body.probe.verdict, 'auth')
    assert.equal(body.probe.canGenerate, null, 'no point testing credit on a rejected key')
  } finally { p.close() }
})

test('the probe reports a healthy key as ok', async () => {
  const p = await fakeProvider({})
  try {
    const body = await probeOnce(p.url, 'sk-good-key-cccccccccccccccccccccc', 'ok')
    assert.equal(body.probe.verdict, 'ok')
    assert.equal(body.probe.canGenerate, true)
    assert.equal(body.probe.advice, null)
  } finally { p.close() }
})

test('the probe flags a model this account cannot use', async () => {
  const p = await fakeProvider({
    model: (res) => {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'model_not_found', message: 'no such model' } }))
    },
  })
  try {
    const body = await probeOnce(p.url, 'sk-good-key-dddddddddddddddddddddd', 'model')
    assert.equal(body.probe.verdict, 'model_unavailable')
    assert.match(body.probe.advice, /LOCK_MODEL/)
  } finally { p.close() }
})

test('health without ?probe=1 makes no provider call at all', async () => {
  let called = false
  const p = await fakeProvider({
    model: (res) => { called = true; res.writeHead(200).end('{}') },
    responses: (res) => { called = true; res.writeHead(200).end('{}') },
  })
  const bundled = await bundleFunction('api/health.ts')
  process.env.LOCK_PROVIDER = 'openai'
  process.env.OPENAI_API_KEY = 'sk-key-eeeeeeeeeeeeeeeeeeeeeeee'
  process.env.OPENAI_BASE_URL = p.url
  const mod = await import(`file://${bundled}?noprobe`)
  const host = await hostNodeStyle(mod.default)
  try {
    const body = await (await fetch(`${host.url}/api/health`)).json()
    assert.equal(body.probe, null)
    assert.equal(called, false, 'the plain health check must cost nothing')
  } finally {
    host.close(); p.close()
    delete process.env.OPENAI_BASE_URL; delete process.env.LOCK_PROVIDER
  }
})

/* ---- reaching the diagnostic from a browser -------------------------- */

test('a browser gets a readable page; anything else gets JSON', async () => {
  const p = await fakeProvider({})
  const bundled = await bundleFunction('api/health.ts')
  process.env.LOCK_PROVIDER = 'openai'
  process.env.OPENAI_API_KEY = 'sk-page-key-ffffffffffffffffffffff'
  process.env.OPENAI_BASE_URL = p.url
  const mod = await import(`file://${bundled}?page`)
  const host = await hostNodeStyle(mod.default)
  try {
    const page = await fetch(`${host.url}/api/health?probe=1`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    })
    assert.match(page.headers.get('content-type') ?? '', /text\/html/)
    const html = await page.text()
    assert.match(html, /<!doctype html>/i)
    assert.match(html, /deployment diagnostic/i)
    assert.ok(!html.includes('sk-page-key'), 'the key must never reach the page')

    // Machines, and anyone who asks for it, still get JSON.
    const json = await fetch(`${host.url}/api/health?probe=1`)
    assert.match(json.headers.get('content-type') ?? '', /application\/json/)
    assert.equal((await json.json()).probe.verdict, 'ok')

    const forced = await fetch(`${host.url}/api/health?probe=1&format=json`, {
      headers: { accept: 'text/html' },
    })
    assert.match(forced.headers.get('content-type') ?? '', /application\/json/)
  } finally {
    host.close(); p.close()
    delete process.env.OPENAI_BASE_URL; delete process.env.LOCK_PROVIDER
  }
})

test('the rendered page names the fault in words', async () => {
  const p = await fakeProvider({
    responses: (res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'no credit' },
      }))
    },
  })
  const bundled = await bundleFunction('api/health.ts')
  process.env.LOCK_PROVIDER = 'openai'
  process.env.OPENAI_API_KEY = 'sk-quota-key-gggggggggggggggggggg'
  process.env.OPENAI_BASE_URL = p.url
  const mod = await import(`file://${bundled}?quotapage`)
  const host = await hostNodeStyle(mod.default)
  try {
    const html = await (
      await fetch(`${host.url}/api/health?probe=1`, { headers: { accept: 'text/html' } })
    ).text()
    assert.match(html, /quota/i)
    assert.match(html, /credit|billing/i, 'the page must say what to do about it')
    assert.ok(!html.includes('sk-quota-key'))
  } finally {
    host.close(); p.close()
    delete process.env.OPENAI_BASE_URL; delete process.env.LOCK_PROVIDER
  }
})

test('opening /api/decision in a browser hands over to the diagnostic', async () => {
  const bundled = await bundleFunction('api/decision.ts')
  const mod = await import(`file://${bundled}?get`)
  const host = await hostNodeStyle(mod.default)
  try {
    const res = await fetch(`${host.url}/api/decision?probe=1`, { redirect: 'manual' })
    assert.equal(res.status, 302, 'a GET must not dead-end on 405')
    assert.equal(res.headers.get('location'), '/api/health?probe=1')

    // POST is unaffected.
    const post = await fetch(`${host.url}/api/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    assert.equal(post.status, 400)
  } finally {
    host.close()
  }
})
