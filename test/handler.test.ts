import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleTurn, buildBrief } from '../server/handler.ts'
import { parseTurn, InvalidModelOutput } from '../server/ai/schema.ts'
import { extractJson, ProviderError, type Provider } from '../server/ai/provider.ts'
import type { DecisionJourney, TurnResponse } from '../shared/types.ts'

/** A provider that returns whatever the test hands it. No model involved. */
const scripted = (value: unknown): Provider => async () => value

const ok = (over: Record<string, unknown> = {}) => ({
  title: 'The Halden partnership',
  understanding: {
    objective: 'Decide whether the partnership is worth its terms',
    known: ['EUR 120k for nine months', 'Exclusivity is the live cost'],
    openQuestions: [],
    criticalUnknown: 'What exclusivity blocks',
    contradiction: null,
  },
  progress: 0.5,
  confidence: 0.7,
  step: {
    kind: 'decision',
    question: 'Should I pursue the partnership?',
    commitment: 'Pursue the partnership.',
    rationale: 'The risk sits in the terms, not the relationship.',
    isFinal: false,
    importance: 'pivotal',
    framing: 'The money is settled. Exclusivity is not.',
    prompt: null, why: null, options: null, allowFree: null, closing: null,
  },
  ...over,
})

const body = (r: { status: number; body: unknown }) => r.body as TurnResponse

test('start turn builds a journey and a pending decision', async () => {
  const res = await handleTurn(
    { journey: null, event: { type: 'start', input: 'Should I pursue this partnership?' } },
    scripted(ok()),
  )
  assert.equal(res.status, 200)
  const b = body(res)
  assert.equal(b.step.kind, 'decision')
  assert.equal(b.journey.originalSituation, 'Should I pursue this partnership?')
  assert.equal(b.journey.decisions.length, 1)
  assert.equal(b.journey.decisions[0].status, 'pending')
  assert.equal(b.journey.status, 'active')
})

test('confirmation is recorded by the server, not by the model', async () => {
  const start = body(
    await handleTurn(
      { journey: null, event: { type: 'start', input: 'partnership' } },
      scripted(ok()),
    ),
  )
  const id = start.journey.decisions[0].id

  // The model replies with a *question*, i.e. it says nothing about the
  // confirmation. The confirmation must survive anyway.
  const next = body(
    await handleTurn(
      { journey: start.journey, event: { type: 'confirm', decisionId: id } },
      scripted(
        ok({
          step: {
            kind: 'question', prompt: 'Which term would you walk away over?',
            why: 'Determines what to open the negotiation on.',
            options: ['Exclusivity', 'Payment'], allowFree: true, framing: null,
            question: null, commitment: null, rationale: null, isFinal: null,
            importance: null, closing: null,
          },
        }),
      ),
    ),
  )
  const confirmed = next.journey.decisions.find((d) => d.id === id)
  assert.equal(confirmed?.status, 'confirmed')
  assert.ok(typeof confirmed?.confirmedAt === 'number')
  assert.equal(next.step.kind, 'question')
})

test('a user-raised decision is attributed to the user', async () => {
  const start = body(
    await handleTurn({ journey: null, event: { type: 'start', input: 'partnership' } }, scripted(ok())),
  )
  const next = body(
    await handleTurn(
      { journey: start.journey, event: { type: 'addDecision', text: 'Whether I trust them' } },
      scripted(ok()),
    ),
  )
  assert.equal(next.journey.decisions.at(-1)?.source, 'user')
})

test('completion closes the journey and pins progress', async () => {
  const start = body(
    await handleTurn({ journey: null, event: { type: 'start', input: 'cat' } }, scripted(ok())),
  )
  const done = body(
    await handleTurn(
      { journey: start.journey, event: { type: 'confirm', decisionId: start.journey.decisions[0].id } },
      scripted(
        ok({
          progress: 0.4,
          step: {
            kind: 'complete', closing: 'You know what you are doing.',
            prompt: null, why: null, options: null, allowFree: null, question: null,
            commitment: null, rationale: null, isFinal: null, importance: null, framing: null,
          },
        }),
      ),
    ),
  )
  assert.equal(done.journey.status, 'complete')
  assert.equal(done.journey.progress, 1)
  assert.equal(done.journey.decisions.every((d) => d.status === 'confirmed'), true)
})

test('progress may fall when new information lands', async () => {
  const start = body(
    await handleTurn({ journey: null, event: { type: 'start', input: 'x' } }, scripted(ok({ progress: 0.8 }))),
  )
  const next = body(
    await handleTurn(
      { journey: start.journey, event: { type: 'answer', text: 'they also want the IP' } },
      scripted(ok({ progress: 0.55 })),
    ),
  )
  assert.ok(next.journey.progress < start.journey.progress)
})

/* ---- the anti-chatbot guards -------------------------------------- */

test('acknowledgement framing is stripped rather than shown', () => {
  for (const framing of [
    'Got it, you want the partnership.',
    'That makes sense.',
    'So you are saying the money matters most.',
    'It sounds like exclusivity worries you.',
    'Thanks for confirming.',
  ]) {
    const turn = parseTurn(ok({ step: { ...ok().step, framing } }), 0.1)
    assert.equal(turn.step.kind === 'decision' && turn.step.framing, null, framing)
  }
})

test('genuine framing survives', () => {
  const turn = parseTurn(ok(), 0.1)
  assert.equal(
    turn.step.kind === 'decision' && turn.step.framing,
    'The money is settled. Exclusivity is not.',
  )
})

test('a question with no stated consequence is rejected', () => {
  assert.throws(
    () =>
      parseTurn(
        ok({
          step: { kind: 'question', prompt: 'How do you feel?', why: null, options: [], allowFree: true, framing: null,
                  question: null, commitment: null, rationale: null, isFinal: null, importance: null, closing: null },
        }),
        0.1,
      ),
    InvalidModelOutput,
  )
})

/* ---- failure handling ---------------------------------------------- */

test('a missing key is reported as unconfigured, not as a crash', async () => {
  const res = await handleTurn(
    { journey: null, event: { type: 'start', input: 'x' } },
    async () => { throw new ProviderError('no key', 'unconfigured') },
  )
  assert.equal(res.status, 503)
  assert.equal((res.body as any).error.code, 'unconfigured')
  assert.equal((res.body as any).error.retryable, false)
})

test('rate limits and timeouts are retryable, and leak nothing', async () => {
  for (const [kind, status] of [['rate_limited', 429], ['timeout', 504], ['upstream', 502]] as const) {
    const res = await handleTurn(
      { journey: null, event: { type: 'start', input: 'x' } },
      async () => { throw new ProviderError('sk-secret-leaked-detail', kind) },
    )
    assert.equal(res.status, status)
    assert.equal((res.body as any).error.retryable, true)
    assert.ok(!JSON.stringify(res.body).includes('sk-secret'))
  }
})

test('malformed model output becomes a clean retryable error', async () => {
  for (const junk of [null, 'not json', {}, { step: { kind: 'nonsense' } }, { step: { kind: 'decision' } }]) {
    const res = await handleTurn(
      { journey: null, event: { type: 'start', input: 'x' } },
      scripted(junk),
    )
    assert.equal(res.status, 502)
    assert.equal((res.body as any).error.code, 'invalid_response')
  }
})

test('bad requests are refused before any model call', async () => {
  let called = false
  const spy: Provider = async () => { called = true; return ok() }
  for (const bad of [
    null,
    { event: { type: 'nope' } },
    { journey: null, event: { type: 'start', input: '   ' } },
    { journey: null, event: { type: 'answer', text: 'x' } },       // no journey
    { journey: null, event: { type: 'start', input: 'x'.repeat(5000) } },
  ]) {
    const res = await handleTurn(bad, spy)
    assert.equal(res.status, 400, JSON.stringify(bad))
  }
  assert.equal(called, false, 'no model call should be made for invalid input')
})

/* ---- the brief ------------------------------------------------------ */

test('the brief carries conclusions, never a transcript', async () => {
  const journey: DecisionJourney = {
    id: 'j', originalSituation: 'the original words', title: 't',
    understanding: {
      objective: 'obj', known: ['k1'], openQuestions: ['o1'],
      criticalUnknown: 'cu', contradiction: 'contra',
    },
    exchanges: [{ question: 'How much of next year is committed?', answer: 'About half' }],
    decisions: [{
      id: 'd1', question: 'q', commitment: 'Pursue it.', rationale: 'r', context: null,
      source: 'lock', status: 'confirmed', importance: 'standard', isFinal: false,
      createdAt: 0, confirmedAt: 1,
    }],
    currentDecisionId: null,
    nextStep: '',
    progress: 0.5, confidence: 0.6, status: 'active', createdAt: 0, updatedAt: 0,
  }
  const brief = buildBrief(journey, { type: 'answer', text: 'newest answer' })
  assert.ok(brief.includes('the original words'))
  assert.ok(brief.includes('k1') && brief.includes('cu') && brief.includes('contra'))
  assert.ok(brief.includes('CONFIRMED'))
  // The turn's own text is delivered via the instruction, not the brief.
  assert.ok(!brief.includes('newest answer'))
  // Already-asked questions travel verbatim so they cannot be asked twice.
  assert.ok(brief.includes('How much of next year is committed?'))
  assert.ok(brief.includes('About half'))
  assert.ok(/ALREADY ASKED/.test(brief))
})

test('answers are recorded verbatim and bound the prompt', async () => {
  let journey = body(
    await handleTurn({ journey: null, event: { type: 'start', input: 'x' } }, scripted(ok())),
  ).journey
  // Far more turns than the cap, to prove the list cannot grow without limit.
  for (let i = 0; i < 14; i++) {
    journey = body(
      await handleTurn(
        { journey, event: { type: 'answer', text: `answer ${i}`, question: `question ${i}` } },
        scripted(ok()),
      ),
    ).journey
  }
  assert.equal(journey.exchanges.length, 10)
  // The oldest are dropped, the most recent kept.
  assert.equal(journey.exchanges[0].answer, 'answer 4')
  assert.equal(journey.exchanges.at(-1)?.answer, 'answer 13')
})

test('a contradiction is surfaced once, then not repeated', async () => {
  const withContradiction = (c: string | null) =>
    ok({ understanding: { ...ok().understanding, contradiction: c } })

  const first = body(
    await handleTurn(
      { journey: null, event: { type: 'start', input: 'x' } },
      scripted(withContradiction('The money is attractive but the exclusivity changes it.')),
    ),
  )
  assert.equal(
    first.step.kind === 'decision' && first.step.contradiction,
    'The money is attractive but the exclusivity changes it.',
    'a new contradiction must reach the user',
  )

  // Same contradiction next turn: already said, so it must not be shown again.
  const second = body(
    await handleTurn(
      { journey: first.journey, event: { type: 'answer', text: 'ok' } },
      scripted(withContradiction('The money is attractive but the exclusivity changes it.')),
    ),
  )
  assert.equal(second.step.kind === 'decision' && second.step.contradiction, null)

  // A genuinely different one is surfaced.
  const third = body(
    await handleTurn(
      { journey: second.journey, event: { type: 'answer', text: 'ok' } },
      scripted(withContradiction('You said speed matters, but you have waited three weeks.')),
    ),
  )
  assert.equal(
    third.step.kind === 'decision' && third.step.contradiction,
    'You said speed matters, but you have waited three weeks.',
  )
})

test('the journey is self-contained: current decision and next step', async () => {
  const start = body(
    await handleTurn({ journey: null, event: { type: 'start', input: 'x' } }, scripted(ok())),
  )
  assert.equal(start.journey.currentDecisionId, start.journey.decisions[0].id)
  assert.match(start.journey.nextStep, /Awaiting confirmation/)

  const done = body(
    await handleTurn(
      { journey: start.journey, event: { type: 'confirm', decisionId: start.journey.decisions[0].id } },
      scripted(ok({ step: { ...ok().step, kind: 'complete', closing: 'Done.' } })),
    ),
  )
  assert.equal(done.journey.currentDecisionId, null)
  assert.match(done.journey.nextStep, /complete/i)
})

test('response payloads are unwrapped from either Responses API shape', () => {
  assert.deepEqual(extractJson({ output_text: '{"a":1}' }), { a: 1 })
  assert.deepEqual(
    extractJson({ output: [{ content: [{ type: 'output_text', text: '{"b":2}' }] }] }),
    { b: 2 },
  )
  assert.deepEqual(
    extractJson({ output: [{ content: [{ type: 'output_json', json: { c: 3 } }] }] }),
    { c: 3 },
  )
  assert.throws(() => extractJson({ output: [] }), ProviderError)
})

/* ---- the confirmation sequence -------------------------------------- */

test('the confirmation sequence is designed to run 1.2-1.8s', async () => {
  const { CONFIRM, CONFIRM_REDUCED, confirmTotal } = await import('../src/lib/timing.ts')
  const total = confirmTotal(CONFIRM)
  assert.ok(total >= 1200 && total <= 1800, `${total}ms`)
  // Every phase must be long enough to be perceived as its own beat.
  for (const [name, ms] of Object.entries(CONFIRM)) {
    assert.ok(ms >= 140, `${name} is ${ms}ms — too short to register`)
  }
  // The message must be legible at full opacity, not merely fading in.
  const { messageDwell } = await import('../src/lib/timing.ts')
  assert.ok(
    CONFIRM.message - CONFIRM.messageFade >= 400,
    `only ${CONFIRM.message - CONFIRM.messageFade}ms at full opacity`,
  )
  assert.ok(messageDwell(CONFIRM) >= 600, `${messageDwell(CONFIRM)}ms legible`)
  // Reduced motion shortens the movement but still lets the line be read.
  assert.ok(confirmTotal(CONFIRM_REDUCED) < total)
  assert.ok(
    CONFIRM_REDUCED.message - CONFIRM_REDUCED.messageFade >= 400,
    'reduced motion must stay readable',
  )
})
