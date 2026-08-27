import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleVerdict, runVerdict } from '../server/verdict.js'
import { LOCK_SYSTEM_PROMPT, buildVerdictPrompt } from '../server/ai/verdict-prompt.js'
import {
  InvalidVerdictOutput,
  LOCK_ACTIONS,
  LOCK_VERDICTS,
  parseVerdict,
  validateVerdictRequest,
  type LockVerdictResponse,
} from '../shared/verdict.js'
import { ProviderError, type Provider } from '../server/ai/provider.js'

/**
 * The verdict engine, ported from the `lock-ai-logic` backend.
 *
 * The wire contract is the one that deployment published, so these tests are
 * written against that contract rather than against the port — if the port
 * drifts, a client built for the Lovable backend breaks, and that is the thing
 * worth catching.
 */

const COMMITTED: LockVerdictResponse = {
  verdict: 'lock',
  reason: 'The answer states a clear commitment with no remaining conditions.',
  action: 'continue',
  confidence: 0.92,
  next_state: 'confirm_commitment',
  followup: null,
}

const UNCERTAIN: LockVerdictResponse = {
  verdict: 'hold',
  reason: 'The answer is non-committal; the deciding constraint is still unstated.',
  action: 'ask_followup',
  confidence: 0.41,
  next_state: null,
  followup: 'What would have to be true for you to say yes?',
}

/** A provider that answers with whatever the scenario says, once. */
function scripted(reply: (n: number) => unknown) {
  let calls = 0
  const seen: Array<{ system?: string; schema?: string; brief: string }> = []
  const provider: Provider = async (req) => {
    calls++
    seen.push({ system: req.system, schema: req.schema?.name, brief: req.brief })
    const out = reply(calls)
    if (out instanceof Error) throw out
    return out
  }
  return { provider, calls: () => calls, seen }
}

/* ---- the request contract --------------------------------------------- */

test('only `answer` is required, and every documented cap is enforced', () => {
  const ok = validateVerdictRequest({ answer: 'Yes, I will do it.' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.ok && ok.value, { answer: 'Yes, I will do it.' })

  const full = validateVerdictRequest({
    journey: { id: 'j1', state: 'assess_commitment', decision: 'Should I take the contract?' },
    history: [
      { role: 'lock', content: 'How much of next year is committed?' },
      { role: 'user', content: 'About half.' },
    ],
    answer: 'I will take it.',
  })
  assert.equal(full.ok, true)
  assert.equal(full.ok && full.value.history?.length, 2)
  assert.equal(full.ok && full.value.journey?.state, 'assess_commitment')

  const bad = (body: unknown, pattern: RegExp) => {
    const r = validateVerdictRequest(body)
    assert.equal(r.ok, false)
    assert.match(!r.ok ? r.message : '', pattern)
  }

  bad(null, /body/)
  bad({}, /answer/)
  bad({ answer: '' }, /answer.*empty/)
  bad({ answer: 42 }, /answer.*string/)
  bad({ answer: 'x'.repeat(8001) }, /answer.*8000/)
  bad({ answer: 'x', history: 'nope' }, /history.*array/)
  bad({ answer: 'x', history: new Array(51).fill({ role: 'user', content: 'a' }) }, /history.*50/)
  bad({ answer: 'x', history: [{ role: 'bot', content: 'a' }] }, /role/)
  bad({ answer: 'x', history: [{ role: 'user', content: '' }] }, /content/)
  bad({ answer: 'x', history: [{ role: 'user', content: 'a'.repeat(4001) }] }, /4000/)
  bad({ answer: 'x', journey: 'nope' }, /journey.*object/)
  bad({ answer: 'x', journey: { decision: 'd'.repeat(2001) } }, /journey\.decision.*2000/)
})

/* ---- the response contract -------------------------------------------- */

test('the model is never trusted: only a well-formed verdict gets through', () => {
  assert.deepEqual(parseVerdict(COMMITTED), COMMITTED)

  // Every documented value is accepted.
  for (const verdict of LOCK_VERDICTS) {
    assert.equal(parseVerdict({ ...COMMITTED, verdict }).verdict, verdict)
  }
  for (const action of LOCK_ACTIONS) {
    assert.equal(parseVerdict({ ...COMMITTED, action }).action, action)
  }

  // Nulls stay null; blanks become null rather than empty strings.
  const nulled = parseVerdict({ ...COMMITTED, next_state: null, followup: '   ' })
  assert.equal(nulled.next_state, null)
  assert.equal(nulled.followup, null)

  const rejects = (raw: unknown, pattern: RegExp) => {
    try {
      parseVerdict(raw)
      assert.fail(`expected a rejection for ${JSON.stringify(raw).slice(0, 60)}`)
    } catch (err) {
      assert.ok(err instanceof InvalidVerdictOutput)
      assert.match((err as Error).message, pattern)
    }
  }

  rejects(null, /object/)
  rejects('User Safety: safe', /object/)
  rejects({ ...COMMITTED, verdict: 'maybe' }, /verdict/)
  rejects({ ...COMMITTED, action: 'think' }, /action/)
  rejects({ ...COMMITTED, reason: '' }, /reason/)
  rejects({ ...COMMITTED, confidence: '0.9' }, /confidence/)
  rejects({ ...COMMITTED, confidence: 1.4 }, /between 0 and 1/)
  rejects({ ...COMMITTED, confidence: -0.1 }, /between 0 and 1/)
  rejects({ ...COMMITTED, next_state: 12 }, /next_state/)
})

/* ---- the prompt is the behaviour --------------------------------------- */

test('the ported prompt still asks for exactly what the backend asked for', () => {
  assert.match(LOCK_SYSTEM_PROMPT, /You are the decision engine inside Lock/)
  assert.match(LOCK_SYSTEM_PROMPT, /You are NOT a chat assistant/)
  assert.match(LOCK_SYSTEM_PROMPT, /Output the decision object only/)
  assert.match(LOCK_SYSTEM_PROMPT, /User Safety: safe/)
  for (const v of LOCK_VERDICTS) assert.ok(LOCK_SYSTEM_PROMPT.includes(`"${v}"`))
  for (const a of LOCK_ACTIONS) assert.ok(LOCK_SYSTEM_PROMPT.includes(`"${a}"`))

  const prompt = buildVerdictPrompt({
    journey: { id: 'j1', state: 'assess_commitment', decision: 'Take the contract?' },
    history: [
      { role: 'lock', content: 'How committed are you?' },
      { role: 'user', content: 'Fairly.' },
    ],
    answer: 'I will sign on Monday.',
  })
  assert.match(prompt, /journey_id: j1/)
  assert.match(prompt, /current_state: assess_commitment/)
  assert.match(prompt, /LOCK: How committed are you\?/)
  assert.match(prompt, /USER: Fairly\./)
  assert.match(prompt, /I will sign on Monday\./)

  // With nothing supplied the placeholders are the ones the backend used.
  const bare = buildVerdictPrompt({ answer: 'Yes.' })
  assert.match(bare, /journey_id: \(none\)/)
  assert.match(bare, /\(no prior turns\)/)
})

/* ---- one generation, validated ----------------------------------------- */

test('a turn is exactly one generation, sent under the verdict contract', async () => {
  const s = scripted(() => COMMITTED)
  const res = await runVerdict({ answer: 'I am doing it.' }, s.provider)

  assert.equal(res.status, 200)
  assert.deepEqual(res.body, COMMITTED)
  assert.equal(s.calls(), 1, 'one generation per request, never retried')

  // The verdict contract, not the journey-turn contract.
  assert.equal(s.seen[0].schema, 'lock_verdict')
  assert.match(s.seen[0].system ?? '', /decision engine inside Lock/)
  assert.match(s.seen[0].brief, /User's latest answer/)
})

test('a committed answer and an uncertain one drive different flows', async () => {
  const committed = await runVerdict({ answer: 'Yes. I am signing it.' }, scripted(() => COMMITTED).provider)
  assert.equal((committed.body as LockVerdictResponse).action, 'continue')
  assert.equal((committed.body as LockVerdictResponse).verdict, 'lock')

  const uncertain = await runVerdict({ answer: 'I am not sure yet.' }, scripted(() => UNCERTAIN).provider)
  const v = uncertain.body as LockVerdictResponse
  assert.equal(v.action, 'ask_followup')
  assert.equal(v.verdict, 'hold')
  assert.ok(v.followup, 'a follow-up action must carry the question to ask')
  const c = committed.body as LockVerdictResponse
  assert.ok(v.confidence < c.confidence, 'an uncertain answer carries lower confidence')
})

test('every provider failure becomes a documented Lock error code', async () => {
  const cases: Array<[ProviderError, number, string]> = [
    [new ProviderError('no key', 'unconfigured'), 503, 'ai_not_configured'],
    [new ProviderError('rejected', 'auth'), 503, 'ai_not_configured'],
    [new ProviderError('no credit', 'quota'), 402, 'ai_not_configured'],
    [new ProviderError('slow down', 'rate_limited'), 429, 'rate_limited'],
    [new ProviderError('too slow', 'timeout'), 504, 'ai_unavailable'],
    [new ProviderError('gone', 'upstream'), 502, 'ai_unavailable'],
    [new ProviderError('no model', 'model_unavailable'), 502, 'ai_unavailable'],
  ]
  for (const [err, status, code] of cases) {
    const s = scripted(() => err)
    const res = await runVerdict({ answer: 'x' }, s.provider)
    assert.equal(res.status, status, `${err.kind} → ${status}`)
    assert.equal((res.body as any).error.code, code)
    assert.ok((res.body as any).error.message.length > 0)
    assert.equal(s.calls(), 1, 'a failure is never retried')
  }
})

test('output that does not match the schema is invalid_ai_output, never a decision', async () => {
  for (const bad of [
    'User Safety: safe',
    { verdict: 'maybe', reason: 'x', action: 'continue', confidence: 0.5, next_state: null, followup: null },
    { ...COMMITTED, confidence: 4 },
    {},
    null,
  ]) {
    const s = scripted(() => bad)
    const res = await runVerdict({ answer: 'x' }, s.provider)
    assert.equal(res.status, 502)
    assert.equal((res.body as any).error.code, 'invalid_ai_output')
    assert.ok(!('verdict' in (res.body as object)), 'nothing unvalidated may escape')
  }
})

test('an invalid request never reaches the model', async () => {
  const s = scripted(() => COMMITTED)
  const res = await handleVerdict({ answer: '' }, s.provider)
  assert.equal(res.status, 400)
  assert.equal((res.body as any).error.code, 'invalid_request')
  assert.equal(s.calls(), 0, 'a malformed request costs nothing')
})

/* ---- the deployed function --------------------------------------------- */

async function bundled(entry: string, tag: string) {
  const dir = await mkdtemp(join(tmpdir(), 'lock-verdict-'))
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

/** A stand-in OpenRouter that answers with a verdict object. */
function gateway(body: (model: string) => unknown, status = 200) {
  const seen: any[] = []
  return new Promise<{ url: string; close: () => void; seen: any[] }>((resolve) => {
    const s = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => {
        if ((req.url ?? '').endsWith('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({
            data: [{ id: 'google/gemma-4-31b-it:free', pricing: { prompt: '0', completion: '0' },
                     supported_parameters: ['response_format'] }],
          }))
        }
        let parsed: any = {}
        try { parsed = JSON.parse(Buffer.concat(chunks).toString()) } catch { /* ignore */ }
        seen.push(parsed)
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body(parsed.model)))
      })
    })
    s.listen(0, () =>
      resolve({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close(), seen }),
    )
  })
}

const KEY = 'sk-or-v1-' + 'a1b2c3d4'.repeat(8)

test('POST /api/verdict through the real bundle returns a real verdict', async () => {
  const g = await gateway(() => ({
    model: 'google/gemma-4-31b-it:free',
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(UNCERTAIN) } }],
  }))
  const before = { ...process.env }
  process.env.OPENROUTER_API_KEY = KEY
  process.env.OPENROUTER_BASE_URL = `${g.url}/api/v1`
  delete process.env.LOCK_PROVIDER
  delete process.env.LOCK_ALLOWED_ORIGINS
  try {
    const fn = await bundled('api/verdict.ts', 'v-ok')
    const h = await host(fn.default)
    try {
      const res = await fetch(`${h.url}/api/verdict`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          journey: { id: 'j1', state: 'assess_commitment', decision: 'Take the contract?' },
          history: [{ role: 'lock', content: 'How committed are you?' }],
          answer: 'I am really not sure yet.',
        }),
      })
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /json/)
      const body = await res.json()
      assert.deepEqual(body, UNCERTAIN)

      // The generation carried the verdict prompt, not the journey prompt.
      const gen = g.seen.filter((s) => s.messages)
      assert.equal(gen.length, 1, 'one request, one generation')
      assert.match(gen[0].messages[0].content, /decision engine inside Lock/)
      assert.match(gen[0].messages[1].content, /I am really not sure yet\./)

      // No credential in the response, ever.
      assert.ok(!JSON.stringify(body).includes(KEY))

      // Same artifact under the Web signature.
      const web: Response = await fn.default(
        new Request('https://lock.example/api/verdict', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ answer: 'I am really not sure yet.' }),
        }),
      )
      assert.equal(web.status, 200)
      assert.equal((await web.json()).action, 'ask_followup')
    } finally { h.close() }
  } finally {
    g.close()
    process.env = before
  }
})

test('the deployed function answers JSON on every failure path', async () => {
  const g = await gateway(() => ({ error: { code: 429, message: 'Rate limit exceeded' } }), 429)
  const before = { ...process.env }
  process.env.OPENROUTER_API_KEY = KEY
  process.env.OPENROUTER_BASE_URL = `${g.url}/api/v1`
  delete process.env.LOCK_PROVIDER
  try {
    const fn = await bundled('api/verdict.ts', 'v-fail')
    const h = await host(fn.default)
    try {
      // A rate limit becomes the documented code, not a raw provider payload.
      const limited = await fetch(`${h.url}/api/verdict`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: 'Yes.' }),
      })
      assert.equal(limited.status, 429)
      const body = await limited.json()
      assert.equal(body.error.code, 'rate_limited')
      assert.ok(!JSON.stringify(body).includes('Rate limit exceeded'), 'no provider wording leaks')

      // A wrong method, and a body that is not JSON.
      const put = await fetch(`${h.url}/api/verdict`, { method: 'PUT' })
      assert.equal(put.status, 405)
      assert.equal(put.headers.get('allow'), 'POST')
      assert.equal((await put.json()).error.code, 'invalid_request')

      const junk = await fetch(`${h.url}/api/verdict`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      })
      assert.equal(junk.status, 400)
      assert.equal((await junk.json()).error.code, 'invalid_request')

      const empty = await fetch(`${h.url}/api/verdict`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: '' }),
      })
      assert.equal(empty.status, 400)
      assert.equal((await empty.json()).error.code, 'invalid_request')
    } finally { h.close() }
  } finally {
    g.close()
    process.env = before
  }
})

test('CORS is closed unless an origin is explicitly allowed', async () => {
  const g = await gateway(() => ({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(COMMITTED) } }],
  }))
  const before = { ...process.env }
  process.env.OPENROUTER_API_KEY = KEY
  process.env.OPENROUTER_BASE_URL = `${g.url}/api/v1`
  try {
    // Closed by default: Lock's own frontend is same-origin and needs none.
    const closed = await bundled('api/verdict.ts', 'v-cors-closed')
    let h = await host(closed.default)
    let res = await fetch(`${h.url}/api/verdict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ answer: 'Yes.' }),
    })
    assert.equal(res.headers.get('access-control-allow-origin'), null)
    h.close()

    // Opened only for what the deployment names.
    process.env.LOCK_ALLOWED_ORIGINS = 'https://lock.example'
    const open = await bundled('api/verdict.ts', 'v-cors-open')
    h = await host(open.default)
    res = await fetch(`${h.url}/api/verdict`, {
      method: 'OPTIONS',
      headers: { origin: 'https://lock.example' },
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://lock.example')

    res = await fetch(`${h.url}/api/verdict`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    })
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'an unlisted origin gets nothing')
    h.close()
  } finally {
    g.close()
    process.env = before
  }
})

test('the published path from the Lovable deployment still routes here', async () => {
  const vercel = JSON.parse(await readFile('vercel.json', 'utf8'))
  const rewrite = vercel.rewrites.find((r: any) => r.source === '/api/public/decision')
  assert.ok(rewrite, 'the backend’s published path must keep working')
  assert.equal(rewrite.destination, '/api/verdict')
  assert.equal(vercel.functions['api/verdict.ts'].maxDuration, 60)
})

test('no credential and no Lovable dependency came across with the port', async () => {
  const files = ['server/verdict.ts', 'server/ai/verdict-prompt.ts', 'shared/verdict.ts', 'api/verdict.ts']
  for (const f of files) {
    const text = await readFile(f, 'utf8')
    assert.ok(
      !/process\.env[.[]\s*["']?LOVABLE_API_KEY/.test(text),
      `${f} must not read a Lovable credential`,
    )
    assert.ok(!/["'`]https?:\/\/ai\.gateway\.lovable\.dev/.test(text),
      `${f} must not call Lovable's gateway`)
    assert.ok(!/sk-[A-Za-z0-9_-]{16,}/.test(text), `${f} must not contain a key`)
  }
  // And the client never learns of a key or an external backend.
  const client = await readFile('src/lib/verdict.ts', 'utf8')
  assert.ok(!/API_KEY|lovable|Bearer/i.test(client))
  assert.match(client, /'\/api\/verdict'/, 'the browser talks to Lock, not to a third party')

  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  for (const dep of ['ai', '@ai-sdk/openai-compatible', 'zod', '@tanstack/react-start']) {
    assert.ok(!pkg.dependencies?.[dep], `${dep} must not have been dragged in`)
  }
})
