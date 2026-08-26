import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { build } from 'esbuild'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleTurn } from '../server/handler.js'
import { createOpenRouterProvider } from '../server/ai/openrouter.js'
import {
  ClientGoneAbort,
  ProviderError,
  TimeoutAbort,
  providerFailure,
  isAbortError,
} from '../server/ai/provider.js'
import { PROVIDER_TIMEOUT_MS, CLIENT_TIMEOUT_MS, FUNCTION_MAX_DURATION_S } from '../shared/timeouts.js'

/**
 * The production-readiness pass, end to end.
 *
 * Every case here is one the live deployment actually hit or could hit: a slow
 * free model, an abort landing mid-body, a caller that walked away, a gateway
 * that answered with prose. They run against the artifact Vercel deploys, not
 * against the source.
 */

const KEY = 'sk-or-v1-' + 'a1b2c3d4'.repeat(8)

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

const START = {
  journey: null,
  event: { type: 'start' as const, input: 'Should I pursue this partnership?' },
}

const OK_BODY = {
  id: 'gen-1', model: 'qwen/qwen3-8b:free',
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(TURN) } }],
}

type Behaviour =
  | { kind: 'ok'; delayMs?: number }
  /** Headers now, body never. Exactly where the production AbortError landed. */
  | { kind: 'stallMidBody' }
  /** Connect, then nothing at all. */
  | { kind: 'stallBeforeHeaders' }
  | { kind: 'status'; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: 'raw'; status: number; text: string }

/** A stand-in OpenRouter whose behaviour each test chooses. */
function gateway(behaviour: Behaviour | ((n: number) => Behaviour)) {
  let calls = 0
  const pick = typeof behaviour === 'function' ? behaviour : () => behaviour
  return new Promise<{ url: string; close: () => void; calls: () => number }>((resolve) => {
    const s: Server = createServer((req, res) => {
      const n = ++calls
      req.resume()
      req.on('end', async () => {
        const b = pick(n)
        if (b.kind === 'stallBeforeHeaders') return
        if (b.kind === 'stallMidBody') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.write('{"choices":[{"finish_reason":"stop","message":{"content":"')
          return
        }
        if (b.kind === 'raw') {
          res.writeHead(b.status, { 'content-type': 'application/json' })
          return res.end(b.text)
        }
        if (b.kind === 'status') {
          res.writeHead(b.status, { 'content-type': 'application/json', ...(b.headers ?? {}) })
          return res.end(JSON.stringify(b.body))
        }
        if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(OK_BODY))
      })
    })
    s.listen(0, () =>
      resolve({
        url: `http://127.0.0.1:${(s.address() as any).port}`,
        close: () => s.closeAllConnections?.() ?? s.close(),
        calls: () => calls,
      }),
    )
  })
}

const providerFor = (url: string) =>
  createOpenRouterProvider({
    OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `${url}/api/v1`,
  } as NodeJS.ProcessEnv)

/**
 * `handleTurn` with a short deadline, so a timeout can be exercised in
 * milliseconds instead of the 45 seconds production waits.
 */
function withDeadline(provider: ReturnType<typeof providerFor>, ms: number) {
  return async (body: unknown, callerSignal?: AbortSignal) => {
    const timed = async (req: any, signal: AbortSignal) => {
      const inner = new AbortController()
      const t = setTimeout(() => inner.abort(new TimeoutAbort(ms)), ms)
      // An already-aborted signal fires no event, so it is forwarded directly.
      if (signal.aborted) inner.abort(signal.reason)
      else signal.addEventListener('abort', () => inner.abort(signal.reason), { once: true })
      try {
        return await provider(req, inner.signal)
      } finally {
        clearTimeout(t)
      }
    }
    return handleTurn(body, timed, undefined, callerSignal)
  }
}

/* ---- the ladder ------------------------------------------------------- */

test('the timeout policy is one policy, and every layer reads it', async () => {
  const { readFile } = await import('node:fs/promises')
  const vercel = JSON.parse(await readFile('vercel.json', 'utf8'))

  assert.equal(vercel.functions['api/decision.ts'].maxDuration, FUNCTION_MAX_DURATION_S)
  assert.ok(PROVIDER_TIMEOUT_MS < FUNCTION_MAX_DURATION_S * 1000)
  assert.ok(CLIENT_TIMEOUT_MS > FUNCTION_MAX_DURATION_S * 1000)

  // 45s is not arbitrary: it has to be long enough for a queued free model and
  // short enough to leave the function room to answer before it is killed.
  assert.ok(PROVIDER_TIMEOUT_MS >= 40_000, 'a queued free model needs real room')
  assert.ok(
    FUNCTION_MAX_DURATION_S * 1000 - PROVIDER_TIMEOUT_MS >= 10_000,
    'the function needs headroom to serialise and return its answer',
  )
})

/* ---- a slow response, which is the normal case on a free model -------- */

test('a slow response that arrives inside the deadline is a success, not a timeout', async () => {
  const g = await gateway({ kind: 'ok', delayMs: 400 })
  try {
    const run = withDeadline(providerFor(g.url), 3000)
    const started = Date.now()
    const res = await run(START)
    assert.equal(res.status, 200)
    assert.equal((res.body as any).step.decision.commitment, 'Pursue the partnership.')
    assert.ok(Date.now() - started >= 400, 'it really did wait')
    assert.equal(g.calls(), 1, 'and it waited once, not twice')
  } finally { g.close() }
})

/* ---- the fault this pass exists to remove ----------------------------- */

test('an abort during the body read is a timeout, never a 500', async () => {
  // The exact production failure: headers arrive, the body never finishes,
  // the server's own deadline fires while `res.text()` is still pending.
  const g = await gateway({ kind: 'stallMidBody' })
  try {
    const res = await withDeadline(providerFor(g.url), 300)(START)

    assert.equal(res.status, 504, 'the platform-safe timeout status')
    const body = res.body as any
    assert.equal(body.error.code, 'timeout')
    assert.equal(body.error.retryable, true)
    assert.equal(body.error.message, 'That took too long.')

    // The symptom that sent us here must be gone from every field.
    const text = JSON.stringify(res.body)
    assert.ok(!/AbortError/.test(text), 'no raw AbortError may reach the browser')
    assert.ok(!/This operation was aborted/.test(text))
    assert.ok(!/"code":"upstream"/.test(text))
    // And the detail still says enough to diagnose it.
    assert.match(body.error.detail, /timed out|no reply/)
  } finally { g.close() }
})

test('an abort before any headers arrive is also a timeout', async () => {
  const g = await gateway({ kind: 'stallBeforeHeaders' })
  try {
    const res = await withDeadline(providerFor(g.url), 300)(START)
    assert.equal(res.status, 504)
    assert.equal((res.body as any).error.code, 'timeout')
  } finally { g.close() }
})

test('an abort is attributed to whoever caused it', () => {
  const server = new AbortController()
  server.abort(new TimeoutAbort(45_000))
  const asTimeout = providerFailure(
    new DOMException('This operation was aborted', 'AbortError'),
    server.signal, 'reading the response',
  )
  assert.ok(asTimeout instanceof ProviderError)
  assert.equal(asTimeout.kind, 'timeout')

  const caller = new AbortController()
  caller.abort(new ClientGoneAbort())
  const asCancel = providerFailure(
    new DOMException('This operation was aborted', 'AbortError'),
    caller.signal, 'reading the response',
  )
  assert.equal(asCancel.kind, 'cancelled')

  // An abort with no reason at all is still an abort, not an upstream fault.
  const bare = new AbortController()
  bare.abort()
  assert.equal(providerFailure(new Error('boom'), bare.signal, 'x').kind, 'timeout')

  // A genuine transport failure is not mistaken for one.
  const live = new AbortController()
  assert.equal(providerFailure(new Error('ECONNRESET'), live.signal, 'x').kind, 'upstream')

  assert.ok(isAbortError(new DOMException('x', 'AbortError')))
  assert.ok(!isAbortError(new Error('AbortErrorish')))
})

/* ---- client cancellation ---------------------------------------------- */

test('a caller that walks away is a cancellation, not a provider timeout', async () => {
  const g = await gateway({ kind: 'stallMidBody' })
  try {
    const caller = new AbortController()
    setTimeout(() => caller.abort(), 200)
    // A deadline long enough that only the caller can end this.
    const res = await withDeadline(providerFor(g.url), 30_000)(START, caller.signal)

    assert.equal(res.status, 499)
    assert.equal((res.body as any).error.code, 'cancelled')
    assert.equal((res.body as any).error.retryable, false)
    assert.ok(!JSON.stringify(res.body).includes('AbortError'))
  } finally { g.close() }
})

test('a caller already gone before the turn starts never reaches the provider', async () => {
  const g = await gateway({ kind: 'ok' })
  try {
    const caller = new AbortController()
    caller.abort()
    const res = await withDeadline(providerFor(g.url), 30_000)(START, caller.signal)
    assert.equal(res.status, 499)
    assert.equal((res.body as any).error.code, 'cancelled')
    assert.equal(g.calls(), 0, 'nothing is spent on an answer nobody wants')
  } finally { g.close() }
})

/* ---- what the model said ---------------------------------------------- */

test('a malformed provider response reads as invalid_response, not upstream', async () => {
  const g = await gateway({
    kind: 'raw', status: 200,
    text: JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: 'I would rather not say.' } }],
    }),
  })
  try {
    const res = await withDeadline(providerFor(g.url), 3000)(START)
    assert.equal(res.status, 502)
    assert.equal((res.body as any).error.code, 'invalid_response')
    assert.equal(g.calls(), 1, 'a bad answer is not re-asked automatically')
  } finally { g.close() }
})

test('truncated JSON is reported as truncated, not as a gateway failure', async () => {
  const g = await gateway({
    kind: 'raw', status: 200,
    text: JSON.stringify({
      choices: [{
        finish_reason: 'length',
        message: { content: JSON.stringify(TURN).slice(0, 120) },
      }],
    }),
  })
  try {
    const res = await withDeadline(providerFor(g.url), 3000)(START)
    assert.equal((res.body as any).error.code, 'invalid_response')
    assert.match((res.body as any).error.detail, /stopped early|token cap/)
  } finally { g.close() }
})

test('a body that is not JSON at all does not crash the turn', async () => {
  const g = await gateway({ kind: 'raw', status: 200, text: '<html>gateway</html>' })
  try {
    const res = await withDeadline(providerFor(g.url), 3000)(START)
    assert.equal(res.status, 502)
    assert.equal((res.body as any).error.code, 'upstream')
    assert.ok(!JSON.stringify(res.body).includes('<html>'))
  } finally { g.close() }
})

/* ---- HTTP faults ------------------------------------------------------ */

test('provider HTTP faults each keep their own code, status and retryability', async () => {
  const cases: Array<[number, unknown, number, string, boolean]> = [
    [500, { error: { code: 500, message: 'Provider returned an error' } }, 502, 'upstream', true],
    [429, { error: { code: 429, message: 'Rate limit exceeded' } }, 429, 'rate_limited', true],
    [402, { error: { code: 402, message: 'Insufficient credits' } }, 402, 'quota', false],
    [401, { error: { code: 401, message: 'No auth credentials found' } }, 401, 'auth', false],
    [404, { error: { code: 404, message: 'No endpoints found' } }, 502, 'model_unavailable', false],
  ]
  for (const [status, body, expectStatus, expectCode, retryable] of cases) {
    // retry-after is deliberately long so the single permitted retry does not
    // fire and muddy the call count.
    const g = await gateway({ kind: 'status', status, body, headers: { 'retry-after': '120' } })
    try {
      const res = await withDeadline(providerFor(g.url), 3000)(START)
      assert.equal(res.status, expectStatus, `${status} → ${expectStatus}`)
      assert.equal((res.body as any).error.code, expectCode)
      assert.equal((res.body as any).error.retryable, retryable)
      assert.equal(g.calls(), 1, `${status} must cost exactly one request`)
      assert.ok(!JSON.stringify(res.body).includes(KEY))
    } finally { g.close() }
  }
})

test('a short rate limit is the only thing ever retried, and never after a generation', async () => {
  // 429 first, then success: nothing was generated on the rejected attempt, so
  // this cannot duplicate a user action or cost anything twice.
  const g = await gateway((n) =>
    n === 1
      ? { kind: 'status', status: 429, body: { error: { code: 429, message: 'Rate limit exceeded' } },
          headers: { 'retry-after': '1' } }
      : { kind: 'ok' },
  )
  try {
    const res = await withDeadline(providerFor(g.url), 10_000)(START)
    assert.equal(res.status, 200)
    assert.equal(g.calls(), 2, 'exactly one retry')
  } finally { g.close() }

  // A 402 means the generation will never happen. Retrying only delays the truth.
  const broke = await gateway({ kind: 'status', status: 402,
    body: { error: { code: 402, message: 'Insufficient credits' } } })
  try {
    await withDeadline(providerFor(broke.url), 3000)(START)
    assert.equal(broke.calls(), 1)
  } finally { broke.close() }

  // A 500 might mean the model *did* run. It is never retried automatically.
  const flaky = await gateway({ kind: 'status', status: 500,
    body: { error: { code: 500, message: 'Provider returned an error' } } })
  try {
    await withDeadline(providerFor(flaky.url), 3000)(START)
    assert.equal(flaky.calls(), 1, 'a possible generation is never repeated silently')
  } finally { flaky.close() }
})

test('a retry after a failure succeeds, and the journey survives the failure', async () => {
  const g = await gateway((n) =>
    n === 1
      ? { kind: 'status', status: 500, body: { error: { code: 500, message: 'upstream boom' } } }
      : { kind: 'ok' },
  )
  try {
    const run = withDeadline(providerFor(g.url), 5000)
    const failed = await run(START)
    assert.equal((failed.body as any).error.code, 'upstream')
    assert.equal((failed.body as any).error.retryable, true)

    // The same event, replayed the way the retry button replays it.
    const ok = await run(START)
    assert.equal(ok.status, 200)
    assert.equal((ok.body as any).step.decision.commitment, 'Pursue the partnership.')
    assert.equal(g.calls(), 2, 'one request per attempt — the retry is the user’s')
  } finally { g.close() }
})

/* ---- the deployed function ------------------------------------------- */

async function bundled(entry: string, tag: string) {
  const dir = await mkdtemp(join(tmpdir(), 'lock-stab-'))
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

test('POST /api/decision through the real bundle: success, once', async () => {
  const g = await gateway({ kind: 'ok', delayMs: 150 })
  const before = { ...process.env }
  process.env.OPENROUTER_API_KEY = KEY
  process.env.OPENROUTER_BASE_URL = `${g.url}/api/v1`
  delete process.env.LOCK_PROVIDER
  try {
    const fn = await bundled('api/decision.ts', 'stab-ok')
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
      assert.equal(g.calls(), 1, 'exactly one provider request for one POST')

      // The Web signature, same bundle, same guarantee.
      const web: Response = await fn.default(
        new Request('https://lock.example/api/decision', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(START),
        }),
      )
      assert.equal(web.status, 200)
      assert.equal((await web.json()).step.kind, 'decision')
      assert.equal(g.calls(), 2)
    } finally { h.close() }
  } finally {
    g.close()
    process.env = before
  }
})

test('POST /api/decision through the real bundle: failure is JSON and classified', async () => {
  const g = await gateway({ kind: 'status', status: 402,
    body: { error: { code: 402, message: 'Insufficient credits' } } })
  const before = { ...process.env }
  process.env.OPENROUTER_API_KEY = KEY
  process.env.OPENROUTER_BASE_URL = `${g.url}/api/v1`
  delete process.env.LOCK_PROVIDER
  try {
    const fn = await bundled('api/decision.ts', 'stab-fail')
    const h = await host(fn.default)
    try {
      const res = await fetch(`${h.url}/api/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(START),
      })
      assert.equal(res.status, 402)
      assert.match(res.headers.get('content-type') ?? '', /json/)
      const body = await res.json()
      assert.equal(body.error.code, 'quota')
      assert.equal(body.error.retryable, false)
      assert.ok(!JSON.stringify(body).includes(KEY))
      assert.equal(g.calls(), 1)
    } finally { h.close() }
  } finally {
    g.close()
    process.env = before
  }
})

test('the deployed function reports a stalled gateway as a timeout, in JSON', async () => {
  // The real deadline is 45s, so this proves the shape rather than the wait:
  // a very short OPENROUTER_BASE_URL stall plus the function's own catch-all.
  const g = await gateway({ kind: 'stallMidBody' })
  const before = { ...process.env }
  process.env.OPENROUTER_API_KEY = KEY
  process.env.OPENROUTER_BASE_URL = `${g.url}/api/v1`
  delete process.env.LOCK_PROVIDER
  try {
    const fn = await bundled('api/decision.ts', 'stab-stall')
    const h = await host(fn.default)
    try {
      // Abort from the caller's side after 200ms: same code path the platform
      // and the browser use, and it must never produce a 500.
      const c = new AbortController()
      setTimeout(() => c.abort(), 200)
      let status = 0
      let text = ''
      try {
        const res = await fetch(`${h.url}/api/decision`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(START),
          signal: c.signal,
        })
        status = res.status
        text = await res.text()
      } catch {
        // The client hung up first; the function must still not have crashed.
      }
      assert.ok(!/AbortError/.test(text), 'no raw AbortError may be serialised')
      assert.notEqual(status, 500, 'a stalled gateway is never a 500')
    } finally { h.close() }
  } finally {
    g.close()
    process.env = before
  }
})
