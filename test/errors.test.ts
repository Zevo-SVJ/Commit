import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { classifyProviderError, createOpenAIProvider } from '../server/ai/openai.js'
import { ProviderError } from '../server/ai/provider.js'
import { handleTurn } from '../server/handler.js'

/**
 * HTTP 429 from OpenAI means two unrelated things, and the difference decides
 * what the user should do. These lock that distinction down.
 */

const headers = (h: Record<string, string> = {}) => ({
  get: (n: string) => h[n.toLowerCase()] ?? null,
})

/* ---- the real envelopes -------------------------------------------- */

test('429 with insufficient_quota is a billing fault, not a rate limit', () => {
  // Verbatim shape OpenAI returns for a project with no credit.
  const body = JSON.stringify({
    error: {
      message: 'You exceeded your current quota, please check your plan and billing details.',
      type: 'insufficient_quota',
      param: null,
      code: 'insufficient_quota',
    },
  })
  const err = classifyProviderError(429, body, headers({ 'x-request-id': 'req_abc123' }))
  assert.equal(err.kind, 'quota')
  assert.equal(err.providerCode, 'insufficient_quota')
  assert.equal(err.requestId, 'req_abc123')
})

test('429 with rate_limit_exceeded is a genuine rate limit', () => {
  const body = JSON.stringify({
    error: {
      message: 'Rate limit reached for gpt-4.1 in organization org-x on requests per min (RPM).',
      type: 'requests',
      code: 'rate_limit_exceeded',
    },
  })
  const err = classifyProviderError(429, body, headers({ 'retry-after': '2' }))
  assert.equal(err.kind, 'rate_limited')
  assert.equal(err.retryAfter, 2)
})

test('the remaining provider faults are each their own kind', () => {
  const cases: Array<[number, string, string, string]> = [
    [401, 'invalid_api_key', 'Incorrect API key provided: sk-abc***', 'auth'],
    [403, 'unsupported_country', 'Country not supported', 'auth'],
    [404, 'model_not_found', 'The model `gpt-9` does not exist', 'model_unavailable'],
    [400, 'invalid_request_error', 'Invalid schema for response_format', 'bad_request'],
    [500, 'server_error', 'The server had an error', 'upstream'],
    [503, 'engine_overloaded', 'That model is currently overloaded', 'upstream'],
  ]
  for (const [status, code, message, kind] of cases) {
    const err = classifyProviderError(status, JSON.stringify({ error: { code, message } }), headers())
    assert.equal(err.kind, kind, `${status} ${code}`)
  }
})

test('a non-JSON provider body still classifies by status', () => {
  const err = classifyProviderError(429, '<html>Too Many Requests</html>', headers())
  assert.equal(err.kind, 'rate_limited')
})

/* ---- what the user is told ----------------------------------------- */

const failWith = async (err: ProviderError) =>
  handleTurn(
    { journey: null, event: { type: 'start', input: 'x' } },
    async () => {
      throw err
    },
  )

test('an empty account is never described as "give it a moment"', async () => {
  const res = await failWith(
    new ProviderError('quota exhausted', 'quota', {
      status: 429, providerCode: 'insufficient_quota', requestId: 'req_1',
    }),
  )
  const body = res.body as any
  assert.equal(res.status, 402)
  assert.equal(body.error.code, 'quota')
  assert.equal(body.error.retryable, false, 'retrying an empty account is pointless')
  assert.match(body.error.message, /out of credit/i)
  assert.doesNotMatch(body.error.message, /moment|too many/i)
  assert.match(body.error.detail, /insufficient_quota/)
})

test('a genuine rate limit is retryable and says how long', async () => {
  const res = await failWith(
    new ProviderError('rate limited', 'rate_limited', { status: 429, retryAfter: 3 }),
  )
  const body = res.body as any
  assert.equal(res.status, 429)
  assert.equal(body.error.retryable, true)
  assert.match(body.error.message, /3s/)
})

test('each fault reaches the user as its own code and message', async () => {
  const expected: Array<[ProviderError, number, string, boolean]> = [
    [new ProviderError('x', 'auth', { status: 401 }), 401, 'auth', false],
    [new ProviderError('x', 'model_unavailable', { status: 404 }), 502, 'model_unavailable', false],
    [new ProviderError('x', 'bad_request', { status: 400 }), 502, 'model_request_rejected', false],
    [new ProviderError('x', 'timeout'), 504, 'timeout', true],
    [new ProviderError('x', 'upstream', { status: 500 }), 502, 'upstream', true],
    [new ProviderError('x', 'unconfigured'), 503, 'unconfigured', false],
  ]
  const seen = new Set<string>()
  for (const [err, status, code, retryable] of expected) {
    const res = await failWith(err)
    const body = res.body as any
    assert.equal(res.status, status, code)
    assert.equal(body.error.code, code)
    assert.equal(body.error.retryable, retryable, code)
    assert.ok(!seen.has(body.error.message), `"${body.error.message}" is not distinct`)
    seen.add(body.error.message)
  }
})

test('no provider message reaching the browser can carry a key', async () => {
  const res = await failWith(
    new ProviderError(
      'Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwxyz123456',
      'auth',
      { status: 401 },
    ),
  )
  const serialised = JSON.stringify(res.body)
  assert.ok(!/sk-proj-abcdef/.test(serialised), 'the key must be scrubbed')
  assert.ok(serialised.includes('sk-***') || !serialised.includes('sk-'), serialised)
})

/* ---- retry behaviour ------------------------------------------------ */

function limitedServer(opts: { failures: number; retryAfter?: string; quota?: boolean }) {
  let hits = 0
  return new Promise<{ url: string; close: () => void; hits: () => number }>((resolve) => {
    const server: Server = createServer((req, res) => {
      hits++
      req.resume()
      req.on('end', () => {
        if (hits <= opts.failures) {
          const h: Record<string, string> = { 'content-type': 'application/json' }
          if (opts.retryAfter) h['retry-after'] = opts.retryAfter
          res.writeHead(429, h)
          res.end(
            JSON.stringify({
              error: opts.quota
                ? { type: 'insufficient_quota', code: 'insufficient_quota', message: 'quota' }
                : { type: 'requests', code: 'rate_limit_exceeded', message: 'slow down' },
            }),
          )
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ output_text: '{"ok":true}' }))
      })
    })
    server.listen(0, () => {
      const port = (server.address() as any).port
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close(), hits: () => hits })
    })
  })
}

test('a brief rate limit is waited out exactly once', async () => {
  const s = await limitedServer({ failures: 1, retryAfter: '1' })
  try {
    const provider = createOpenAIProvider({
      OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: s.url,
    } as NodeJS.ProcessEnv)
    const out = await provider({ brief: 'b', instruction: 'i' }, new AbortController().signal)
    assert.deepEqual(out, { ok: true })
    assert.equal(s.hits(), 2, 'exactly one retry, not a loop')
  } finally {
    s.close()
  }
})

test('quota is never retried', async () => {
  const s = await limitedServer({ failures: 99, quota: true })
  try {
    const provider = createOpenAIProvider({
      OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: s.url,
    } as NodeJS.ProcessEnv)
    await assert.rejects(
      () => provider({ brief: 'b', instruction: 'i' }, new AbortController().signal),
      (e: unknown) => e instanceof ProviderError && e.kind === 'quota',
    )
    assert.equal(s.hits(), 1, 'an empty account must not be retried even once')
  } finally {
    s.close()
  }
})

test('a long back-off is reported rather than waited out', async () => {
  const s = await limitedServer({ failures: 99, retryAfter: '60' })
  try {
    const provider = createOpenAIProvider({
      OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: s.url,
    } as NodeJS.ProcessEnv)
    const started = Date.now()
    await assert.rejects(
      () => provider({ brief: 'b', instruction: 'i' }, new AbortController().signal),
      (e: unknown) => e instanceof ProviderError && e.kind === 'rate_limited' && e.retryAfter === 60,
    )
    assert.ok(Date.now() - started < 2000, 'must not sit waiting a minute inside the function')
    assert.equal(s.hits(), 1)
  } finally {
    s.close()
  }
})
