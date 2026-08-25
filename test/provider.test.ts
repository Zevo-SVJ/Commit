import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { createOpenAIProvider, ProviderError } from '../server/ai/provider.js'
import { SYSTEM_PROMPT } from '../server/ai/prompt.js'

/**
 * Exercises the real provider against a local stand-in for the OpenAI
 * Responses API. Everything but the model itself is covered: auth, the
 * structured-output request, and how each failure shape is classified.
 */

function serve(handler: (body: any, res: any) => void): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
        ;(res as any).reqHeaders = req.headers
        ;(res as any).reqUrl = req.url
        handler({ body, headers: req.headers, url: req.url }, res)
      })
    })
    server.listen(0, () => {
      const port = (server.address() as any).port
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() })
    })
  })
}

const okPayload = (obj: unknown) => ({
  output: [{ content: [{ type: 'output_text', text: JSON.stringify(obj) }] }],
})

test('sends a correctly shaped structured-output request', async () => {
  let seen: any = null
  const s = await serve((req, res) => {
    seen = req
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(okPayload({ hello: 'world' })))
  })
  try {
    const provider = createOpenAIProvider({
      OPENAI_API_KEY: 'sk-test-123',
      OPENAI_BASE_URL: s.url,
      LOCK_MODEL: 'gpt-4.1',
    } as NodeJS.ProcessEnv)

    const out = await provider({ brief: 'BRIEF', instruction: 'INSTRUCTION' }, new AbortController().signal)
    assert.deepEqual(out, { hello: 'world' })

    assert.equal(seen.url, '/responses')
    assert.equal(seen.headers.authorization, 'Bearer sk-test-123')
    assert.equal(seen.body.model, 'gpt-4.1')
    // The system prompt goes in `instructions`, so it stays cacheable.
    assert.equal(seen.body.instructions, SYSTEM_PROMPT)
    assert.match(seen.body.input[0].content, /BRIEF[\s\S]*INSTRUCTION/)
    assert.equal(seen.body.text.format.type, 'json_schema')
    assert.equal(seen.body.text.format.strict, true)
    assert.ok(seen.body.text.format.schema.properties.step)
    assert.ok(seen.body.max_output_tokens > 0)
  } finally {
    s.close()
  }
})

test('classifies upstream failures without leaking the key', async () => {
  const cases: Array<[number, string]> = [
    [401, 'unconfigured'],
    [403, 'unconfigured'],
    [429, 'rate_limited'],
    [500, 'upstream'],
  ]
  for (const [status, kind] of cases) {
    const s = await serve((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'nope' } }))
    })
    try {
      const provider = createOpenAIProvider({
        OPENAI_API_KEY: 'sk-secret', OPENAI_BASE_URL: s.url,
      } as NodeJS.ProcessEnv)
      await assert.rejects(
        () => provider({ brief: 'b', instruction: 'i' }, new AbortController().signal),
        (err: unknown) => {
          assert.ok(err instanceof ProviderError)
          assert.equal(err.kind, kind)
          assert.ok(!err.message.includes('sk-secret'))
          return true
        },
        `status ${status}`,
      )
    } finally {
      s.close()
    }
  }
})

test('a missing key never reaches the network', async () => {
  let hit = false
  const s = await serve((_req, res) => { hit = true; res.end('{}') })
  try {
    const provider = createOpenAIProvider({ OPENAI_BASE_URL: s.url } as NodeJS.ProcessEnv)
    await assert.rejects(
      () => provider({ brief: 'b', instruction: 'i' }, new AbortController().signal),
      (err: unknown) => err instanceof ProviderError && err.kind === 'unconfigured',
    )
    assert.equal(hit, false)
  } finally {
    s.close()
  }
})

test('an aborted call is reported as a timeout', async () => {
  const s = await serve(() => { /* never responds */ })
  try {
    const provider = createOpenAIProvider({
      OPENAI_API_KEY: 'k', OPENAI_BASE_URL: s.url,
    } as NodeJS.ProcessEnv)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 60)
    await assert.rejects(
      () => provider({ brief: 'b', instruction: 'i' }, controller.signal),
      (err: unknown) => err instanceof ProviderError && err.kind === 'timeout',
    )
  } finally {
    s.close()
  }
})

test('unparseable model text is an upstream failure, not a crash', async () => {
  const s = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ output_text: 'I cannot comply with that.' }))
  })
  try {
    const provider = createOpenAIProvider({
      OPENAI_API_KEY: 'k', OPENAI_BASE_URL: s.url,
    } as NodeJS.ProcessEnv)
    await assert.rejects(
      () => provider({ brief: 'b', instruction: 'i' }, new AbortController().signal),
      (err: unknown) => err instanceof ProviderError && err.kind === 'upstream',
    )
  } finally {
    s.close()
  }
})
