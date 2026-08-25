import type {
  ApiErrorCode,
  Decision,
  DecisionJourney,
  Exchange,
  Step,
  TurnEvent,
  TurnRequest,
  TurnResponse,
} from '../shared/types.ts'
import { turnInstruction } from './ai/prompt.ts'
import { createOpenAIProvider, ProviderError, type Provider } from './ai/provider.ts'
import { InvalidModelOutput, parseTurn, type ModelTurn } from './ai/schema.ts'

/**
 * The host-agnostic core. Every adapter (Vercel, Node, the Vite dev server)
 * calls exactly this, so there is one implementation of the product's logic and
 * the deployment target is a detail.
 */

const TIMEOUT_MS = 30_000
const MAX_INPUT = 4000
/** Enough to stop a question repeating; bounded so the prompt cannot grow without limit. */
const MAX_EXCHANGES = 10

export interface HandlerResult {
  status: number
  body: TurnResponse | { error: { code: ApiErrorCode; message: string; retryable: boolean } }
}

const fail = (
  status: number,
  code: ApiErrorCode,
  message: string,
  retryable: boolean,
): HandlerResult => ({ status, body: { error: { code, message, retryable } } })

const uid = (p: string) =>
  `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/* ------------------------------------------------------------------ */
/* The brief — the journey, compressed into what the model needs        */
/* ------------------------------------------------------------------ */

/**
 * Deliberately not a transcript. The model is given its own prior conclusions
 * rather than the raw conversation, which is what keeps the journey from
 * growing unboundedly and what makes it compress as it goes.
 */
export function buildBrief(journey: DecisionJourney | null, event: TurnEvent): string {
  if (!journey) {
    const input = event.type === 'start' ? event.input : ''
    return `The person has brought this:\n\n"""${input}"""\n\nNothing else is known yet.`
  }

  const u = journey.understanding
  const lines: string[] = [
    `Original situation, in their words:\n"""${journey.originalSituation}"""`,
    ``,
    `What you have established so far:`,
    `- Objective: ${u.objective || '(not yet established)'}`,
  ]

  if (u.known.length) lines.push(`- Known: ${u.known.join('; ')}`)
  if (u.openQuestions.length) lines.push(`- Still open: ${u.openQuestions.join('; ')}`)
  if (u.criticalUnknown) lines.push(`- Critical unknown: ${u.criticalUnknown}`)
  if (u.contradiction) lines.push(`- Tension you already raised: ${u.contradiction}`)

  // Verbatim, so a question is never asked twice and nothing the user said is
  // lost when the compressed notes above are rewritten.
  if (journey.exchanges.length) {
    lines.push('', 'Questions you have ALREADY ASKED, and their exact answers.')
    lines.push('Never ask any of these again, in any wording:')
    for (const e of journey.exchanges) {
      lines.push(`- You asked: "${e.question}" -> They said: "${e.answer}"`)
    }
  }

  if (journey.decisions.length) {
    lines.push('', 'Decisions in this journey:')
    for (const d of journey.decisions) {
      const state = d.status === 'confirmed' ? 'CONFIRMED by the user' : 'pending'
      const who = d.source === 'user' ? ', raised by the user' : ''
      lines.push(`- "${d.commitment}" (${state}${who})`)
    }
  }

  lines.push('', `Journey progress: ${journey.progress.toFixed(2)}. Confidence: ${journey.confidence.toFixed(2)}.`)
  return lines.join('\n')
}

function describeEvent(event: TurnEvent): string {
  switch (event.type) {
    case 'start':
      return 'They have just described their situation. Find the decision in it. If you already have enough to name the decision, present it rather than asking anything.'
    case 'answer':
      return `They answered your question:\n"""${event.text}"""\nDo not restate this. Fold it into what you know and move the decision forward.`
    case 'confirm':
      return 'They have just physically confirmed the pending decision by sliding. Do not acknowledge or restate it. Determine whether anything meaningful is still unresolved: if not, complete the journey.'
    case 'addDecision':
      return `They have raised a decision of their own:\n"""${event.text}"""\nThis becomes the next decision, ahead of whatever you were planning. Present it.`
  }
}

/* ------------------------------------------------------------------ */
/* Merging the model's turn back into the journey                       */
/* ------------------------------------------------------------------ */

function applyTurn(
  previous: DecisionJourney | null,
  event: TurnEvent,
  turn: ModelTurn,
  now: number,
): TurnResponse {
  const originalSituation =
    previous?.originalSituation ?? (event.type === 'start' ? event.input : '')

  // Confirmations are recorded by the server, not by the model: the user's
  // gesture is ground truth and must not depend on the model echoing it back.
  let decisions: Decision[] = (previous?.decisions ?? []).map((d) =>
    event.type === 'confirm' && d.id === event.decisionId && d.status !== 'confirmed'
      ? { ...d, status: 'confirmed' as const, confirmedAt: now }
      : d,
  )

  // A contradiction is shown the first time it appears and not repeated after.
  const previousContradiction = previous?.understanding.contradiction ?? null
  const contradiction =
    turn.understanding.contradiction && turn.understanding.contradiction !== previousContradiction
      ? turn.understanding.contradiction
      : null

  const exchanges: Exchange[] =
    event.type === 'answer' && event.question
      ? [...(previous?.exchanges ?? []), { question: event.question, answer: event.text }].slice(
          -MAX_EXCHANGES,
        )
      : (previous?.exchanges ?? [])

  let step: Step

  if (turn.step.kind === 'decision') {
    const s = turn.step
    const decision: Decision = {
      id: uid('dec'),
      question: s.question,
      commitment: s.commitment,
      rationale: s.rationale,
      context: turn.understanding.criticalUnknown,
      source: event.type === 'addDecision' ? 'user' : 'lock',
      status: 'pending',
      importance: s.importance,
      isFinal: s.isFinal,
      createdAt: now,
      confirmedAt: null,
    }
    // Only one decision is ever pending: a new one replaces any stale proposal.
    decisions = [...decisions.filter((d) => d.status === 'confirmed'), decision]
    step = { kind: 'decision', decision, framing: s.framing, contradiction }
  } else if (turn.step.kind === 'question') {
    const s = turn.step
    decisions = decisions.filter((d) => d.status === 'confirmed')
    step = {
      kind: 'question',
      id: uid('q'),
      prompt: s.prompt,
      framing: s.framing,
      contradiction,
      options: s.options,
      allowFree: s.allowFree,
    }
  } else {
    decisions = decisions.filter((d) => d.status === 'confirmed')
    step = { kind: 'complete', closing: turn.step.closing }
  }

  const complete = step.kind === 'complete'

  const pending = decisions.find((d) => d.status === 'pending') ?? null

  const journey: DecisionJourney = {
    id: previous?.id ?? uid('jny'),
    originalSituation,
    title: turn.title || previous?.title || 'Untitled decision',
    understanding: turn.understanding,
    exchanges,
    decisions,
    currentDecisionId: pending?.id ?? null,
    nextStep:
      step.kind === 'decision'
        ? `Awaiting confirmation of: ${step.decision.commitment}`
        : step.kind === 'question'
          ? `Awaiting an answer to: ${step.prompt}`
          : 'Journey complete.',
    progress: complete ? 1 : turn.progress,
    confidence: turn.confidence,
    status: complete ? 'complete' : 'active',
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }

  return { journey, step }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

function validRequest(body: unknown): TurnRequest | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const event = b.event as TurnEvent | undefined
  if (!event || typeof event !== 'object') return null

  switch (event.type) {
    case 'start':
    case 'answer':
    case 'addDecision':
      if (typeof (event as { text?: unknown; input?: unknown }).text !== 'string' &&
          typeof (event as { input?: unknown }).input !== 'string') return null
      break
    case 'confirm':
      if (typeof event.decisionId !== 'string') return null
      break
    default:
      return null
  }
  if (event.type !== 'start' && !b.journey) return null
  return { journey: (b.journey as DecisionJourney) ?? null, event }
}

export async function handleTurn(
  body: unknown,
  provider: Provider = createOpenAIProvider(),
  now: number = Date.now(),
): Promise<HandlerResult> {
  const req = validRequest(body)
  if (!req) return fail(400, 'bad_request', 'That request could not be read.', false)

  // Bound anything that reaches a paid API and a prompt.
  const text =
    req.event.type === 'start'
      ? req.event.input
      : req.event.type === 'answer' || req.event.type === 'addDecision'
        ? req.event.text
        : ''
  if (text.length > MAX_INPUT) {
    return fail(400, 'bad_request', 'That is longer than LOCK can take in one go.', false)
  }
  if (req.event.type === 'start' && text.trim().length === 0) {
    return fail(400, 'bad_request', 'Say what you are deciding first.', false)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const raw = await provider(
      {
        brief: buildBrief(req.journey, req.event),
        instruction: turnInstruction(describeEvent(req.event)),
      },
      controller.signal,
    )
    const turn = parseTurn(raw, req.journey?.progress ?? 0.1)
    return { status: 200, body: applyTurn(req.journey, req.event, turn, now) }
  } catch (err) {
    if (err instanceof InvalidModelOutput) {
      console.error('[lock] invalid model output:', err.message)
      return fail(502, 'invalid_response', 'That did not come back cleanly.', true)
    }
    if (err instanceof ProviderError) {
      console.error('[lock] provider error:', err.message)
      switch (err.kind) {
        case 'unconfigured':
          return fail(503, 'unconfigured', 'LOCK is not connected to a model yet.', false)
        case 'rate_limited':
          return fail(429, 'rate_limited', 'Too many requests. Give it a moment.', true)
        case 'timeout':
          return fail(504, 'timeout', 'That took too long.', true)
        default:
          return fail(502, 'upstream', 'Something went wrong.', true)
      }
    }
    console.error('[lock] unexpected error:', err)
    return fail(500, 'upstream', 'Something went wrong.', true)
  } finally {
    clearTimeout(timer)
  }
}
