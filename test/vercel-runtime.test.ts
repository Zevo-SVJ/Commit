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
    delete process.env.OPENAI_BASE_URL
  }
})

test('the bundled function also runs under the Web signature', async () => {
  const openai = await mockOpenAI()
  const bundled = await bundleFunction('api/decision.ts')
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
    delete process.env.OPENAI_BASE_URL
  }
})

test('every failure path still answers JSON, never an HTML error page', async () => {
  const bundled = await bundleFunction('api/decision.ts')
  delete process.env.OPENAI_API_KEY
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

    // Wrong method.
    const get = await fetch(`${host.url}/api/decision`)
    assert.equal(get.status, 405)
    assert.match(get.headers.get('content-type') ?? '', /json/)

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
    delete process.env.OPENAI_BASE_URL
  }
})

test('the health endpoint bundles, runs, and never leaks the key', async () => {
  const bundled = await bundleFunction('api/health.ts')
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
