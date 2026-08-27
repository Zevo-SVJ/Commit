/**
 * The Lock verdict contract.
 *
 * Ported from the `lock-ai-logic` backend (`src/lib/lock-schema.ts`), which
 * defined it with zod. Lock's server and client share this file directly and
 * Lock deliberately carries no schema-library dependency — the validator below
 * enforces exactly what the zod schema enforced, so the wire format is
 * unchanged and a client written against the Lovable deployment still works.
 *
 * This is a different question from the one `shared/types.ts` answers. A turn
 * produces the next *step* of a journey — a question to ask or a decision to
 * commit to. A verdict judges one answer: is it usable, and should the journey
 * move. They compose; neither replaces the other.
 */

export const LOCK_VERDICTS = ['lock', 'unlock', 'hold', 'reject'] as const
export const LOCK_ACTIONS = ['continue', 'ask_followup', 'finalize', 'abort'] as const

export type LockVerdict = (typeof LOCK_VERDICTS)[number]
export type LockAction = (typeof LOCK_ACTIONS)[number]

export interface LockHistoryMessage {
  role: 'user' | 'lock'
  content: string
}

export interface LockJourneyContext {
  id?: string
  state?: string
  decision?: string
}

export interface LockVerdictRequest {
  journey?: LockJourneyContext
  history?: LockHistoryMessage[]
  /** The only strictly required field. */
  answer: string
}

export interface LockVerdictResponse {
  verdict: LockVerdict
  reason: string
  action: LockAction
  confidence: number
  next_state: string | null
  followup: string | null
}

export const LOCK_ERROR_CODES = [
  'invalid_request',
  'ai_unavailable',
  'ai_not_configured',
  'invalid_ai_output',
  'rate_limited',
  'internal_error',
] as const

export type LockErrorCode = (typeof LOCK_ERROR_CODES)[number]

export interface LockErrorBody {
  error: { code: LockErrorCode; message: string }
}

export const lockError = (code: LockErrorCode, message: string): LockErrorBody => ({
  error: { code, message },
})

/* ---- limits, matching the original zod schema exactly ----------------- */

const MAX_ANSWER = 8000
const MAX_HISTORY = 50
const MAX_CONTENT = 4000
const MAX_ID = 200
const MAX_DECISION = 2000
const MAX_REASON = 1000
const MAX_FOLLOWUP = 1000

export class InvalidVerdictOutput extends Error {}

/* ---- request validation ------------------------------------------------ */

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/**
 * Validates an incoming request. Returns the reason it is invalid, or null.
 * Deliberately returns a message rather than throwing: the endpoint reports it
 * as `invalid_request`, which is what the original backend did.
 */
export function validateVerdictRequest(
  body: unknown,
): { ok: true; value: LockVerdictRequest } | { ok: false; message: string } {
  if (!body || typeof body !== 'object') return { ok: false, message: 'body: expected an object' }
  const b = body as Record<string, unknown>

  const answer = str(b.answer)
  if (answer === null) return { ok: false, message: 'answer: expected a string' }
  if (answer.length < 1) return { ok: false, message: 'answer: must not be empty' }
  if (answer.length > MAX_ANSWER) {
    return { ok: false, message: `answer: must be at most ${MAX_ANSWER} characters` }
  }

  const value: LockVerdictRequest = { answer }

  if (b.journey !== undefined) {
    if (!b.journey || typeof b.journey !== 'object') {
      return { ok: false, message: 'journey: expected an object' }
    }
    const j = b.journey as Record<string, unknown>
    const journey: LockJourneyContext = {}
    for (const [key, cap] of [
      ['id', MAX_ID],
      ['state', MAX_ID],
      ['decision', MAX_DECISION],
    ] as const) {
      if (j[key] === undefined) continue
      const v = str(j[key])
      if (v === null) return { ok: false, message: `journey.${key}: expected a string` }
      if (v.length > cap) {
        return { ok: false, message: `journey.${key}: must be at most ${cap} characters` }
      }
      journey[key] = v
    }
    value.journey = journey
  }

  if (b.history !== undefined) {
    if (!Array.isArray(b.history)) return { ok: false, message: 'history: expected an array' }
    if (b.history.length > MAX_HISTORY) {
      return { ok: false, message: `history: must contain at most ${MAX_HISTORY} messages` }
    }
    const history: LockHistoryMessage[] = []
    for (let i = 0; i < b.history.length; i++) {
      const m = b.history[i] as Record<string, unknown>
      if (!m || typeof m !== 'object') {
        return { ok: false, message: `history.${i}: expected an object` }
      }
      const role = str(m.role)
      if (role !== 'user' && role !== 'lock') {
        return { ok: false, message: `history.${i}.role: expected "user" or "lock"` }
      }
      const content = str(m.content)
      if (content === null || content.length < 1) {
        return { ok: false, message: `history.${i}.content: expected a non-empty string` }
      }
      if (content.length > MAX_CONTENT) {
        return { ok: false, message: `history.${i}.content: must be at most ${MAX_CONTENT} characters` }
      }
      history.push({ role, content })
    }
    value.history = history
  }

  return { ok: true, value }
}

/* ---- response validation ----------------------------------------------- */

/**
 * The model is never trusted. This is the same boundary the original backend
 * enforced with `LockDecisionResponseSchema.safeParse`, and nothing reaches a
 * caller without passing it.
 */
export function parseVerdict(raw: unknown): LockVerdictResponse {
  if (!raw || typeof raw !== 'object') {
    throw new InvalidVerdictOutput('the response was not an object')
  }
  const r = raw as Record<string, unknown>

  const verdict = str(r.verdict)
  if (!verdict || !(LOCK_VERDICTS as readonly string[]).includes(verdict)) {
    throw new InvalidVerdictOutput(`verdict: unexpected value ${JSON.stringify(r.verdict)}`)
  }

  const action = str(r.action)
  if (!action || !(LOCK_ACTIONS as readonly string[]).includes(action)) {
    throw new InvalidVerdictOutput(`action: unexpected value ${JSON.stringify(r.action)}`)
  }

  const reason = str(r.reason)?.trim()
  if (!reason) throw new InvalidVerdictOutput('reason: expected a non-empty string')

  const confidence = r.confidence
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    throw new InvalidVerdictOutput('confidence: expected a number')
  }
  if (confidence < 0 || confidence > 1) {
    throw new InvalidVerdictOutput('confidence: expected a number between 0 and 1')
  }

  const nullableString = (v: unknown, field: string, cap: number): string | null => {
    if (v === null || v === undefined) return null
    const s = str(v)
    if (s === null) throw new InvalidVerdictOutput(`${field}: expected a string or null`)
    const trimmed = s.trim()
    if (!trimmed) return null
    return trimmed.slice(0, cap)
  }

  return {
    verdict: verdict as LockVerdict,
    reason: reason.slice(0, MAX_REASON),
    action: action as LockAction,
    confidence,
    next_state: nullableString(r.next_state, 'next_state', MAX_ID),
    followup: nullableString(r.followup, 'followup', MAX_FOLLOWUP),
  }
}

/** Sent to the provider as a strict json_schema response format. */
export const VERDICT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reason', 'action', 'confidence', 'next_state', 'followup'],
  properties: {
    verdict: { type: 'string', enum: [...LOCK_VERDICTS] },
    reason: { type: 'string' },
    action: { type: 'string', enum: [...LOCK_ACTIONS] },
    // No minimum/maximum: strict structured outputs reject numeric range
    // keywords. The bounds are enforced by parseVerdict above instead.
    confidence: { type: 'number' },
    next_state: { type: ['string', 'null'] },
    followup: { type: ['string', 'null'] },
  },
} as const
