/**
 * The structured output contract with the model, plus a hand-written validator.
 *
 * The JSON schema is what the model is constrained to. The validator is what we
 * actually trust: structured outputs can still be disabled, degraded, or
 * returned by a proxy, so nothing reaches the client until it has passed
 * through `parseTurn` here.
 */

export type ModelStepKind = 'question' | 'decision' | 'complete'

export interface ModelTurn {
  understanding: {
    objective: string
    known: string[]
    openQuestions: string[]
    criticalUnknown: string | null
    contradiction: string | null
  }
  progress: number
  confidence: number
  title: string
  step:
    | {
        kind: 'question'
        prompt: string
        /** Internal. Names what a different answer would change. Never shown. */
        why: string
        options: string[]
        allowFree: boolean
        framing: string | null
      }
    | {
        kind: 'decision'
        question: string
        commitment: string
        rationale: string
        isFinal: boolean
        importance: 'pivotal' | 'standard'
        framing: string | null
      }
    | { kind: 'complete'; closing: string }
}

/** Sent to the provider as a strict json_schema response format. */
export const TURN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['understanding', 'progress', 'confidence', 'title', 'step'],
  properties: {
    title: {
      type: 'string',
      description: 'Six words or fewer naming this journey. Not a sentence.',
    },
    understanding: {
      type: 'object',
      additionalProperties: false,
      required: ['objective', 'known', 'openQuestions', 'criticalUnknown', 'contradiction'],
      properties: {
        objective: { type: 'string' },
        known: { type: 'array', items: { type: 'string' } },
        openQuestions: { type: 'array', items: { type: 'string' } },
        criticalUnknown: { type: ['string', 'null'] },
        contradiction: { type: ['string', 'null'] },
      },
    },
    progress: { type: 'number', minimum: 0, maximum: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    step: {
      type: 'object',
      additionalProperties: false,
      required: [
        'kind',
        'prompt',
        'why',
        'options',
        'allowFree',
        'question',
        'commitment',
        'rationale',
        'isFinal',
        'importance',
        'closing',
        'framing',
      ],
      properties: {
        kind: { type: 'string', enum: ['question', 'decision', 'complete'] },
        // Only meaningful when kind is "question".
        prompt: { type: ['string', 'null'] },
        why: { type: ['string', 'null'] },
        options: { type: ['array', 'null'], items: { type: 'string' } },
        allowFree: { type: ['boolean', 'null'] },
        // Only meaningful when kind is "decision".
        question: { type: ['string', 'null'] },
        commitment: { type: ['string', 'null'] },
        rationale: { type: ['string', 'null'] },
        isFinal: { type: ['boolean', 'null'] },
        importance: { type: ['string', 'null'], enum: ['pivotal', 'standard', null] },
        // Only meaningful when kind is "complete".
        closing: { type: ['string', 'null'] },
        framing: { type: ['string', 'null'] },
      },
    },
  },
} as const

export class InvalidModelOutput extends Error {}

/* ---- primitives --------------------------------------------------- */

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null

const strArray = (v: unknown, cap: number): string[] =>
  Array.isArray(v)
    ? v.map(str).filter((s): s is string => s !== null).slice(0, cap)
    : []

const unit = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback

/**
 * Phrases that mean the model slipped into assistant mode. A framing line made
 * only of acknowledgement carries no information, so it is dropped rather than
 * shown — the prompt forbids it, and this is the net underneath.
 */
const ACKNOWLEDGEMENT =
  /^(ok(ay)?|got it|thanks?|thank you|understood|i see|i understand|that makes sense|makes sense|sure|right|noted|good|great|perfect|excellent|of course|absolutely)\b/i

const RESTATEMENT = /^(so|so,|it sounds like|it seems like|you('re| are) saying|to summari[sz]e|in other words|if i understand)\b/i

/** A framing line only survives if it could be new information. */
function cleanFraming(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  if (ACKNOWLEDGEMENT.test(s) || RESTATEMENT.test(s)) return null
  // One sentence of framing. Anything longer is the model narrating.
  if (s.length > 240) return null
  return s
}

/* ---- the parser ---------------------------------------------------- */

export function parseTurn(raw: unknown, previousProgress: number): ModelTurn {
  if (!raw || typeof raw !== 'object') {
    throw new InvalidModelOutput('response was not an object')
  }
  const r = raw as Record<string, unknown>
  const u = (r.understanding ?? {}) as Record<string, unknown>
  const s = (r.step ?? {}) as Record<string, unknown>

  const kind = str(s.kind)
  if (kind !== 'question' && kind !== 'decision' && kind !== 'complete') {
    throw new InvalidModelOutput(`unknown step kind: ${String(s.kind)}`)
  }

  const understanding = {
    objective: str(u.objective) ?? '',
    known: strArray(u.known, 12),
    openQuestions: strArray(u.openQuestions, 8),
    criticalUnknown: str(u.criticalUnknown),
    contradiction: str(u.contradiction),
  }

  const base = {
    understanding,
    progress: unit(r.progress, previousProgress),
    confidence: unit(r.confidence, 0.5),
    title: str(r.title) ?? '',
  }

  if (kind === 'question') {
    const prompt = str(s.prompt)
    if (!prompt) throw new InvalidModelOutput('question step has no prompt')
    // A question with no stated consequence is a question that should not have
    // been asked. Rather than show it, treat the turn as unusable.
    if (!str(s.why)) throw new InvalidModelOutput('question step has no justification')
    return {
      ...base,
      step: {
        kind: 'question',
        prompt,
        why: str(s.why)!,
        options: strArray(s.options, 4),
        allowFree: s.allowFree !== false,
        framing: cleanFraming(s.framing),
      },
    }
  }

  if (kind === 'decision') {
    const question = str(s.question)
    const commitment = str(s.commitment)
    if (!question || !commitment) {
      throw new InvalidModelOutput('decision step is missing question or commitment')
    }
    const importance = str(s.importance)
    return {
      ...base,
      step: {
        kind: 'decision',
        question,
        commitment,
        rationale: str(s.rationale) ?? '',
        isFinal: s.isFinal === true,
        importance: importance === 'pivotal' ? 'pivotal' : 'standard',
        framing: cleanFraming(s.framing),
      },
    }
  }

  return {
    ...base,
    progress: 1,
    step: { kind: 'complete', closing: str(s.closing) ?? 'Decision complete.' },
  }
}
