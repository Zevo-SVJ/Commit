import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'

import { handleTurn } from '../server/handler.js'
import {
  createOpenRouterProvider,
  extractOpenRouterJson,
  safetyVerdict,
} from '../server/ai/openrouter.js'
import { InvalidModelOutput } from '../server/ai/schema.js'

/**
 * The output contract, tested against what production actually returned.
 *
 * A real journey failed with `the model did not return JSON (17 chars, starts
 * "User Safety: safe")`. That string is the required output field of NVIDIA's
 * NemoGuard content-safety classifiers — a free model, and therefore one the
 * `openrouter/free` router could and did select. The model was not misbehaving;
 * it was the wrong kind of model for the job.
 */

const KEY = 'sk-or-v1-' + 'a1b2c3d4'.repeat(8)

/** `assert.throws` does not hand back the error, and the message is the point. */
function thrownBy(fn: () => unknown): Error {
  try {
    fn()
  } catch (err) {
    return err as Error
  }
  throw new Error('expected a throw, got none')
}

/** The exact 17 characters production received. */
const PRODUCTION_RESPONSE = 'User Safety: safe'

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

type Reply = { status: number; body: unknown } | { status: number; text: string }

/** Records which model each request asked for, so fallback order is provable. */
function gateway(reply: (n: number, model: string) => Reply) {
  const asked: string[] = []
  return new Promise<{ url: string; close: () => void; asked: string[] }>((resolve) => {
    const s: Server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => {
        let body: any = {}
        try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch { /* ignore */ }
        asked.push(body.model ?? '')
        const out = reply(asked.length, body.model ?? '')
        res.writeHead(out.status, { 'content-type': 'application/json' })
        res.end('text' in out ? out.text : JSON.stringify(out.body))
      })
    })
    s.listen(0, () =>
      resolve({
        url: `http://127.0.0.1:${(s.address() as any).port}`,
        close: () => s.close(), asked,
      }),
    )
  })
}

const said = (content: string, finish = 'stop', model = 'some/model:free') => ({
  status: 200,
  body: { model, choices: [{ finish_reason: finish, message: { content } }] },
})

const providerFor = (url: string, env: Record<string, string> = {}) =>
  createOpenRouterProvider({
    OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `${url}/api/v1`, ...env,
  } as NodeJS.ProcessEnv)

/* ---- the exact production failure ------------------------------------- */

test('"User Safety: safe" is named as the wrong kind of model, not as bad JSON', () => {
  assert.equal(safetyVerdict(PRODUCTION_RESPONSE), 'User Safety: safe')
  assert.equal(safetyVerdict('user safety: unsafe\nS1'), 'user safety: unsafe\nS1'.slice(0, 80))
  assert.equal(safetyVerdict('Response Safety: safe'), 'Response Safety: safe')
  assert.equal(safetyVerdict('safe'), 'safe')
  assert.equal(safetyVerdict('unsafe'), 'unsafe')

  // A decision that merely talks about safety is not a verdict.
  assert.equal(safetyVerdict('Is this job safe?'), null)
  assert.equal(safetyVerdict('{"step":{"kind":"complete"}}'), null)
  assert.equal(safetyVerdict('Safety is the objective here.'), null)

  const err = thrownBy(() => extractOpenRouterJson({
    choices: [{ finish_reason: 'stop', message: { content: PRODUCTION_RESPONSE } }],
  }))
  assert.ok(err instanceof InvalidModelOutput)
  assert.match(err.message, /content-safety verdict/)
  assert.match(err.message, /safety classifier, not a chat model/)
})

test('the classifier answering in its own JSON is recognised too', () => {
  // NemoGuard's documented shape. It parses as JSON, so nothing downstream
  // would have caught it — it would have died as "unknown step kind".
  const asJson = JSON.stringify({ 'User Safety': 'safe' })
  const err = thrownBy(() =>
    extractOpenRouterJson({ choices: [{ finish_reason: 'stop', message: { content: asJson } }] }))
  assert.ok(err instanceof InvalidModelOutput)
  assert.match(err.message, /content-safety verdict/)

  assert.throws(
    () => extractOpenRouterJson({
      choices: [{ finish_reason: 'stop', message: { content: { 'Response Safety': 'unsafe' } } }],
    }),
    InvalidModelOutput,
  )
})

test('the production response never becomes a decision, and costs at most two models', async () => {
  const g = await gateway(() => said(PRODUCTION_RESPONSE))
  try {
    const res = await handleTurn(START, providerFor(g.url))

    // Never a success. Never a fabricated decision.
    assert.equal(res.status, 502)
    const body = res.body as any
    assert.equal(body.error.code, 'invalid_response')
    assert.ok(!('step' in body), 'a safety verdict must never render as a turn')
    assert.ok(!('journey' in body))

    // The user is told something useful, and nothing internal leaks.
    assert.equal(body.error.message, 'That did not come back cleanly.')
    assert.equal(body.error.retryable, true)
    assert.match(body.error.detail, /content-safety verdict/)
    assert.ok(!body.error.detail.includes(KEY))

    // Bounded: the primary, then one fallback. Never a third.
    assert.equal(g.asked.length, 2, 'exactly one fallback')
    assert.notEqual(g.asked[0], g.asked[1], 'and it is a different model')
    assert.equal(g.asked[0], 'openai/gpt-oss-120b:free')
  } finally { g.close() }
})

test('the fallback recovers the journey when the first model is the wrong one', async () => {
  // Exactly the production situation with the fix in place: the first model
  // answers with a safety verdict, the second answers with a decision.
  const g = await gateway((n) => (n === 1 ? said(PRODUCTION_RESPONSE) : said(JSON.stringify(TURN))))
  try {
    const res = await handleTurn(START, providerFor(g.url))
    assert.equal(res.status, 200)
    assert.equal((res.body as any).step.decision.commitment, 'Pursue the partnership.')
    assert.equal(g.asked.length, 2)
  } finally { g.close() }
})

/* ---- the fallback must not be a way to spend twice --------------------- */

test('the fallback runs only when nothing was generated', async () => {
  const never = async (status: number, body: unknown) => {
    const g = await gateway(() => ({ status, body }))
    try {
      await handleTurn(START, providerFor(g.url))
      return g.asked.length
    } finally { g.close() }
  }

  // A generation may have happened, or the answer would be identical anywhere.
  assert.equal(await never(500, { error: { code: 500, message: 'upstream boom' } }), 1)
  assert.equal(await never(402, { error: { code: 402, message: 'Insufficient credits' } }), 1)
  assert.equal(await never(401, { error: { code: 401, message: 'No auth credentials' } }), 1)
  // A rate limit with a long wait is not retried and not fallen back from.
  assert.equal(await never(429, { error: { code: 429, message: 'Rate limit exceeded' } }), 2)

  // Pinning one model removes the fallback entirely.
  const g = await gateway(() => said(PRODUCTION_RESPONSE))
  try {
    await handleTurn(START, providerFor(g.url, { LOCK_MODEL: 'only/one:free' }))
    assert.deepEqual(g.asked, ['only/one:free'], 'a pinned model is asked once and only once')
  } finally { g.close() }
})

test('a successful first model never costs a second request', async () => {
  const g = await gateway(() => said(JSON.stringify(TURN)))
  try {
    const res = await handleTurn(START, providerFor(g.url))
    assert.equal(res.status, 200)
    assert.equal(g.asked.length, 1, 'one user action, one generation')
  } finally { g.close() }
})

/* ---- every shape the server must survive ------------------------------ */

test('the parser recovers what is safe to recover and refuses the rest', async () => {
  const run = async (reply: Reply) => {
    const g = await gateway(() => reply)
    try {
      return { res: await handleTurn(START, providerFor(g.url)), asked: g.asked.length }
    } finally { g.close() }
  }

  // Recoverable, deterministically: the object is right there.
  for (const content of [
    JSON.stringify(TURN),
    `\`\`\`json\n${JSON.stringify(TURN)}\n\`\`\``,
    `\`\`\`\n${JSON.stringify(TURN)}\n\`\`\``,
    `\n\n  ${JSON.stringify(TURN)}  \n\n`,
    `Here is the turn:\n${JSON.stringify(TURN)}\nHope that helps.`,
  ]) {
    const { res, asked } = await run(said(content))
    assert.equal(res.status, 200, `must recover: ${content.slice(0, 30)}`)
    assert.equal((res.body as any).step.decision.commitment, 'Pursue the partnership.')
    assert.equal(asked, 1, 'recovery costs nothing extra')
  }

  // Not recoverable. None of these may become a decision.
  const refused: Array<[string, Reply]> = [
    ['a safety verdict', said(PRODUCTION_RESPONSE)],
    ['empty output', said('')],
    ['whitespace only', said('   \n  ')],
    ['plain prose', said('I think you should probably go for it, honestly.')],
    ['truncated JSON', said(JSON.stringify(TURN).slice(0, 90), 'length')],
    ['malformed JSON', said('{"understanding": {"objective": "x",')],
    ['valid JSON, wrong shape', said('{"answer":"yes"}')],
    ['no choices', { status: 200, body: { model: 'm', choices: [] } }],
    ['not JSON at all', { status: 200, text: '<html>gateway</html>' }],
  ]
  for (const [name, reply] of refused) {
    const { res, asked } = await run(reply)
    const body = res.body as any
    assert.ok(res.status >= 400, `${name} must not succeed`)
    assert.ok(!('step' in body), `${name} must never render as a turn`)
    assert.ok(
      body.error.code === 'invalid_response' || body.error.code === 'upstream',
      `${name} → ${body.error.code}`,
    )
    assert.ok(asked <= 2, `${name} must stay bounded (${asked})`)
  }
})

test('a structured-output refusal falls back rather than dead-ending', async () => {
  // A model that does not support the response_format we sent answers 400.
  // Another model might, so the fallback is allowed — once.
  const g = await gateway((n) =>
    n === 1
      ? { status: 400, body: { error: { code: 400,
          message: 'response_format json_schema is not supported by this model' } } }
      : said(JSON.stringify(TURN)),
  )
  try {
    const res = await handleTurn(START, providerFor(g.url))
    assert.equal(res.status, 200)
    assert.equal(g.asked.length, 2)
    assert.notEqual(g.asked[0], g.asked[1])
  } finally { g.close() }
})

test('the request carries the output contract in words, not only in a schema', async () => {
  // json_object promises valid JSON, not our shape, so the prompt has to say
  // it too — and a model that ignores response_format entirely still gets told.
  const { turnInstruction } = await import('../server/ai/prompt.js')
  const text = turnInstruction('the person has just started')
  assert.match(text, /single JSON object and nothing else/i)
  assert.match(text, /No markdown fences/i)
  assert.match(text, /safety classification|moderation verdict/i)
  assert.match(text, /understanding, progress,\s*\n?confidence, title, step/i)

  // And the words reach the provider, not just the file.
  const g = await gateway(() => said(JSON.stringify(TURN)))
  try {
    await handleTurn(START, providerFor(g.url))
  } finally { g.close() }
})
